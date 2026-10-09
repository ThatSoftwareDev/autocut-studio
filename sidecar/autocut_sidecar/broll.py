"""B-Roll: Ordner indizieren und Clips per Schlagwort dem Gesprochenen zuordnen.

Unterstützt: Videos (mp4, mov, mkv, webm …) UND Bilder (jpg, jpeg, png, webp, bmp, tif).

Schlagwörter eines Clips/Bildes kommen aus
  1. dem Dateinamen, getrennt an _ - , . und Leerzeichen:
       hund_haustier_welpe.jpg -> ["hund", "haustier", "welpe"]
     Jedes Wort ist ein eigenständiger Treffer: fällt im Gesprochenen nur
     „Haustier“, passt die Datei bereits.
  2. einer gleichnamigen .txt: wachtel-futter_nahaufnahme.txt  ("küken, stall, fressen")
  3. broll-tags.json im Ordner: {"unterordner/clip.mp4": ["tag1", "tag2"]}

Vergleich: klein geschrieben, Umlaute vereinheitlicht, einfache deutsche
Endungen entfernt („Wachteln“ = „Wachtel“), Komposita erkannt
(„Wachtelfutter“ enthält „wachtel“). Keine KI – nachvollziehbar und schnell.
Ein Bild-Abgleich (CLIP) kann später als zweite Stufe dazukommen.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from .ffmpeg_tools import FfmpegError

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".mxf", ".webm", ".mts", ".m2ts"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
IMAGE_HOLD_S = 3600.0  # Standbilder sind beliebig lang – die Länge bestimmt die Einstellung im Panel
_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

STOPWORDS = set(
    """
    aber alle allem allen aller alles also auch auf aus bei beim bin bis bist dann das dass dein deine dem den
    der des dessen die dies diese diesem diesen dieser dieses doch dort durch ein eine einem einen einer eines
    er es etwas euch euer für gegen gewesen hab habe haben hat hatte hier hin hinter ich ihm ihn ihr ihre im in
    ist jetzt kann kein keine man mehr mein meine mich mir mit muss nach nicht nichts noch nun nur ob oder ohne
    sehr sein seine sich sie sind so soll sollte sonst über um und uns unser unter vom von vor war waren was
    weil wenn wer werden wie wieder will wir wird wo zu zum zur zwar zwischen also halt mal ganz einfach
    genau schon eben ja nein okay gut neu clip video take final final2 copy kopie broll b roll
    """.split()
)

_SUFFIXES = ("ungen", "ung", "chen", "en", "er", "es", "em", "e", "n", "s")


def normalize(word: str) -> str:
    """Kleinschreibung, Umlaute auf Grundvokal („füttern“ ~ „Futter“,
    „kueken“ ~ „Küken“), nur Buchstaben/Ziffern."""
    w = word.lower().replace("ß", "ss")
    w = w.replace("ä", "a").replace("ö", "o").replace("ü", "u")
    w = re.sub(r"[^a-z0-9]", "", w)
    return w.replace("ae", "a").replace("oe", "o").replace("ue", "u")


def stem(word: str) -> str:
    """Grobe deutsche Grundform: bis zu zwei Endungen abschneiden
    („morgens“ -> „morgen“ -> „morg“, „Wachteln“ -> „wachtel“)."""
    w = normalize(word)
    for _ in range(2):
        for suf in _SUFFIXES:
            if w.endswith(suf) and len(w) - len(suf) >= 4:
                w = w[: -len(suf)]
                break
        else:
            break
    return w


SEPARATORS = r"[_\-,.\s]+"  # Unterstrich, Bindestrich, Komma, Punkt, Leerzeichen


def split_name(text: str) -> List[str]:
    """Dateiname/Tag-Text in einzelne Wörter zerlegen.

    1. an _ - , . und Leerzeichen trennen (hund_haustier-welpe -> hund, haustier, welpe)
    2. jedes Stück zusätzlich an sonstigen Sonderzeichen trennen (hund+katze, (2))
    3. camelCase trennen (meinStall -> mein, Stall)
    """
    out: List[str] = []
    for part in re.split(SEPARATORS, text):
        part = re.sub(r"([a-zäöüß])([A-ZÄÖÜ])", r"\1 \2", part)
        out.extend(t for t in re.split(r"[^0-9A-Za-zÄÖÜäöüß]+", part) if t)
    return out


def keywords_from(tokens: Sequence[str]) -> List[str]:
    """Lesbare Schlagwörter (klein geschrieben, Umlaute bleiben erhalten).
    Zahlen, Füllwörter und Wörter unter 3 Buchstaben fallen weg."""
    out: List[str] = []
    for t in tokens:
        n = normalize(t)
        if len(n) < 3 or n.isdigit() or n in STOPWORDS:
            continue
        tag = t.lower()
        if tag not in out:
            out.append(tag)
    return out


def word_matches(word_stem: str, kw: str) -> bool:
    if not word_stem or not kw:
        return False
    if word_stem == kw:
        return True
    if len(kw) >= 5 and kw in word_stem:  # Kompositum: „wachtelfutter“ enthält „wachtel“
        return True
    return False


@dataclass
class BrollFile:
    path: str
    rel: str
    duration_s: float
    width: int
    height: int
    has_audio: bool = False
    keywords: List[str] = field(default_factory=list)  # lesbar, z. B. ["hund", "haustier", "welpe"]
    is_image: bool = False

    @property
    def stems(self) -> List[str]:
        """Interne Vergleichsform je Schlagwort (für Plural, Umlaute usw.)."""
        return [stem(k) for k in self.keywords]


def find_ffprobe(ffmpeg: str) -> Optional[str]:
    p = Path(ffmpeg)
    for name in ("ffprobe.exe", "ffprobe"):
        cand = p.with_name(name)
        if cand.is_file():
            return str(cand)
    import shutil

    return shutil.which("ffprobe")


def probe(ffprobe: str, path: str) -> Tuple[float, int, int, bool]:
    """Dauer, Breite, Höhe, hat_audio."""
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
             "-of", "json", path],
            capture_output=True, text=True, timeout=30, creationflags=_CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise FfmpegError(f"ffprobe ließ sich nicht starten: {exc}") from exc
    if out.returncode != 0:
        raise FfmpegError(f"ffprobe konnte {Path(path).name} nicht lesen.")
    data = json.loads(out.stdout or "{}")
    try:
        dur = float((data.get("format") or {}).get("duration") or 0.0)
    except (TypeError, ValueError):  # Bilder: "N/A" oder fehlt
        dur = 0.0
    w = h = 0
    has_audio = False
    for st in data.get("streams") or []:
        if st.get("codec_type") == "video" and not w:
            w, h = int(st.get("width") or 0), int(st.get("height") or 0)
        if st.get("codec_type") == "audio":
            has_audio = True
    return dur, w, h, has_audio


_probe_cache: Dict[Tuple[str, int, int], Tuple[float, int, int, bool]] = {}
_probe_lock = threading.Lock()


def cached_probe(ffprobe: str, path: str) -> Tuple[float, int, int, bool]:
    st = os.stat(path)
    key = (os.path.normcase(os.path.abspath(path)), st.st_mtime_ns, st.st_size)
    with _probe_lock:
        if key in _probe_cache:
            return _probe_cache[key]
    val = probe(ffprobe, path)
    with _probe_lock:
        _probe_cache[key] = val
    return val


def index_folder(ffmpeg: str, folder: str, max_depth: int = 3) -> Tuple[List[BrollFile], List[str]]:
    root = Path(folder)
    if not folder or not root.is_dir():
        raise FfmpegError(f"B-Roll-Ordner nicht gefunden: {folder or '(nicht gesetzt)'}")
    ffprobe = find_ffprobe(ffmpeg)
    if not ffprobe:
        raise FfmpegError("ffprobe wurde nicht gefunden (gehört normalerweise zu ffmpeg).")
    tags_json: Dict[str, List[str]] = {}
    tags_file = root / "broll-tags.json"
    warnings: List[str] = []
    if tags_file.is_file():
        try:
            raw = json.loads(tags_file.read_text(encoding="utf-8"))
            tags_json = {str(k).replace("\\", "/").lower(): list(v) for k, v in raw.items()}
        except (ValueError, AttributeError, TypeError):
            warnings.append("broll-tags.json ist kein gültiges JSON-Objekt und wird ignoriert.")

    files: List[BrollFile] = []
    ignored: Dict[str, int] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        depth = len(Path(dirpath).relative_to(root).parts)
        if depth >= max_depth:
            dirnames[:] = []
        for fn in sorted(filenames):
            p = Path(dirpath) / fn
            ext = p.suffix.lower()
            is_image = ext in IMAGE_EXTS
            if ext not in VIDEO_EXTS and not is_image:
                if ext not in (".txt", ".json", ".ini", ".db", "") and not fn.startswith("."):
                    ignored[ext] = ignored.get(ext, 0) + 1
                continue
            rel = p.relative_to(root).as_posix()
            tokens = split_name(p.stem)
            txt = p.with_suffix(".txt")
            if txt.is_file():
                try:
                    tokens += split_name(txt.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    pass
            tokens += [str(t) for t in tags_json.get(rel.lower(), [])]
            try:
                dur, w, h, has_audio = cached_probe(ffprobe, str(p))
            except FfmpegError as exc:
                warnings.append(str(exc))
                continue
            if is_image:
                dur, has_audio = IMAGE_HOLD_S, False
            if dur <= 0 or w <= 0:
                warnings.append(f"„{rel}“ hat kein lesbares Bild und wird übersprungen.")
                continue
            kws = keywords_from(tokens)
            if not kws:
                warnings.append(f"„{rel}“ hat keine verwertbaren Schlagwörter (Dateiname umbenennen oder .txt anlegen).")
            files.append(BrollFile(str(p), rel, dur, w, h, has_audio, kws, is_image))
    if ignored:
        kinds = ", ".join(f"{n}× {e or '(ohne Endung)'}" for e, n in sorted(ignored.items()))
        warnings.append(f"Nicht unterstützte Dateien ignoriert: {kinds}.")
    return files, warnings


@dataclass
class TimedWord:
    start_frame: int  # Zeitachse der Kopie
    end_frame: int
    text: str
    segment: int      # Index des Whisper-Satzes


@dataclass
class BrollParams:
    clip_frames: int        # Wunschlänge
    min_frames: int         # kürzer wird nicht eingefügt
    min_gap_frames: int     # Abstand zwischen zwei B-Rolls
    lead_frames: int        # so viel vor dem Schlagwort beginnen
    reuse: bool
    timeline_end: int
    fps: float


def place_broll(words: Sequence[TimedWord], files: Sequence[BrollFile], p: BrollParams) -> List[Dict]:
    stems = [stem(w.text) for w in words]
    seg_stems: Dict[int, List[str]] = {}
    for w, s in zip(words, stems):
        seg_stems.setdefault(w.segment, []).append(s)

    placements: List[Dict] = []
    used: set = set()
    last_end = -10**12
    for w, ws in zip(words, stems):
        if len(ws) < 3:
            continue
        start = max(0, w.start_frame - p.lead_frames)
        if start - last_end < p.min_gap_frames:
            continue
        best: Optional[Tuple[int, float, BrollFile, str]] = None
        for f in files:
            if not p.reuse and f.path in used:
                continue
            stems = f.stems
            hit_i = next((i for i, kw in enumerate(stems) if word_matches(ws, kw)), None)
            if hit_i is None:
                continue
            hit = f.keywords[hit_i]
            context = seg_stems.get(w.segment, [])
            score = sum(1 for kw in stems if any(word_matches(c, kw) for c in context))
            cand = (score, f.duration_s, f, hit)
            if best is None or cand[:2] > best[:2]:
                best = cand
        if best is None:
            continue
        _, _, f, hit = best
        max_frames = int((f.duration_s - 0.05) * p.fps)
        length = min(p.clip_frames, max_frames, p.timeline_end - start)
        if length < p.min_frames:
            continue
        source_in_s = 0.0 if f.is_image else min(0.5, max(0.0, f.duration_s - length / p.fps - 0.05))
        placements.append({
            "path": f.path,
            "file": f.rel,
            "keyword": hit,
            "word": w.text,
            "start_frame": start,
            "end_frame": start + length,
            "source_in_s": round(source_in_s, 3),
            "width": f.width,
            "height": f.height,
            "has_audio": f.has_audio,
            "is_image": f.is_image,
        })
        used.add(f.path)
        last_end = start + length
    return placements
