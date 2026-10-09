"""Reine Signal-Logik für die Stille-Erkennung (ohne I/O, gut testbar).

Zeit wird intern in Premiere-Ticks (Ganzzahlen) gerechnet, damit es beim
Umrechnen auf Frames keine Rundungsdrift gibt.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List, Sequence, Tuple

import numpy as np

TICKS_PER_SECOND = 254_016_000_000  # Premiere-Konstante
DB_FLOOR = -100.0


def ceil_div(a: int, b: int) -> int:
    return -((-a) // b)


def seconds_to_ticks(seconds: float) -> int:
    return int(round(seconds * TICKS_PER_SECOND))


def levels_db(chunks: Iterable[np.ndarray], window_samples: int) -> np.ndarray:
    """RMS-Pegel in dBFS pro Fenster fester Länge.

    Ein unvollständiges letztes Fenster wird verworfen (es wird also nie über
    das Ende der echten Audiodaten hinaus etwas behauptet).
    """
    levels: List[np.ndarray] = []
    rest = np.empty(0, dtype=np.int16)
    for chunk in chunks:
        data = np.concatenate([rest, chunk]) if rest.size else chunk
        n_full = data.size // window_samples
        if n_full:
            block = data[: n_full * window_samples].astype(np.float64) / 32768.0
            block = block.reshape(n_full, window_samples)
            rms = np.sqrt(np.mean(block * block, axis=1))
            with np.errstate(divide="ignore"):
                db = 20.0 * np.log10(rms)
            levels.append(np.maximum(db, DB_FLOOR).astype(np.float32))
        rest = data[n_full * window_samples :]
    if not levels:
        return np.empty(0, dtype=np.float32)
    return np.concatenate(levels)


def true_runs(mask: np.ndarray) -> List[Tuple[int, int]]:
    """[start, end)-Indexbereiche, in denen mask True ist."""
    if mask.size == 0:
        return []
    padded = np.concatenate([[False], mask.astype(bool), [False]])
    diff = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(diff == 1)
    ends = np.flatnonzero(diff == -1)
    return list(zip(starts.tolist(), ends.tolist()))


def silence_mask(db: np.ndarray, threshold_db: float, min_sound_windows: int) -> np.ndarray:
    """True = still. Sehr kurze Geräusch-Spitzen (Klick, Schmatzer) mitten in
    einer Pause zählen als still, damit die Pause nicht zerstückelt wird.
    Geräusche am Anfang/Ende des Clips bleiben unangetastet.
    """
    mask = db < threshold_db
    if min_sound_windows <= 0 or mask.size == 0:
        return mask
    sound_runs = true_runs(~mask)
    for start, end in sound_runs:
        surrounded = start > 0 and end < mask.size
        if surrounded and (end - start) < min_sound_windows:
            mask[start:end] = True
    return mask


@dataclass
class Interval:
    start_ticks: int
    end_ticks: int
    level_sum: float  # Summe der dB-Werte (für gewichteten Mittelwert)
    windows: int

    @property
    def duration_ticks(self) -> int:
        return self.end_ticks - self.start_ticks

    @property
    def mean_db(self) -> float:
        return self.level_sum / self.windows if self.windows else DB_FLOOR


def clip_silences(
    db: np.ndarray,
    clip_seq_start_ticks: int,
    window_ticks: int,
    threshold_db: float,
    min_sound_windows: int,
    hysteresis_db: float = 0.0,
) -> List[Interval]:
    """Stille-Intervalle eines Clips in Sequenz-Ticks.

    Ausklang-Schutz (hysteresis_db): Am Rand einer Pause zählen Fenster, die nur
    knapp unter dem Schwellwert liegen (>= Schwellwert - hysteresis_db), noch zur
    Sprache. So bleiben leise Wortenden („-t“, „-s“, auslaufende Silben) und
    leise Wortanfänge erhalten; die Pause beginnt erst, wenn es wirklich still ist.
    """
    mask = silence_mask(db, threshold_db, min_sound_windows)
    core_level = threshold_db - max(0.0, hysteresis_db)
    out: List[Interval] = []
    for start, end in true_runs(mask):
        if hysteresis_db > 0:
            while start < end and db[start] >= core_level:
                start += 1
            while end > start and db[end - 1] >= core_level:
                end -= 1
            if end <= start:
                continue
        out.append(
            Interval(
                start_ticks=clip_seq_start_ticks + start * window_ticks,
                end_ticks=clip_seq_start_ticks + end * window_ticks,
                level_sum=float(np.sum(db[start:end], dtype=np.float64)),
                windows=end - start,
            )
        )
    return out


def merge_touching(intervals: Sequence[Interval], tolerance_ticks: int) -> List[Interval]:
    """Fügt Intervalle zusammen, die sich berühren (z. B. Stille am Ende von
    Clip 1 + Stille am Anfang des direkt folgenden Clip 2)."""
    merged: List[Interval] = []
    for iv in sorted(intervals, key=lambda i: i.start_ticks):
        if merged and iv.start_ticks - merged[-1].end_ticks <= tolerance_ticks:
            last = merged[-1]
            last.end_ticks = max(last.end_ticks, iv.end_ticks)
            last.level_sum += iv.level_sum
            last.windows += iv.windows
        else:
            merged.append(Interval(iv.start_ticks, iv.end_ticks, iv.level_sum, iv.windows))
    return merged


@dataclass
class CutRange:
    start_frame: int
    end_frame: int  # exklusiv
    mean_db: float
    raw_start_ticks: int
    raw_end_ticks: int


def to_cut_ranges(
    silences: Sequence[Interval],
    ticks_per_frame: int,
    min_silence_ticks: int,
    padding_in_ticks: int,
    padding_out_ticks: int,
    min_cut_frames: int,
) -> List[CutRange]:
    """Mindestdauer prüfen, Padding abziehen und konservativ auf Frames runden.

    padding_out: Luft NACH dem letzten Wort vor der Pause (verschiebt den
                 Schnittanfang nach hinten).
    padding_in:  Luft VOR dem ersten Wort nach der Pause (verschiebt das
                 Schnittende nach vorne).
    Startpunkt wird AUFgerundet, Endpunkt ABgerundet – es wird also nie mehr
    geschnitten als tatsächlich gemessen still war."""
    cuts: List[CutRange] = []
    for iv in silences:
        if iv.duration_ticks < min_silence_ticks:
            continue
        start = iv.start_ticks + padding_out_ticks
        end = iv.end_ticks - padding_in_ticks
        if end <= start:
            continue
        start_frame = ceil_div(start, ticks_per_frame)
        end_frame = end // ticks_per_frame
        if end_frame - start_frame < min_cut_frames:
            continue
        cuts.append(CutRange(start_frame, end_frame, iv.mean_db, iv.start_ticks, iv.end_ticks))
    return cuts


def level_stats(all_db: np.ndarray) -> dict:
    """Grundrauschen / Sprachpegel aus den echten Messwerten, plus Vorschlag."""
    if all_db.size == 0:
        return {"noise_floor_db": None, "speech_level_db": None, "suggested_threshold_db": None,
                "separation_db": None}
    noise = float(np.percentile(all_db, 10))
    speech = float(np.percentile(all_db, 90))
    separation = speech - noise
    suggestion = noise + max(6.0, separation * 0.33)
    suggestion = float(min(-15.0, max(-70.0, round(suggestion))))
    return {
        "noise_floor_db": round(noise, 1),
        "speech_level_db": round(speech, 1),
        "suggested_threshold_db": suggestion,
        "separation_db": round(separation, 1),
    }
