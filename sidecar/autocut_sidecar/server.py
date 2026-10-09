"""Minimaler HTTP-Server – ausschließlich auf 127.0.0.1.

Endpunkte
  GET  /health            -> Status, Version, ffmpeg verfügbar?, Whisper-Modelle
  POST /silence/analyze   -> Stille-Vorschläge für die Clips einer Spur
  POST /plan              -> Stücke, Zooms, Swooshes, B-Roll für die geschnittene Kopie
  POST /broll/scan        -> Inhalt + Schlagwörter des B-Roll-Ordners
  POST /transcribe/start  -> startet lokale Transkription (Job-ID)
  GET  /jobs/<id>         -> Fortschritt / Ergebnis eines Jobs

Schutz gegen Zugriffe aus normalen Webseiten im Browser:
  * nur Loopback-Bind, Host-Header muss localhost/127.0.0.1 sein (DNS-Rebinding)
  * Origin muss fehlen, "null"/"file://" (CEP-Panel) oder localhost sein
  * POST nur mit Content-Type application/json (erzwingt CORS-Preflight)
"""

from __future__ import annotations

import json
import logging
import re
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

from . import __version__
from .analysis import RequestError, analyze_silence, parse_clips
from .ffmpeg_tools import FfmpegError, find_ffmpeg, ffmpeg_version
from .plan import build_plan, scan_broll
from .transcription.base import TranscriptionError
from .transcription.faster_whisper_engine import VALID_MODELS, model_available
from .transcription.service import TranscriptionService

SERVICE = TranscriptionService()

log = logging.getLogger("autocut")

MAX_BODY_BYTES = 5 * 1024 * 1024
_LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")
_LOCAL_HOST = re.compile(r"^(localhost|127\.0\.0\.1)(:\d+)?$")


def origin_allowed(origin: Optional[str]) -> bool:
    if origin is None or origin in ("null", "file://"):
        return True
    return bool(_LOCAL_ORIGIN.match(origin))


class Handler(BaseHTTPRequestHandler):
    server_version = f"AutoCutSidecar/{__version__}"

    # --- Hilfsfunktionen -------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:  # leiser loggen
        log.info("%s - %s", self.address_string(), fmt % args)

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")

    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, code: str, message: str) -> None:
        self._send_json(status, {"ok": False, "error": {"code": code, "message": message}})

    def _guard(self) -> bool:
        host = self.headers.get("Host", "")
        if not _LOCAL_HOST.match(host):
            self._error(403, "forbidden_host", "Nur lokale Zugriffe erlaubt.")
            return False
        if not origin_allowed(self.headers.get("Origin")):
            self._error(403, "forbidden_origin", "Zugriff von dieser Herkunft nicht erlaubt.")
            return False
        return True

    def _read_json(self) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        ctype = self.headers.get("Content-Type", "")
        if not ctype.lower().startswith("application/json"):
            return None, "Content-Type muss application/json sein."
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None, "Ungültige Content-Length."
        if length <= 0 or length > MAX_BODY_BYTES:
            return None, "Anfrage leer oder zu groß."
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8")), None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, "Anfrage ist kein gültiges JSON."

    # --- Routen ----------------------------------------------------------
    def do_OPTIONS(self) -> None:  # CORS-Preflight
        if not self._guard():
            return
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if not self._guard():
            return
        if self.path == "/health":
            ffmpeg = find_ffmpeg()
            info: Dict[str, Any] = {"ok": True, "version": __version__, "ffmpeg": None,
                                    "whisper_models": [m for m in VALID_MODELS if model_available(m)]}
            if ffmpeg:
                try:
                    info["ffmpeg"] = {"path": ffmpeg, "version": ffmpeg_version(ffmpeg)}
                except FfmpegError as exc:
                    info["ffmpeg_error"] = str(exc)
            self._send_json(200, info)
            return
        if self.path.startswith("/jobs/"):
            job = SERVICE.job(self.path[len("/jobs/"):])
            if not job:
                self._error(404, "job_unknown", "Job unbekannt – wurde der Helfer neu gestartet?")
                return
            self._send_json(200, {"ok": True, **job})
            return
        self._error(404, "not_found", f"Unbekannter Pfad: {self.path}")

    def do_POST(self) -> None:
        if not self._guard():
            return
        body, err = self._read_json()
        if err:
            self._error(400, "bad_request", err)
            return
        routes = {
            "/silence/analyze": lambda ff: analyze_silence(ff, body),  # type: ignore[arg-type]
            "/plan": lambda ff: build_plan(ff, body, SERVICE),  # type: ignore[arg-type]
            "/broll/scan": lambda ff: scan_broll(ff, body),  # type: ignore[arg-type]
            "/transcribe/start": lambda ff: self._start_transcription(ff, body),  # type: ignore[arg-type]
        }
        handler = routes.get(self.path)
        if handler is None:
            self._error(404, "not_found", f"Unbekannter Pfad: {self.path}")
            return
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            self._error(
                503,
                "ffmpeg_missing",
                "ffmpeg wurde nicht gefunden. Installiere es (z. B. 'winget install Gyan.FFmpeg') "
                "oder lege ffmpeg.exe in den Ordner sidecar/bin und starte den Helfer neu.",
            )
            return
        try:
            result = handler(ffmpeg)
        except RequestError as exc:
            self._error(400, "bad_request", str(exc))
            return
        except (FfmpegError, TranscriptionError) as exc:
            self._error(422, "processing_failed", str(exc))
            return
        except Exception:  # pragma: no cover - unerwartet, aber sauber melden
            log.error("Unerwarteter Fehler:\n%s", traceback.format_exc())
            self._error(500, "internal", "Unerwarteter Fehler im Helfer – Details im Helfer-Fenster.")
            return
        self._send_json(200, {"ok": True, **result})

    def _start_transcription(self, ffmpeg: str, body: Dict[str, Any]) -> Dict[str, Any]:
        clips = parse_clips(body)
        model = body.get("model", "small")
        if model not in VALID_MODELS:
            raise RequestError(f"Whisper-Modell muss einer von {VALID_MODELS} sein.")
        language = body.get("language", "de")
        if not isinstance(language, str) or not (2 <= len(language) <= 5):
            raise RequestError("Ungültige Sprache.")
        return {"job_id": SERVICE.start(ffmpeg, clips, model, language)}


def make_server(port: int) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    return httpd
