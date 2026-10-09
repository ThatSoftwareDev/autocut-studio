"""Gesamtplan für die Kopie: verbleibende Stücke, Zooms, Swooshes, B-Roll.

Alles in Frames der geschnittenen Kopie. Grundlage sind ausschließlich echte
Messwerte (Pegel, Transkript, ffprobe) – nichts wird geschätzt.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

import numpy as np

from .analysis import (
    WINDOW_TICKS,
    RequestError,
    _float_field,
    _int_field,
    clip_levels,
    parse_clips,
    parse_tpf,
)
from .broll import BrollParams, TimedWord, find_ffprobe, cached_probe, index_folder, place_broll
from .ffmpeg_tools import FfmpegError
from .silence import TICKS_PER_SECOND, ceil_div
from .timeline import CutMap, keep_pieces
from .zoom import ZoomParams, find_peaks, plan_camera, plan_punch, plan_slow, smooth_db, swoosh_events

ZOOM_MODES = ("camera", "slow", "punch")


def _bool(obj: Dict[str, Any], key: str, default: bool) -> bool:
    v = obj.get(key, default)
    if not isinstance(v, bool):
        raise RequestError(f"Feld '{key}' muss true/false sein.")
    return v


def _sub(body: Dict[str, Any], key: str) -> Dict[str, Any]:
    v = body.get(key) or {}
    if not isinstance(v, dict):
        raise RequestError(f"Feld '{key}' muss ein Objekt sein.")
    return v


def build_plan(ffmpeg: str, body: Dict[str, Any], transcripts) -> Dict[str, Any]:
    if not isinstance(body, dict):
        raise RequestError("Anfrage muss ein JSON-Objekt sein.")
    tpf = parse_tpf(body)
    fps = TICKS_PER_SECOND / tpf
    sec = lambda s: int(round(s * fps))  # Sekunden -> Frames
    clips = parse_clips(body)
    threshold_db = _float_field(body, "threshold_db", -90.0, -5.0)

    raw_cuts = body.get("cuts")
    if not isinstance(raw_cuts, list):
        raise RequestError("Feld 'cuts' fehlt.")
    cuts = []
    for c in raw_cuts:
        a, b = _int_field(c, "start_frame"), _int_field(c, "end_frame")
        if b <= a:
            raise RequestError("Ungültiger Schnittbereich.")
        cuts.append((a, b))
    try:
        cut_map = CutMap(cuts)
    except ValueError as exc:
        raise RequestError(str(exc)) from None

    spans = [(ceil_div(c.seq_start_ticks, tpf), c.seq_end_ticks // tpf) for c in clips]
    pieces = keep_pieces(spans, cut_map)
    timeline_end = max((p.new_end for p in pieces), default=0)
    warnings: List[str] = []
    result: Dict[str, Any] = {
        "ticks_per_frame": tpf,
        "timeline": {
            "end_frame": timeline_end,
            "pieces": [{"new_start": p.new_start, "new_end": p.new_end, "orig_start": p.orig_start} for p in pieces],
        },
        "zoom": {"events": []},
        "swoosh": {"events": [], "duration_frames": 0},
        "broll": {"placements": [], "files": 0, "warnings": []},
        "warnings": warnings,
    }

    # ---------------- Zoom ----------------
    z = _sub(body, "zoom")
    zoom_events: List[Dict] = []
    if _bool(z, "enabled", False):
        mode = z.get("mode")
        if mode not in ZOOM_MODES:
            raise RequestError(f"Zoom-Modus muss einer von {ZOOM_MODES} sein.")
        zp = ZoomParams(
            mode=mode,
            strength_pct=_float_field(z, "strength_pct", 105.0, 125.0),
            ease=_bool(z, "ease", True),
            min_gap_frames=sec(_float_field(z, "min_gap_s", 0.0, 60.0)),
            slow_min_frames=sec(_float_field(z, "slow_min_segment_s", 0.5, 60.0)),
            punch_hold_frames=sec(_float_field(z, "punch_hold_s", 0.1, 10.0)),
            punch_ramp_frames=max(1, sec(_float_field(z, "punch_ramp_s", 0.04, 2.0))),
            punch_prominence_db=_float_field(z, "punch_prominence_db", 1.0, 20.0),
        )
        if mode == "camera":
            zoom_events = plan_camera(pieces, zp)
        elif mode == "slow":
            zoom_events = plan_slow(pieces, zp)
        else:
            levels = [clip_levels(ffmpeg, c) for c in clips]
            piece_levels = []
            for p in pieces:
                clip = clips[p.clip_index]
                w0 = max(0, (p.orig_start * tpf - clip.seq_start_ticks) // WINDOW_TICKS)
                w1 = max(w0, (p.orig_end * tpf - clip.seq_start_ticks) // WINDOW_TICKS)
                piece_levels.append(smooth_db(levels[p.clip_index][w0:w1], 15))
            frames_per_window = WINDOW_TICKS / tpf
            peaks = find_peaks(pieces, piece_levels, frames_per_window, threshold_db, zp)
            zoom_events = plan_punch(peaks, zp)
            if not peaks:
                warnings.append("Keine deutlichen Betonungen gefunden – „Betonung ab“ (dB) verringern.")
    result["zoom"]["events"] = zoom_events

    # ---------------- Swoosh ----------------
    s = _sub(body, "swoosh")
    if zoom_events and _bool(s, "enabled", False):
        path = s.get("path")
        if not isinstance(path, str) or not os.path.isfile(path):
            raise RequestError(f"Swoosh-Datei nicht gefunden: {path or '(nicht gesetzt)'}")
        ffprobe = find_ffprobe(ffmpeg)
        if not ffprobe:
            raise FfmpegError("ffprobe wurde nicht gefunden (gehört normalerweise zu ffmpeg).")
        dur, _w, _h, has_audio = cached_probe(ffprobe, path)
        if not has_audio or dur <= 0:
            raise RequestError("Die Swoosh-Datei enthält kein lesbares Audio.")
        dur_frames = max(1, int(np.ceil(dur * fps)))
        offset = sec(float(s.get("offset_ms", 0)) / 1000.0)
        result["swoosh"] = {"events": swoosh_events(zoom_events, dur_frames, offset),
                            "duration_frames": dur_frames, "duration_s": round(dur, 3)}

    # ---------------- B-Roll ----------------
    br = _sub(body, "broll")
    if _bool(br, "enabled", False):
        tid = br.get("transcript_id")
        transcript = transcripts.transcript(tid) if isinstance(tid, str) else None
        if transcript is None:
            raise RequestError("Kein Transkript vorhanden – bitte zuerst „Transkribieren“ ausführen.")
        files, idx_warnings = index_folder(ffmpeg, str(br.get("folder") or ""))
        result["broll"]["warnings"] = idx_warnings
        result["broll"]["files"] = len(files)
        words: List[TimedWord] = []
        for w in transcript["words"]:
            a = ceil_div(int(w["start_ticks"]), tpf)
            b = max(a + 1, int(w["end_ticks"]) // tpf)
            if cut_map.overlaps_cut(a, b):
                continue  # Wort (teilweise) weggeschnitten
            na = cut_map.to_new(a)
            if na is None:
                continue
            words.append(TimedWord(na, na + (b - a), str(w["text"]), int(w["segment"])))
        bp = BrollParams(
            clip_frames=sec(_float_field(br, "clip_length_s", 0.5, 30.0)),
            min_frames=sec(1.0),
            min_gap_frames=sec(_float_field(br, "min_gap_s", 0.0, 120.0)),
            lead_frames=sec(_float_field(br, "lead_s", 0.0, 3.0)),
            reuse=_bool(br, "reuse", False),
            timeline_end=timeline_end,
            fps=fps,
        )
        result["broll"]["placements"] = place_broll(words, files, bp)
        if files and not result["broll"]["placements"]:
            warnings.append("Keines der Schlagwörter aus dem B-Roll-Ordner kommt im Gesprochenen vor.")
    return result


def scan_broll(ffmpeg: str, body: Dict[str, Any]) -> Dict[str, Any]:
    files, warnings = index_folder(ffmpeg, str((body or {}).get("folder") or ""))
    return {
        "files": [{"file": f.rel, "keywords": f.keywords, "is_image": f.is_image,
                   "duration_s": None if f.is_image else round(f.duration_s, 2),
                   "width": f.width, "height": f.height} for f in files],
        "warnings": warnings,
    }
