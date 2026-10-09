"""Stille-Analyse über die Clips einer Spur – vom Panel aufgerufen."""

from __future__ import annotations

import os
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

import numpy as np

from .ffmpeg_tools import FfmpegError, stream_pcm
from .silence import (
    TICKS_PER_SECOND,
    Interval,
    clip_silences,
    level_stats,
    levels_db,
    merge_touching,
    seconds_to_ticks,
    to_cut_ranges,
)

SAMPLE_RATE = 48_000          # volle Sprachbandbreite, damit leise S-Laute nicht als Stille gelten
WINDOW_SECONDS = 0.01         # 10-ms-Messfenster
WINDOW_SAMPLES = int(SAMPLE_RATE * WINDOW_SECONDS)
WINDOW_TICKS = seconds_to_ticks(WINDOW_SECONDS)
MIN_SOUND_SECONDS = 0.06      # kürzere Geräusch-Spitzen innerhalb einer Pause ignorieren
MIN_CUT_FRAMES = 2            # kürzere Schnitte lohnen nicht / wirken wie Fehler
DEFAULT_HYSTERESIS_DB = 6.0   # Ausklang-Schutz


class RequestError(ValueError):
    """Ungültige Anfrage vom Panel."""


@dataclass(frozen=True)
class ClipSpec:
    clip_id: str
    name: str
    media_path: str
    seq_start_ticks: int
    seq_end_ticks: int
    source_in_ticks: int


class LevelCache:
    """Merkt sich Pegelkurven, damit ein erneutes Analysieren mit anderem
    Schwellwert sofort geht (ffmpeg läuft pro Clip nur einmal)."""

    def __init__(self, max_entries: int = 64) -> None:
        self._data: "OrderedDict[Tuple, np.ndarray]" = OrderedDict()
        self._max = max_entries
        self._lock = threading.Lock()

    def get_or_compute(self, key: Tuple, compute) -> np.ndarray:
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                return self._data[key]
        value = compute()
        with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self._max:
                self._data.popitem(last=False)
        return value


_cache = LevelCache()


def _int_field(obj: Dict[str, Any], key: str) -> int:
    value = obj.get(key)
    try:
        return int(str(value))
    except (TypeError, ValueError):
        raise RequestError(f"Feld '{key}' fehlt oder ist keine Ganzzahl.") from None


def _float_field(obj: Dict[str, Any], key: str, lo: float, hi: float) -> float:
    value = obj.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise RequestError(f"Feld '{key}' fehlt oder ist keine Zahl.")
    if not (lo <= float(value) <= hi):
        raise RequestError(f"Feld '{key}' muss zwischen {lo} und {hi} liegen (ist {value}).")
    return float(value)


def _opt_float(obj: Dict[str, Any], key: str, default: float, lo: float, hi: float) -> float:
    if key not in obj or obj.get(key) is None:
        return default
    return _float_field(obj, key, lo, hi)


def parse_clips(body: Dict[str, Any]) -> List[ClipSpec]:
    """Clip-Liste der Analysespur (gemeinsam für Stille, Plan und Transkription)."""
    raw_clips = body.get("clips")
    if not isinstance(raw_clips, list) or not raw_clips:
        raise RequestError("Keine Clips übergeben – ist auf der gewählten Audiospur etwas?")
    clips: List[ClipSpec] = []
    for i, c in enumerate(raw_clips):
        if not isinstance(c, dict):
            raise RequestError(f"Clip {i} ist ungültig.")
        path = c.get("media_path")
        if not isinstance(path, str) or not path:
            raise RequestError(f"Clip {i} hat keinen Mediapfad.")
        spec = ClipSpec(
            clip_id=str(c.get("clip_id", i)),
            name=str(c.get("name", os.path.basename(path))),
            media_path=path,
            seq_start_ticks=_int_field(c, "seq_start_ticks"),
            seq_end_ticks=_int_field(c, "seq_end_ticks"),
            source_in_ticks=_int_field(c, "source_in_ticks"),
        )
        if spec.seq_end_ticks <= spec.seq_start_ticks:
            raise RequestError(f"Clip '{spec.name}' hat keine positive Länge.")
        if spec.source_in_ticks < 0:
            raise RequestError(f"Clip '{spec.name}' hat einen negativen In-Punkt.")
        clips.append(spec)
    clips.sort(key=lambda c: c.seq_start_ticks)
    for a, b in zip(clips, clips[1:]):
        if b.seq_start_ticks < a.seq_end_ticks:
            raise RequestError(f"Clips '{a.name}' und '{b.name}' überlappen sich auf der Analysespur.")
    return clips


def parse_tpf(body: Dict[str, Any]) -> int:
    tpf = _int_field(body, "ticks_per_frame")
    if tpf <= 0:
        raise RequestError("ticks_per_frame muss positiv sein.")
    return tpf


def parse_request(body: Dict[str, Any]) -> Tuple[List[ClipSpec], Dict[str, Any]]:
    if not isinstance(body, dict):
        raise RequestError("Anfrage muss ein JSON-Objekt sein.")
    legacy_pad = _opt_float(body, "padding_s", 0.1, 0.0, 2.0)
    params = {
        "ticks_per_frame": parse_tpf(body),
        "threshold_db": _float_field(body, "threshold_db", -90.0, -5.0),
        "padding_in_s": _opt_float(body, "padding_in_s", legacy_pad, 0.0, 2.0),
        "padding_out_s": _opt_float(body, "padding_out_s", legacy_pad, 0.0, 2.0),
        "min_silence_s": _float_field(body, "min_silence_s", 0.05, 10.0),
        "hysteresis_db": _opt_float(body, "hysteresis_db", DEFAULT_HYSTERESIS_DB, 0.0, 20.0),
    }
    return parse_clips(body), params


def clip_levels(ffmpeg: str, clip: ClipSpec) -> np.ndarray:
    try:
        st = os.stat(clip.media_path)
    except OSError:
        raise FfmpegError(f"Mediendatei nicht gefunden: {clip.media_path}") from None
    duration_ticks = clip.seq_end_ticks - clip.seq_start_ticks
    key = (
        os.path.normcase(os.path.abspath(clip.media_path)),
        st.st_mtime_ns,
        st.st_size,
        clip.source_in_ticks,
        duration_ticks,
        SAMPLE_RATE,
        WINDOW_SAMPLES,
    )

    def compute() -> np.ndarray:
        chunks = stream_pcm(
            ffmpeg,
            clip.media_path,
            start_s=clip.source_in_ticks / TICKS_PER_SECOND,
            duration_s=duration_ticks / TICKS_PER_SECOND,
            sample_rate=SAMPLE_RATE,
            chunk_samples=WINDOW_SAMPLES * 500,
        )
        return levels_db(chunks, WINDOW_SAMPLES)

    return _cache.get_or_compute(key, compute)


def analyze_silence(ffmpeg: str, body: Dict[str, Any]) -> Dict[str, Any]:
    clips, p = parse_request(body)
    tpf = p["ticks_per_frame"]
    min_sound_windows = int(round(MIN_SOUND_SECONDS / WINDOW_SECONDS))

    all_silences: List[Interval] = []
    all_levels: List[np.ndarray] = []
    clip_reports = []
    warnings: List[str] = []
    analyzed_ticks = 0

    for clip in clips:
        db = clip_levels(ffmpeg, clip)
        expected_windows = (clip.seq_end_ticks - clip.seq_start_ticks) // WINDOW_TICKS
        covered = db.size / expected_windows if expected_windows else 1.0
        if db.size == 0:
            warnings.append(f"„{clip.name}“: kein Audio gelesen – Clip wird nicht geschnitten.")
        elif covered < 0.98:
            warnings.append(
                f"„{clip.name}“: Audio endet früher als der Clip ({covered:.0%} abgedeckt) – "
                "der Rest wird nicht geschnitten."
            )
        analyzed_ticks += db.size * WINDOW_TICKS
        all_levels.append(db)
        all_silences.extend(
            clip_silences(db, clip.seq_start_ticks, WINDOW_TICKS, p["threshold_db"], min_sound_windows,
                          hysteresis_db=p["hysteresis_db"])
        )
        clip_reports.append({"clip_id": clip.clip_id, "name": clip.name, "windows": int(db.size)})

    merged = merge_touching(all_silences, tolerance_ticks=tpf // 2)
    cuts = to_cut_ranges(
        merged,
        ticks_per_frame=tpf,
        min_silence_ticks=seconds_to_ticks(p["min_silence_s"]),
        padding_in_ticks=seconds_to_ticks(p["padding_in_s"]),
        padding_out_ticks=seconds_to_ticks(p["padding_out_s"]),
        min_cut_frames=MIN_CUT_FRAMES,
    )

    stats = level_stats(np.concatenate(all_levels) if all_levels else np.empty(0, np.float32))
    if stats["separation_db"] is not None and stats["separation_db"] < 10:
        warnings.append(
            "Sprache und Grundrauschen liegen nur "
            f"{stats['separation_db']} dB auseinander – die Erkennung ist unsicher. "
            "Lieber vorsichtig (niedriger Schwellwert) arbeiten."
        )

    removed_frames = sum(c.end_frame - c.start_frame for c in cuts)
    seconds_per_frame = tpf / TICKS_PER_SECOND
    return {
        "ticks_per_frame": tpf,
        "cuts": [
            {
                "index": i,
                "start_frame": c.start_frame,
                "end_frame": c.end_frame,
                "start_s": round(c.start_frame * seconds_per_frame, 3),
                "end_s": round(c.end_frame * seconds_per_frame, 3),
                "duration_s": round((c.end_frame - c.start_frame) * seconds_per_frame, 3),
                "mean_db": round(c.mean_db, 1),
            }
            for i, c in enumerate(cuts)
        ],
        "summary": {
            "cut_count": len(cuts),
            "removed_s": round(removed_frames * seconds_per_frame, 2),
            "analyzed_s": round(analyzed_ticks / TICKS_PER_SECOND, 2),
        },
        "levels": stats,
        "clips": clip_reports,
        "warnings": warnings,
        "params_used": {**p, "min_sound_s": MIN_SOUND_SECONDS, "window_s": WINDOW_SECONDS,
                        "min_cut_frames": MIN_CUT_FRAMES},
    }
