"""faster-whisper auf der CPU (CTranslate2 unterstützt keine AMD-GPU).

Modell wird EINMALIG mit `download-model.bat` in sidecar/models geladen.
Danach läuft alles offline: HF_HUB_OFFLINE ist gesetzt und das Modell wird nur
aus dem lokalen Ordner geladen.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, List

import numpy as np

from .base import Segment, TranscriptionError, Word

MODELS_DIR = Path(__file__).resolve().parents[2] / "models"
VALID_MODELS = ("tiny", "base", "small", "medium")


def model_dir(size: str) -> Path:
    return MODELS_DIR / f"faster-whisper-{size}"


def model_available(size: str) -> bool:
    d = model_dir(size)
    return (d / "model.bin").is_file() and (d / "config.json").is_file()


def download_model(size: str) -> Path:
    """Einziger Netzwerkzugriff des Helfers: Modellgewichte herunterladen."""
    if size not in VALID_MODELS:
        raise TranscriptionError(f"Unbekannte Modellgröße: {size}")
    os.environ.pop("HF_HUB_OFFLINE", None)
    try:
        from faster_whisper.utils import download_model as _dl
    except ImportError as exc:
        raise TranscriptionError("faster-whisper ist nicht installiert (setup.bat ausführen).") from exc
    target = model_dir(size)
    target.mkdir(parents=True, exist_ok=True)
    _dl(size, output_dir=str(target))
    return target


class FasterWhisperEngine:
    name = "faster-whisper"

    def __init__(self, size: str = "small", cpu_threads: int = 0) -> None:
        if size not in VALID_MODELS:
            raise TranscriptionError(f"Unbekannte Modellgröße: {size}")
        if not model_available(size):
            raise TranscriptionError(
                f"Whisper-Modell „{size}“ ist noch nicht heruntergeladen. "
                f"Führe einmalig sidecar\\download-model.bat {size} aus."
            )
        os.environ["HF_HUB_OFFLINE"] = "1"  # niemals während der Arbeit ins Netz
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise TranscriptionError("faster-whisper ist nicht installiert (setup.bat ausführen).") from exc
        threads = cpu_threads or max(1, (os.cpu_count() or 4) // 2)  # Ryzen 5 5600: 6 Kerne
        self.size = size
        self._model = WhisperModel(
            str(model_dir(size)),
            device="cpu",
            compute_type="int8",
            cpu_threads=threads,
            local_files_only=True,
        )

    def transcribe(self, audio: np.ndarray, language: str, progress: Callable[[float], None]) -> List[Segment]:
        total = max(1e-6, audio.size / 16_000)
        segments_iter, _info = self._model.transcribe(
            audio.astype(np.float32),
            language=language or None,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
            condition_on_previous_text=False,  # verhindert Wiederholungs-Schleifen
        )
        out: List[Segment] = []
        for seg in segments_iter:
            words = [
                Word(float(w.start), float(w.end), w.word.strip(), float(w.probability))
                for w in (seg.words or [])
                if w.word.strip()
            ]
            out.append(Segment(float(seg.start), float(seg.end), seg.text.strip(), words))
            progress(min(1.0, float(seg.end) / total))
        progress(1.0)
        return out
