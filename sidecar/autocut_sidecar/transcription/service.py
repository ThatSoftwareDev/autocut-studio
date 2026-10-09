"""Transkription der Analysespur als Hintergrund-Job mit Fortschritt und Cache.

Wörter werden in Ticks der ORIGINAL-Sequenz gespeichert. Der Plan rechnet sie
anschließend auf die geschnittene Kopie um (weggeschnittene Wörter fallen raus).
Ergebnisse werden pro Clip auf der Festplatte zwischengespeichert, damit eine
erneute Planung nicht neu transkribieren muss.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import traceback
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from ..analysis import ClipSpec
from ..ffmpeg_tools import FfmpegError, stream_pcm
from ..silence import TICKS_PER_SECOND
from .base import SAMPLE_RATE, Engine, Segment, TranscriptionError, Word


def cache_root() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".cache")
    p = Path(base) / "AutoCutStudio"
    p.mkdir(parents=True, exist_ok=True)
    return p


EngineFactory = Callable[[str], Engine]


def default_engine_factory(size: str) -> Engine:
    name = os.environ.get("AUTOCUT_ENGINE", "faster-whisper")
    if name == "whisper.cpp":
        from .whisper_cpp_engine import WhisperCppEngine

        return WhisperCppEngine(size)
    from .faster_whisper_engine import FasterWhisperEngine

    return FasterWhisperEngine(size)


class TranscriptionService:
    def __init__(self, engine_factory: EngineFactory = default_engine_factory) -> None:
        self._factory = engine_factory
        self._engines: Dict[str, Engine] = {}
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._transcripts: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._run_lock = threading.Lock()  # immer nur eine Transkription gleichzeitig (CPU)

    # ---- öffentliche API -------------------------------------------------
    def start(self, ffmpeg: str, clips: List[ClipSpec], model: str, language: str) -> str:
        job_id = uuid.uuid4().hex[:12]
        with self._lock:
            self._jobs[job_id] = {"state": "queued", "progress": 0.0, "message": "Warte …"}
        t = threading.Thread(target=self._run, args=(job_id, ffmpeg, clips, model, language), daemon=True)
        t.start()
        return job_id

    def job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            j = self._jobs.get(job_id)
            return dict(j) if j else None

    def transcript(self, transcript_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._transcripts.get(transcript_id)

    # ---- intern ----------------------------------------------------------
    def _update(self, job_id: str, **kw: Any) -> None:
        with self._lock:
            self._jobs[job_id].update(kw)

    def _engine(self, model: str) -> Engine:
        if model not in self._engines:
            self._engines[model] = self._factory(model)
        return self._engines[model]

    def _clip_cache_file(self, clip: ClipSpec, model: str, language: str, engine_name: str) -> Path:
        st = os.stat(clip.media_path)
        raw = json.dumps([os.path.normcase(os.path.abspath(clip.media_path)), st.st_mtime_ns, st.st_size,
                          clip.source_in_ticks, clip.seq_end_ticks - clip.seq_start_ticks, model, language,
                          engine_name, 1])
        h = hashlib.sha1(raw.encode()).hexdigest()[:20]
        d = cache_root() / "transcripts" / "clips"
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{h}.json"

    def _run(self, job_id: str, ffmpeg: str, clips: List[ClipSpec], model: str, language: str) -> None:
        try:
            with self._run_lock:
                self._update(job_id, state="running", message=f"Lade Whisper-Modell „{model}“ …")
                engine = self._engine(model)
                total = sum(c.seq_end_ticks - c.seq_start_ticks for c in clips) or 1
                done = 0
                words: List[Dict[str, Any]] = []
                segments: List[Dict[str, Any]] = []
                for ci, clip in enumerate(clips):
                    dur = clip.seq_end_ticks - clip.seq_start_ticks
                    cache_file = self._clip_cache_file(clip, model, language, engine.name)
                    if cache_file.is_file():
                        segs = [Segment(s["start"], s["end"], s["text"], [Word(**w) for w in s["words"]])
                                for s in json.loads(cache_file.read_text(encoding="utf-8"))]
                    else:
                        self._update(job_id, message=f"Lese Audio von „{clip.name}“ …")
                        audio = np.concatenate(list(stream_pcm(
                            ffmpeg, clip.media_path, clip.source_in_ticks / TICKS_PER_SECOND,
                            dur / TICKS_PER_SECOND, SAMPLE_RATE, SAMPLE_RATE * 30,
                        )) or [np.empty(0, np.int16)]).astype(np.float32) / 32768.0
                        self._update(job_id, message=f"Transkribiere „{clip.name}“ ({ci + 1}/{len(clips)}) …")
                        base = done

                        def prog(f: float, base=base, dur=dur) -> None:
                            self._update(job_id, progress=min(0.999, (base + f * dur) / total))

                        segs = engine.transcribe(audio, language, prog) if audio.size else []
                        cache_file.write_text(json.dumps([asdict(s) for s in segs], ensure_ascii=False),
                                              encoding="utf-8")
                    for s in segs:
                        seg_index = len(segments)
                        segments.append({
                            "start_ticks": str(clip.seq_start_ticks + int(round(s.start * TICKS_PER_SECOND))),
                            "end_ticks": str(clip.seq_start_ticks + int(round(s.end * TICKS_PER_SECOND))),
                            "text": s.text,
                        })
                        for w in s.words:
                            if w.end <= w.start:
                                continue
                            words.append({
                                "start_ticks": clip.seq_start_ticks + int(round(w.start * TICKS_PER_SECOND)),
                                "end_ticks": clip.seq_start_ticks + int(round(w.end * TICKS_PER_SECOND)),
                                "text": w.text,
                                "probability": round(w.probability, 3),
                                "segment": seg_index,
                            })
                    done += dur
                    self._update(job_id, progress=min(0.999, done / total))

                transcript_id = uuid.uuid4().hex[:12]
                transcript = {"id": transcript_id, "model": model, "language": language, "engine": engine.name,
                              "words": words, "segments": segments, "created": time.time()}
                out_file = cache_root() / "transcripts" / f"transkript-{time.strftime('%Y%m%d-%H%M%S')}.json"
                out_file.write_text(json.dumps(transcript, ensure_ascii=False, indent=1), encoding="utf-8")
                with self._lock:
                    self._transcripts[transcript_id] = transcript
                self._update(job_id, state="done", progress=1.0, message="Fertig.",
                             result={"transcript_id": transcript_id, "word_count": len(words),
                                     "segment_count": len(segments), "json_path": str(out_file),
                                     "preview": " ".join(s["text"] for s in segments)[:400]})
        except (TranscriptionError, FfmpegError) as exc:
            self._update(job_id, state="error", message=str(exc))
        except Exception:  # pragma: no cover
            traceback.print_exc()
            self._update(job_id, state="error", message="Unerwarteter Fehler bei der Transkription – Details im Helfer-Fenster.")
