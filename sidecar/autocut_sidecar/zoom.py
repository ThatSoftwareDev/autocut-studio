"""Zoom-Planung für die geschnittene Kopie (reine Logik, ohne I/O).

Modi
  camera  Kamera-Wechsel: Clip-Stücke abwechselnd 100 % / Zoom-Stärke
          (umgeschaltet wird frühestens nach dem Mindestabstand).
  slow    Slow Zoom: innerhalb jedes Sprechabschnitts langsam von 100 % auf
          die Zoom-Stärke.
  punch   Punch bei Betonung: an lauten Betonungen (Energie-Spitzen, keine KI)
          kurzer Zoom rein, halten, wieder raus.

Ausgabe in Frames der Kopie. Keyframes bleiben immer innerhalb eines
Clip-Stücks, weil Premiere Keyframes pro Clip speichert.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

import numpy as np

from .timeline import Piece


@dataclass
class ZoomParams:
    mode: str              # "camera" | "slow" | "punch"
    strength_pct: float    # 105..125
    ease: bool
    min_gap_frames: int
    slow_min_frames: int
    punch_hold_frames: int
    punch_ramp_frames: int
    punch_prominence_db: float


def _event(piece: Piece, kind: str, **kw) -> Dict:
    ev = {"kind": kind, "piece_new_start": piece.new_start, "piece_new_end": piece.new_end}
    ev.update(kw)
    return ev


def plan_camera(pieces: Sequence[Piece], p: ZoomParams) -> List[Dict]:
    events: List[Dict] = []
    zoomed = True  # erstes Stück schaltet auf 100 %, das zweite auf Zoom usw.
    last_switch = -10**12
    for piece in pieces:
        if piece.new_start - last_switch >= p.min_gap_frames:
            zoomed = not zoomed
            last_switch = piece.new_start
            switched_in = zoomed
        else:
            switched_in = False
        if zoomed:
            events.append(
                _event(piece, "static", scale_pct=p.strength_pct,
                       swoosh_frame=piece.new_start if switched_in else None,
                       label=f"Kamera-Wechsel auf {p.strength_pct:g} %")
            )
    return events


def plan_slow(pieces: Sequence[Piece], p: ZoomParams) -> List[Dict]:
    events: List[Dict] = []
    for piece in pieces:
        if piece.length < p.slow_min_frames:
            continue
        keys = [
            {"frame": piece.new_start, "pct": 100.0},
            {"frame": piece.new_end - 1, "pct": p.strength_pct},
        ]
        events.append(_event(piece, "keys", keys=keys, ease=p.ease, swoosh_frame=piece.new_start,
                             label=f"Slow Zoom 100 → {p.strength_pct:g} %"))
    return events


def smooth_db(db: np.ndarray, windows: int) -> np.ndarray:
    """Gleitender Mittelwert über die Leistung (nicht über dB)."""
    if db.size == 0 or windows <= 1:
        return db.astype(np.float64)
    power = np.power(10.0, db.astype(np.float64) / 10.0)
    kernel = np.ones(windows) / windows
    smoothed = np.convolve(power, kernel, mode="same")
    return 10.0 * np.log10(np.maximum(smoothed, 1e-12))


@dataclass
class Peak:
    piece: Piece
    frame: int      # Frame der Kopie
    level_db: float
    prominence_db: float


def find_peaks(
    pieces: Sequence[Piece],
    piece_levels: Sequence[np.ndarray],  # geglättete dB-Kurve je Stück (10-ms-Fenster)
    frames_per_window: float,
    threshold_db: float,
    p: ZoomParams,
) -> List[Peak]:
    """Betonungen = lokale Lautheits-Maxima deutlich über dem typischen Sprachpegel."""
    speech = np.concatenate([lv[lv > threshold_db] for lv in piece_levels if lv.size]) if piece_levels else np.empty(0)
    if speech.size < 50:
        return []
    baseline = float(np.median(speech))
    candidates: List[Peak] = []
    neighborhood = 15  # ±150 ms
    for piece, lv in zip(pieces, piece_levels):
        n = lv.size
        for i in range(n):
            v = lv[i]
            if v < baseline + p.punch_prominence_db:
                continue
            lo, hi = max(0, i - neighborhood), min(n, i + neighborhood + 1)
            if v < lv[lo:hi].max():
                continue
            frame = piece.new_start + int(i * frames_per_window)
            if frame >= piece.new_end:
                continue
            candidates.append(Peak(piece, frame, float(v), float(v - baseline)))
    # Stärkste zuerst, dann Mindestabstand erzwingen (über die ganze Zeitachse)
    candidates.sort(key=lambda c: -c.level_db)
    chosen: List[Peak] = []
    for c in candidates:
        if all(abs(c.frame - s.frame) >= p.min_gap_frames for s in chosen):
            chosen.append(c)
    chosen.sort(key=lambda c: c.frame)
    return chosen


def plan_punch(peaks: Sequence[Peak], p: ZoomParams) -> List[Dict]:
    events: List[Dict] = []
    for pk in peaks:
        first, last = pk.piece.new_start, pk.piece.new_end - 1
        t0 = max(first, pk.frame - p.punch_ramp_frames)
        t1 = max(t0 + 1, pk.frame)
        if t1 > last:
            continue
        t2 = min(last, t1 + p.punch_hold_frames)
        keys = [{"frame": t0, "pct": 100.0}, {"frame": t1, "pct": p.strength_pct}]
        if t2 > t1:
            keys.append({"frame": t2, "pct": p.strength_pct})
        t3 = t2 + p.punch_ramp_frames
        if t2 < last and t3 <= last:
            keys.append({"frame": t3, "pct": 100.0})
        # Endet der Zoom am Stück-Ende, setzt der nächste Schnitt ohnehin auf 100 % zurück.
        events.append(_event(pk.piece, "keys", keys=keys, ease=p.ease, swoosh_frame=t0,
                             label=f"Punch {p.strength_pct:g} % (+{pk.prominence_db:.1f} dB)"))
    return events


def swoosh_events(zoom_events: Sequence[Dict], swoosh_frames: int, offset_frames: int) -> List[Dict]:
    """Swoosh-Startpunkte; überlappende Swooshes werden weggelassen."""
    out: List[Dict] = []
    last_end: Optional[int] = None
    for ev in zoom_events:
        f = ev.get("swoosh_frame")
        if f is None:
            continue
        start = max(0, f + offset_frames)
        if last_end is not None and start < last_end:
            continue
        out.append({"frame": start})
        last_end = start + swoosh_frames
    return out
