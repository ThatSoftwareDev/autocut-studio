"""Zeitachsen-Umrechnung: Original-Sequenz -> geschnittene Kopie.

Alle Werte in Frames (Ganzzahlen). Die Premiere-Schicht schließt Lücken nach
exakt derselben Regel: neue Position = alte Position - Summe aller davor
entfernten Bereiche.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class Piece:
    """Ein nach dem Schneiden verbleibendes Stück auf der Analysespur
    (entspricht einem Clip-Stück auf V1/A1 in der Kopie)."""

    orig_start: int  # Frames, Original-Zeitachse
    orig_end: int
    clip_index: int  # Index des Quell-Clips in der Clip-Liste
    new_start: int   # Frames, Zeitachse der Kopie

    @property
    def length(self) -> int:
        return self.orig_end - self.orig_start

    @property
    def new_end(self) -> int:
        return self.new_start + self.length


class CutMap:
    def __init__(self, cuts: Sequence[Tuple[int, int]]) -> None:
        ordered = sorted(cuts)
        for (a1, b1), (a2, b2) in zip(ordered, ordered[1:]):
            if a2 < b1:
                raise ValueError("Schnittbereiche überlappen sich.")
        self.cuts: List[Tuple[int, int]] = ordered
        self._ends = [b for _, b in ordered]
        self._starts = [a for a, _ in ordered]
        self._prefix = [0]
        for a, b in ordered:
            self._prefix.append(self._prefix[-1] + (b - a))

    def removed_before(self, frame: int) -> int:
        """Summe aller entfernten Frames, deren Bereich vor/an `frame` endet."""
        k = bisect.bisect_right(self._ends, frame)
        return self._prefix[k]

    def inside_cut(self, frame: int) -> bool:
        k = bisect.bisect_right(self._starts, frame) - 1
        return k >= 0 and self.cuts[k][0] <= frame < self.cuts[k][1]

    def to_new(self, frame: int) -> Optional[int]:
        """Original-Frame -> Frame in der Kopie (None, wenn weggeschnitten)."""
        if self.inside_cut(frame):
            return None
        return frame - self.removed_before(frame)

    def overlaps_cut(self, start: int, end: int) -> bool:
        k = bisect.bisect_right(self._starts, end - 1) - 1
        return k >= 0 and self.cuts[k][1] > start


def keep_pieces(clip_spans: Sequence[Tuple[int, int]], cut_map: CutMap) -> List[Piece]:
    """Clip-Spannen (Original-Frames) minus Schnittbereiche."""
    pieces: List[Piece] = []
    for ci, (cs, ce) in enumerate(clip_spans):
        pos = cs
        for a, b in cut_map.cuts:
            if b <= pos or a >= ce:
                continue
            if a > pos:
                pieces.append(Piece(pos, a, ci, pos - cut_map.removed_before(pos)))
            pos = max(pos, b)
        if pos < ce:
            pieces.append(Piece(pos, ce, ci, pos - cut_map.removed_before(pos)))
    return [p for p in pieces if p.length > 0]
