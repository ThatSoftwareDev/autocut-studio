"""Platzhalter für whisper.cpp mit Vulkan-Backend (GPU-Tempo auf der RX 6600 XT).

Noch nicht aktiv. Wenn du GPU-Tempo brauchst, wird hier `whisper-cli`
(whisper.cpp, mit -DGGML_VULKAN=1 gebaut) per Unterprozess aufgerufen, das
Audio als 16-kHz-WAV übergeben und die JSON-Ausgabe mit Wort-Zeitstempeln in
`Segment`/`Word` übersetzt. Der Rest des Helfers bleibt unverändert, weil er nur
die Schnittstelle aus base.py kennt. Umschalten dann über die Umgebungsvariable
AUTOCUT_ENGINE=whisper.cpp.
"""

from __future__ import annotations

from typing import Callable, List

import numpy as np

from .base import Segment, TranscriptionError


class WhisperCppEngine:
    name = "whisper.cpp"

    def __init__(self, size: str = "small") -> None:
        raise TranscriptionError(
            "whisper.cpp ist noch nicht eingebunden. Bitte AUTOCUT_ENGINE nicht setzen "
            "(Standard: faster-whisper auf der CPU)."
        )

    def transcribe(self, audio: np.ndarray, language: str, progress: Callable[[float], None]) -> List[Segment]:
        raise NotImplementedError
