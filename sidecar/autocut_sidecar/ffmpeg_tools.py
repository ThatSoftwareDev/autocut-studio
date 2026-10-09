"""ffmpeg finden und Audio als PCM-Stream lesen – ohne Zwischendateien."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterator, Optional

import numpy as np

# Unter Windows kein Konsolenfenster pro ffmpeg-Aufruf aufpoppen lassen.
_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


class FfmpegError(RuntimeError):
    """ffmpeg fehlt oder ist mit einem Fehler abgebrochen."""


def find_ffmpeg() -> Optional[str]:
    """Reihenfolge: Umgebungsvariable AUTOCUT_FFMPEG -> sidecar/bin -> PATH."""
    env = os.environ.get("AUTOCUT_FFMPEG")
    if env and Path(env).is_file():
        return env
    local_bin = Path(__file__).resolve().parent.parent / "bin"
    for name in ("ffmpeg.exe", "ffmpeg"):
        candidate = local_bin / name
        if candidate.is_file():
            return str(candidate)
    return shutil.which("ffmpeg")


def ffmpeg_version(ffmpeg: str) -> str:
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=_CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise FfmpegError(f"ffmpeg ließ sich nicht starten: {exc}") from exc
    first_line = (out.stdout or "").splitlines()[:1]
    return first_line[0] if first_line else "unbekannt"


def stream_pcm(
    ffmpeg: str,
    media_path: str,
    start_s: float,
    duration_s: float,
    sample_rate: int,
    chunk_samples: int,
) -> Iterator[np.ndarray]:
    """Liefert Mono-int16-Blöcke des Audio-Ausschnitts [start_s, start_s+duration_s).

    Es wird nur der erste Audiostream gelesen und auf Mono heruntergemischt.
    """
    if not Path(media_path).is_file():
        raise FfmpegError(f"Mediendatei nicht gefunden: {media_path}")

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-ss", f"{max(0.0, start_s):.6f}",
        "-t", f"{max(0.0, duration_s):.6f}",
        "-i", media_path,
        "-map", "0:a:0",
        "-vn", "-sn", "-dn",
        "-ac", "1",
        "-ar", str(sample_rate),
        "-f", "s16le",
        "-acodec", "pcm_s16le",
        "pipe:1",
    ]
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=_CREATE_NO_WINDOW,
        )
    except OSError as exc:
        raise FfmpegError(f"ffmpeg ließ sich nicht starten: {exc}") from exc

    bytes_per_chunk = chunk_samples * 2
    leftover = b""
    assert proc.stdout is not None
    try:
        while True:
            data = proc.stdout.read(bytes_per_chunk)
            if not data:
                break
            data = leftover + data
            usable = len(data) - (len(data) % 2)
            leftover = data[usable:]
            if usable:
                yield np.frombuffer(data[:usable], dtype="<i2")
    finally:
        proc.stdout.close()
        stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        if proc.stderr:
            proc.stderr.close()
        code = proc.wait()
    if code != 0:
        tail = stderr.strip().splitlines()[-3:]
        hint = " | ".join(tail) if tail else f"Exit-Code {code}"
        if "matches no streams" in stderr or "Stream map" in stderr:
            hint = "Die Datei enthält keinen Audiostream."
        raise FfmpegError(f"ffmpeg-Fehler bei {Path(media_path).name}: {hint}")
