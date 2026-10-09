"""Start:
  python -m autocut_sidecar [--port 47821]          Helfer starten (offline)
  python -m autocut_sidecar download-model small    Whisper-Modell einmalig laden
"""

from __future__ import annotations

import argparse
import logging
import os
import sys

DEFAULT_PORT = 47821


def _download(size: str) -> int:
    from .transcription.base import TranscriptionError
    from .transcription.faster_whisper_engine import download_model

    print(f"Lade Whisper-Modell „{size}“ herunter (nur die Modelldatei, keine Medien) …")
    try:
        path = download_model(size)
    except TranscriptionError as exc:
        print(exc, file=sys.stderr)
        return 1
    except Exception as exc:  # Netzwerkfehler o. Ä.
        print(f"Download fehlgeschlagen: {exc}", file=sys.stderr)
        return 1
    print(f"Fertig: {path}")
    return 0


def _serve(port: int, verbose: bool) -> int:
    os.environ["HF_HUB_OFFLINE"] = "1"  # während der Arbeit niemals ins Netz
    from . import __version__
    from .ffmpeg_tools import find_ffmpeg
    from .server import make_server
    from .transcription.faster_whisper_engine import VALID_MODELS, model_available

    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        httpd = make_server(port)
    except OSError as exc:
        print(f"Port {port} ist belegt oder nicht nutzbar ({exc}). "
              "Läuft der Helfer schon in einem anderen Fenster?", file=sys.stderr)
        return 1

    ffmpeg = find_ffmpeg()
    models = [m for m in VALID_MODELS if model_available(m)]
    print(f"AutoCut-Helfer {__version__} läuft auf http://127.0.0.1:{port} (nur lokal).")
    print(f"ffmpeg: {ffmpeg or 'NICHT GEFUNDEN – Analyse wird fehlschlagen, siehe README'}")
    print(f"Whisper-Modelle: {', '.join(models) if models else 'keins – für B-Roll download-model.bat ausführen'}")
    print("Fenster offen lassen, solange du das Panel nutzt. Beenden mit Strg+C.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nHelfer beendet.")
    finally:
        httpd.server_close()
    return 0


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "download-model":
        size = sys.argv[2] if len(sys.argv) >= 3 else "small"
        return _download(size)
    parser = argparse.ArgumentParser(description="AutoCut Studio – lokaler Analyse-Helfer")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    return _serve(args.port, args.verbose)


if __name__ == "__main__":
    sys.exit(main())
