"""Tests für Zeitachse, Zoom-Planung, Swoosh, B-Roll und Transkriptions-Jobs.
Whisper selbst wird hier durch einen Test-Motor ersetzt (das echte Modell
testet setup.bat bzw. der Praxistest in Premiere)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from test_silence import FFMPEG, SR, TPF, synth, ticks, write_wav  # noqa: E402

from autocut_sidecar import server as srv  # noqa: E402
from autocut_sidecar.analysis import ClipSpec  # noqa: E402
from autocut_sidecar.broll import (  # noqa: E402
    BrollFile, BrollParams, TimedWord, index_folder, keywords_from, place_broll, split_name, stem, word_matches,
)
from autocut_sidecar.plan import build_plan  # noqa: E402
from autocut_sidecar.timeline import CutMap, keep_pieces  # noqa: E402
from autocut_sidecar.transcription.base import Segment, Word  # noqa: E402
from autocut_sidecar.transcription.service import TranscriptionService  # noqa: E402
from autocut_sidecar.zoom import ZoomParams, plan_camera, plan_slow, swoosh_events  # noqa: E402

FPS = 25


class FakeEngine:
    """Liefert ein festes „Transkript“, relativ zum übergebenen Audio."""

    name = "fake"
    calls = 0

    def __init__(self, script):
        self.script = script  # Liste (start_s, end_s, text, segment_text)

    def transcribe(self, audio, language, progress):
        FakeEngine.calls += 1
        dur = audio.size / 16000
        segs = {}
        for st, en, text, seg in self.script:
            if en <= dur + 1e-6:
                segs.setdefault(seg, []).append(Word(st, en, text, 0.9))
        out = []
        for seg, words in segs.items():
            out.append(Segment(words[0].start, words[-1].end, " ".join(w.text for w in words), words))
            progress(words[-1].end / dur)
        return out


class TimelineTests(unittest.TestCase):
    def test_cut_map_and_pieces(self):
        cm = CutMap([(50, 100), (240, 260)])
        self.assertEqual(cm.to_new(10), 10)
        self.assertIsNone(cm.to_new(60))
        self.assertEqual(cm.to_new(100), 50)
        self.assertEqual(cm.to_new(300), 230)
        pieces = keep_pieces([(0, 250), (250, 500)], cm)
        self.assertEqual([(p.orig_start, p.orig_end, p.new_start) for p in pieces],
                         [(0, 50, 0), (100, 240, 50), (260, 500, 190)])
        self.assertTrue(cm.overlaps_cut(45, 55))
        self.assertFalse(cm.overlaps_cut(100, 120))

    def test_pieces_split_at_clip_boundaries(self):
        cm = CutMap([(240, 260)])
        pieces = keep_pieces([(0, 250), (250, 500)], cm)
        self.assertEqual([(p.orig_start, p.orig_end, p.clip_index) for p in pieces],
                         [(0, 240, 0), (260, 500, 1)])


def zp(**kw):
    base = dict(mode="camera", strength_pct=110.0, ease=True, min_gap_frames=0, slow_min_frames=50,
                punch_hold_frames=25, punch_ramp_frames=5, punch_prominence_db=6.0)
    base.update(kw)
    return ZoomParams(**base)


class ZoomTests(unittest.TestCase):
    def setUp(self):
        self.pieces = keep_pieces([(0, 1000)], CutMap([(100, 110), (200, 210), (230, 240), (400, 410)]))

    def test_camera_alternates(self):
        ev = plan_camera(self.pieces, zp())
        # Stücke (Kopie): 0, 100, 190, 210, 370 -> erstes 100 %, dann abwechselnd
        self.assertEqual([e["piece_new_start"] for e in ev], [100, 210])
        self.assertTrue(all(e["kind"] == "static" and e["scale_pct"] == 110.0 for e in ev))
        self.assertTrue(all(e["swoosh_frame"] == e["piece_new_start"] for e in ev))

    def test_camera_respects_min_gap(self):
        ev = plan_camera(self.pieces, zp(min_gap_frames=150))
        # Umschalten frühestens alle 150 Frames: 0 (100 %), 190 (Zoom, Stück 210 bleibt gezoomt), 370 (100 %)
        self.assertEqual([e["piece_new_start"] for e in ev], [190, 210])
        self.assertEqual([e["swoosh_frame"] for e in ev], [190, None])

    def test_slow_zoom_keys_stay_in_piece(self):
        ev = plan_slow(self.pieces, zp(mode="slow"))
        for e in ev:
            frames = [k["frame"] for k in e["keys"]]
            self.assertGreaterEqual(frames[0], e["piece_new_start"])
            self.assertLess(frames[-1], e["piece_new_end"])
            self.assertEqual([k["pct"] for k in e["keys"]], [100.0, 110.0])
        self.assertNotIn(190, [e["piece_new_start"] for e in ev])  # 20-Frame-Stück zu kurz

    def test_swoosh_events_do_not_overlap(self):
        evs = [{"swoosh_frame": 0}, {"swoosh_frame": 5}, {"swoosh_frame": 40}, {"swoosh_frame": None}]
        self.assertEqual(swoosh_events(evs, swoosh_frames=20, offset_frames=0), [{"frame": 0}, {"frame": 40}])
        self.assertEqual(swoosh_events(evs, swoosh_frames=20, offset_frames=-3)[0], {"frame": 0})


class KeywordTests(unittest.TestCase):
    def test_keywords_from_filename(self):
        self.assertEqual(keywords_from(split_name("Wachtel-Futter_nahaufnahme 01")),
                         ["wachtel", "futter", "nahaufnahme"])
        self.assertEqual(keywords_from(split_name("meinStallMorgens")), ["stall", "morgens"])

    def test_separators_split_into_independent_tags(self):
        # Wunsch: _ - , . und Leerzeichen trennen; jedes Wort ein eigenes Schlagwort
        for name in ("hund_haustier_welpe", "hund-haustier-welpe", "hund,haustier,welpe",
                     "hund.haustier.welpe", "hund haustier welpe", "Hund _-, .Haustier  Welpe"):
            self.assertEqual(keywords_from(split_name(name)), ["hund", "haustier", "welpe"], name)

    def test_single_spoken_word_hits_multi_tag_file(self):
        f = BrollFile("x/hund_haustier.jpg", "hund_haustier.jpg", 3600.0, 640, 480, False,
                      keywords_from(split_name("hund_haustier")), True)
        words = [TimedWord(100, 110, "Mein", 0), TimedWord(110, 125, "Haustier", 0), TimedWord(125, 130, "schläft", 0)]
        bp = BrollParams(clip_frames=75, min_frames=25, min_gap_frames=0, lead_frames=0, reuse=False,
                         timeline_end=1000, fps=25.0)
        pl = place_broll(words, [f], bp)
        self.assertEqual(len(pl), 1)
        self.assertEqual((pl[0]["keyword"], pl[0]["word"], pl[0]["start_frame"]), ("haustier", "Haustier", 110))
        self.assertTrue(pl[0]["is_image"])
        self.assertEqual(pl[0]["source_in_s"], 0.0)
        self.assertEqual(pl[0]["end_frame"] - pl[0]["start_frame"], 75)  # Bild: Länge = Einstellung
        # auch Plural / nur das erste Wort
        for spoken in ("Haustiere", "Hunde", "Hund"):
            self.assertEqual(len(place_broll([TimedWord(10, 20, spoken, 0)], [f], bp)), 1, spoken)

    def test_matching_handles_plural_umlaut_and_compounds(self):
        self.assertTrue(word_matches(stem("Wachteln"), stem("wachtel")))
        self.assertTrue(word_matches(stem("Wachtelfutter"), stem("wachtel")))
        self.assertTrue(word_matches(stem("Küken"), stem("kueken")))
        self.assertTrue(word_matches(stem("füttern"), stem("Futter")))
        self.assertTrue(word_matches(stem("Morgens"), stem("morgen")))
        self.assertFalse(word_matches(stem("Stalltür"), stem("tal")))


@unittest.skipUnless(FFMPEG, "ffmpeg nicht installiert")
class PlanAndTranscriptionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        # 0-2 Ton | 2-3 Stille | 3-4 normal | 4-4.3 BETONUNG (lauter) | 4.3-6 normal
        parts = [synth([(2.0, "tone")]), synth([(1.0, "silence")]), synth([(1.0, "tone")]),
                 synth([(0.3, "tone")]) * 2.4, synth([(1.7, "tone")])]
        cls.wav = os.path.join(cls.tmp, "rede.wav")
        write_wav(cls.wav, np.clip(np.concatenate(parts), -1, 1))
        cls.swoosh = os.path.join(cls.tmp, "swoosh.wav")
        write_wav(cls.swoosh, synth([(0.4, "click")]))
        cls.broll_dir = os.path.join(cls.tmp, "B-Roll")
        os.makedirs(os.path.join(cls.broll_dir, "tiere"))
        for name, dur in (("wachtel-futter.mp4", 4), ("tiere/stall_morgen.mp4", 3), ("zufall.mp4", 3)):
            subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                            f"color=c=gray:s=320x180:r=25:d={dur}", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                            os.path.join(cls.broll_dir, name)], check=True)
        with open(os.path.join(cls.broll_dir, "zufall.txt"), "w", encoding="utf-8") as f:
            f.write("Garten, Beet")
        cls.script = [
            (0.2, 0.6, "Heute", 0), (0.6, 1.0, "füttern", 0), (1.0, 1.2, "wir", 0), (1.2, 1.8, "Wachteln.", 0),
            (2.2, 2.6, "Stall", 9),  # liegt in der Pause -> fällt beim Schnitt weg
            (3.1, 3.6, "Morgens", 1), (3.6, 3.9, "im", 1), (3.9, 4.4, "Stall", 1),
            (4.6, 5.0, "und", 2), (5.0, 5.6, "Garten.", 2),
        ]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def clip(self):
        return {"clip_id": "c", "name": "Rede", "media_path": self.wav, "seq_start_ticks": "0",
                "seq_end_ticks": ticks(6.0), "source_in_ticks": "0"}

    def body(self, **kw):
        b = {"ticks_per_frame": str(TPF), "threshold_db": -40.0, "clips": [self.clip()],
             "cuts": [{"start_frame": 52, "end_frame": 73}]}  # 2.08-2.92 s
        b.update(kw)
        return b

    def transcribe(self, service):
        clip = ClipSpec("c", "Rede", self.wav, 0, int(ticks(6.0)), 0)
        job = service.start(FFMPEG, [clip], "small", "de")
        for _ in range(200):
            j = service.job(job)
            if j["state"] in ("done", "error"):
                return j
            time.sleep(0.02)
        self.fail("Job hängt")

    def test_punch_finds_the_emphasis(self):
        z = {"enabled": True, "mode": "punch", "strength_pct": 115, "ease": True, "min_gap_s": 2,
             "slow_min_segment_s": 2, "punch_hold_s": 0.6, "punch_ramp_s": 0.2, "punch_prominence_db": 4}
        res = build_plan(FFMPEG, self.body(zoom=z), TranscriptionService())
        evs = res["zoom"]["events"]
        self.assertEqual(len(evs), 1, evs)
        peak = evs[0]["keys"][1]["frame"]
        # Betonung bei 4.0-4.3 s Original = 3.16-3.46 s in der Kopie (21 Frames entfernt)
        self.assertGreaterEqual(peak, int(4.0 * FPS) - 21 - 2)
        self.assertLessEqual(peak, int(4.3 * FPS) - 21 + 2)
        self.assertEqual(evs[0]["keys"][1]["pct"], 115)

    def test_swoosh_needs_real_audio_file(self):
        z = {"enabled": True, "mode": "camera", "strength_pct": 110, "ease": True, "min_gap_s": 0,
             "slow_min_segment_s": 2, "punch_hold_s": 0.6, "punch_ramp_s": 0.2, "punch_prominence_db": 6}
        res = build_plan(FFMPEG, self.body(zoom=z, swoosh={"enabled": True, "path": self.swoosh}),
                         TranscriptionService())
        self.assertEqual(res["swoosh"]["duration_frames"], 10)
        self.assertEqual([e["frame"] for e in res["swoosh"]["events"]], [52])  # 2. Stück (gezoomt) beginnt bei 52
        from autocut_sidecar.analysis import RequestError
        with self.assertRaises(RequestError):
            build_plan(FFMPEG, self.body(zoom=z, swoosh={"enabled": True, "path": self.swoosh + "x"}),
                       TranscriptionService())

    def test_transcription_cache_and_broll_matching(self):
        os.environ["LOCALAPPDATA"] = tempfile.mkdtemp(dir=self.tmp)
        service = TranscriptionService(lambda size: FakeEngine(self.script))
        FakeEngine.calls = 0
        j1 = self.transcribe(service)
        self.assertEqual(j1["state"], "done", j1)
        self.assertTrue(os.path.isfile(j1["result"]["json_path"]))
        j2 = self.transcribe(service)
        self.assertEqual(FakeEngine.calls, 1, "zweiter Lauf muss aus dem Cache kommen")
        br = {"enabled": True, "folder": self.broll_dir, "transcript_id": j2["result"]["transcript_id"],
              "clip_length_s": 2.0, "min_gap_s": 0.5, "lead_s": 0.0, "reuse": False}
        res = build_plan(FFMPEG, self.body(broll=br), service)
        pl = res["broll"]["placements"]
        self.assertEqual([p["file"] for p in pl], ["wachtel-futter.mp4", "tiere/stall_morgen.mp4"], pl)
        # „füttern“ (passt zu „Futter“) bei 0.6 s -> Frame 15. „Morgens“ (3.1 s) liegt zu nah an der
        # ersten B-Roll; „Stall“ bei 3.9 s Original -> 98 - 21 entfernte Frames = 77 in der Kopie.
        self.assertEqual(pl[0]["start_frame"], 15)
        self.assertEqual(pl[0]["word"], "füttern")
        self.assertEqual(pl[1]["start_frame"], 77)
        self.assertEqual(pl[0]["end_frame"] - pl[0]["start_frame"], 50)
        # „Stall“ in der Pause wurde weggeschnitten; „Garten“ (zufall.mp4) liegt im Mindestabstand
        # hinter der Stall-B-Roll (57..107) und wird deshalb nicht eingefügt.
        self.assertNotIn("zufall.mp4", [p["file"] for p in pl])

    def test_images_are_indexed(self):
        d = os.path.join(self.tmp, "bilder")
        os.makedirs(d, exist_ok=True)
        for name in ("hund_haustier_welpe.jpg", "katze-garten.png"):
            subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=640x480",
                            "-frames:v", "1", os.path.join(d, name)], check=True)
        open(os.path.join(d, "notiz.heic"), "wb").close()
        files, warnings = index_folder(FFMPEG, d)
        by = {f.rel: f for f in files}
        self.assertEqual(by["hund_haustier_welpe.jpg"].keywords, ["hund", "haustier", "welpe"])
        self.assertTrue(by["katze-garten.png"].is_image)
        self.assertEqual((by["katze-garten.png"].width, by["katze-garten.png"].height), (640, 480))
        self.assertTrue(any(".heic" in w for w in warnings), warnings)

    def test_missing_transcript_is_explained(self):
        from autocut_sidecar.analysis import RequestError
        with self.assertRaises(RequestError) as ctx:
            build_plan(FFMPEG, self.body(broll={"enabled": True, "folder": self.broll_dir, "transcript_id": "x",
                                                "clip_length_s": 2, "min_gap_s": 1, "lead_s": 0}),
                       TranscriptionService())
        self.assertIn("Transkript", str(ctx.exception))

    def test_model_missing_message(self):
        from autocut_sidecar.transcription.faster_whisper_engine import FasterWhisperEngine, model_available
        from autocut_sidecar.transcription.base import TranscriptionError
        if model_available("tiny"):
            self.skipTest("Modell vorhanden")
        with self.assertRaises(TranscriptionError) as ctx:
            FasterWhisperEngine("tiny")
        self.assertIn("download-model", str(ctx.exception))

    def test_server_transcribe_job_and_plan(self):
        os.environ["LOCALAPPDATA"] = tempfile.mkdtemp(dir=self.tmp)
        srv.SERVICE = TranscriptionService(lambda size: FakeEngine(self.script))
        httpd = srv.make_server(0)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            def call(method, path, body=None):
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                             data=json.dumps(body).encode() if body is not None else None)
                req.add_header("Content-Type", "application/json")
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.loads(r.read())
            job = call("POST", "/transcribe/start", {"clips": [self.clip()], "model": "small", "language": "de"})
            for _ in range(200):
                st = call("GET", f"/jobs/{job['job_id']}")
                if st["state"] in ("done", "error"):
                    break
                time.sleep(0.02)
            self.assertEqual(st["state"], "done", st)
            scan = call("POST", "/broll/scan", {"folder": self.broll_dir})
            self.assertEqual(len(scan["files"]), 3)
            res = call("POST", "/plan", self.body(broll={
                "enabled": True, "folder": self.broll_dir, "transcript_id": st["result"]["transcript_id"],
                "clip_length_s": 2.0, "min_gap_s": 0.5, "lead_s": 0.0, "reuse": False}))
            self.assertEqual(len(res["broll"]["placements"]), 2)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
