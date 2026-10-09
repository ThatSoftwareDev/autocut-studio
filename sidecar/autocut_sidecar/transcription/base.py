"""Austauschbare Transkriptions-Schnittstelle.

Jeder Motor (faster-whisper auf der CPU, später whisper.cpp mit Vulkan auf der
AMD-GPU) bekommt Mono-Audio als float32 bei 16 kHz und liefert Wörter mit
Zeitstempeln in Sekunden relativ zum Anfang dieses Audios. Der Rest des Helfers
kennt nur diese Schnittstelle.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List, Protocol

import numpy as np

SAMPLE_RATE = 16_000


class TranscriptionError(RuntimeError):
    """Modell fehlt, Motor nicht installiert oder Transkription fehlgeschlagen."""


@dataclass
class Word:
    start: float
    end: float
    text: str
    probability: float


@dataclass
class Segment:
    start: float
    end: float
    text: str
    words: List[Word] = field(default_factory=list)


class Engine(Protocol):
    name: str

    def transcribe(
        self,
        audio: np.ndarray,
        language: str,
        progress: Callable[[float], None],
    ) -> List[Segment]:
        """audio: float32 mono, 16 kHz, Werte in [-1, 1]. progress: 0..1"""
        ...
