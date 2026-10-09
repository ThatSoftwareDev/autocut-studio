"""Tests mit synthetischem Audio. Start: python -m unittest discover -s tests -v"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import wave

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from autocut_sidecar.analysis import analyze_silence  # noqa: E402
from autocut_sidecar.ffmpeg_tools import FfmpegError, find_ffmpeg  # noqa: E402
from autocut_sidecar.server import make_server, origin_allowed  # noqa: E402
from autocut_sidecar.silence import (  # noqa: E402
    TICKS_PER_SECOND,
    Interval,
    merge_touching,
    silence_mask,
    to_cut_ranges,
)

SR = 48_000
FPS = 25
TPF = TICKS_PER_SECOND // FPS  # 10160640000


def ticks(seconds: float) -> str:
    return str(int(round(seconds * TICKS_PER_SECOND)))


def synth(segments, seed=1) -> np.ndarray:
    """segments: Liste (Dauer_s, 'tone'|'silence'|'click')."""
    rng = np.random.default_rng(seed)
    parts = []
    for dur, kind in segments:
        n = int(round(dur * SR))
        t = np.arange(n) / SR
        noise = rng.normal(0, 10 ** (-62 / 20), n)  # Grundrauschen ~ -62 dBFS
        if kind == "tone":  # "Sprache": ~ -12 dBFS
            sig = 0.35 * np.sin(2 * np.pi * 220 * t) * (0.7 + 0.3 * np.sin(2 * np.pi * 3 * t))
        elif kind == "tail":  # leises Wortende knapp unter -40 dB
            sig = 10 ** (-41 / 20) * np.sqrt(2) * np.sin(2 * np.pi * 220 * t)
        elif kind == "click":
            sig = 0.5 * np.sin(2 * np.pi * 1000 * t)
        else:
            sig = np.zeros(n)
        parts.append(sig + noise)
    return np.clip(np.concatenate(parts), -1, 1)


def write_wav(path: str, data: np.ndarray) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((data * 32767).astype("<i2").tobytes())


def request(clips, **overrides):
    body = {
        "ticks_per_frame": str(TPF),
        "threshold_db": -40.0,
        "padding_in_s": 0.1,
        "padding_out_s": 0.1,
        "min_silence_s": 0.4,
        "hysteresis_db": 0.0,
        "clips": clips,
    }
    body.update(overrides)
    return body


FFMPEG = find_ffmpeg()


class PureLogicTests(unittest.TestCase):
    def test_click_inside_pause_is_ignored_but_edges_are_kept(self):
        db = np.array([-10] * 5 + [-60] * 20 + [-10] * 3 + [-60] * 20 + [-10] * 5, dtype=np.float32)
        mask = silence_mask(db.copy(), -40, min_sound_windows=6)
        self.assertTrue(mask[5:48].all(), "kurzer Klick soll die Pause nicht teilen")
        self.assertFalse(mask[:5].any())
        self.assertFalse(mask[48:].any())

    def test_cuts_are_rounded_inwards_never_outwards(self):
        # Stille von 1.003 s bis 2.497 s -> nach Padding 1.103..2.397
        iv = Interval(int(1.003 * TICKS_PER_SECOND), int(2.497 * TICKS_PER_SECOND), -60.0, 1)
        pad = int(0.1 * TICKS_PER_SECOND)
        cuts = to_cut_ranges([iv], TPF, int(0.4 * TICKS_PER_SECOND), pad, pad, 2)
        self.assertEqual(len(cuts), 1)
        c = cuts[0]
        self.assertGreaterEqual(c.start_frame * TPF, iv.start_ticks + int(0.1 * TICKS_PER_SECOND))
        self.assertLessEqual(c.end_frame * TPF, iv.end_ticks - int(0.1 * TICKS_PER_SECOND))

    def test_merge_across_adjacent_clips(self):
        a = Interval(0, 100, -60.0, 1)
        b = Interval(100, 300, -60.0, 2)
        c = Interval(500, 600, -60.0, 1)
        merged = merge_touching([c, b, a], tolerance_ticks=10)
        self.assertEqual([(m.start_ticks, m.end_ticks) for m in merged], [(0, 300), (500, 600)])

    def test_origin_rules(self):
        for ok in (None, "null", "file://", "http://localhost:3000", "http://127.0.0.1:5000"):
            self.assertTrue(origin_allowed(ok), ok)
        for bad in ("https://evil.example", "http://localhost.evil.com", "http://192.168.0.2"):
            self.assertFalse(origin_allowed(bad), bad)


@unittest.skipUnless(FFMPEG, "ffmpeg nicht installiert")
class FfmpegAnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        # 0-1 Ton | 1-2.5 Stille | 2.5-3.5 Ton | 3.5-3.7 kurze Stille | 3.7-4.7 Ton
        # | 4.7-5.4 Stille mit Klick in der Mitte | 5.4-6.4 Ton
        cls.audio = synth([
            (1.0, "tone"), (1.5, "silence"), (1.0, "tone"), (0.2, "silence"), (1.0, "tone"),
            (0.34, "silence"), (0.02, "click"), (0.34, "silence"), (1.0, "tone"),
        ])
        cls.wav = os.path.join(cls.tmp, "take ä 01.wav")  # Leerzeichen + Umlaut absichtlich
        write_wav(cls.wav, cls.audio)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def clip(self, seq_start=0.0, src_in=0.0, dur=6.4, path=None):
        return {
            "clip_id": "c1",
            "name": "Take",
            "media_path": path or self.wav,
            "seq_start_ticks": ticks(seq_start),
            "seq_end_ticks": ticks(seq_start + dur),
            "source_in_ticks": ticks(src_in),
        }

    def test_detects_only_real_pauses(self):
        res = analyze_silence(FFMPEG, request([self.clip()]))
        cuts = [(c["start_s"], c["end_s"]) for c in res["cuts"]]
        self.assertEqual(len(cuts), 2, cuts)
        # Pause 1: 1.0-2.5 -> mit 0.1 s Padding 1.1-2.4
        self.assertAlmostEqual(cuts[0][0], 1.12, delta=0.05)
        self.assertAlmostEqual(cuts[0][1], 2.4, delta=0.05)
        # Pause mit Klick 4.7-5.4 -> 4.8-5.3 (Klick zerteilt die Pause nicht)
        self.assertAlmostEqual(cuts[1][0], 4.8, delta=0.05)
        self.assertAlmostEqual(cuts[1][1], 5.3, delta=0.05)
        for c in res["cuts"]:
            self.assertLess(c["mean_db"], -40)
        self.assertLess(res["levels"]["noise_floor_db"], -50)
        self.assertGreater(res["levels"]["speech_level_db"], -25)

    def test_source_in_and_sequence_offset_are_mapped(self):
        # Clip nutzt die Quelle ab 2.5 s und liegt in der Sequenz bei 10 s.
        res = analyze_silence(FFMPEG, request([self.clip(seq_start=10.0, src_in=2.5, dur=3.9)]))
        cuts = [(c["start_s"], c["end_s"]) for c in res["cuts"]]
        self.assertEqual(len(cuts), 1, cuts)
        # Pause-mit-Klick liegt in der Quelle bei 4.7-5.4 -> Sequenz 12.2-12.9 -> gepaddet 12.3-12.8
        self.assertAlmostEqual(cuts[0][0], 12.3, delta=0.05)
        self.assertAlmostEqual(cuts[0][1], 12.8, delta=0.05)

    def test_higher_padding_means_fewer_frames_cut(self):
        a = analyze_silence(FFMPEG, request([self.clip()], padding_in_s=0.05, padding_out_s=0.05))["summary"]["removed_s"]
        b = analyze_silence(FFMPEG, request([self.clip()], padding_in_s=0.3, padding_out_s=0.3))["summary"]["removed_s"]
        self.assertGreater(a, b)

    def test_mp4_with_video_stream(self):
        mp4 = os.path.join(self.tmp, "clip.mp4")
        subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25",
             "-i", self.wav, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
             "-b:a", "192k", mp4],
            check=True,
        )
        res = analyze_silence(FFMPEG, request([self.clip(path=mp4)]))
        self.assertEqual(res["summary"]["cut_count"], 2)

    def test_padding_in_and_out_are_separate(self):
        res = analyze_silence(FFMPEG, request([self.clip()], padding_in_s=0.05, padding_out_s=0.3))
        first = res["cuts"][0]
        # Pause 1.0-2.5: Start = 1.0 + 0.3 (out), Ende = 2.5 - 0.05 (in)
        self.assertAlmostEqual(first["start_s"], 1.3, delta=0.05)
        self.assertAlmostEqual(first["end_s"], 2.44, delta=0.05)

    def test_quiet_word_ending_is_kept_with_ausklang_schutz(self):
        wav = os.path.join(self.tmp, "tail.wav")
        write_wav(wav, synth([(1.0, "tone"), (0.15, "tail"), (1.2, "silence"), (1.0, "tone")]))
        clip = self.clip(path=wav, dur=3.35)
        without = analyze_silence(FFMPEG, request([clip], hysteresis_db=0.0, padding_out_s=0.0))["cuts"][0]
        with_h = analyze_silence(FFMPEG, request([clip], hysteresis_db=6.0, padding_out_s=0.0))["cuts"][0]
        self.assertAlmostEqual(without["start_s"], 1.0, delta=0.05)  # Wortende wäre abgeschnitten
        self.assertAlmostEqual(with_h["start_s"], 1.16, delta=0.05)  # Wortende bleibt
        self.assertEqual(without["end_s"], with_h["end_s"])

    def test_missing_file_gives_clear_error(self):
        with self.assertRaises(FfmpegError) as ctx:
            analyze_silence(FFMPEG, request([self.clip(path=os.path.join(self.tmp, "fehlt.wav"))]))
        self.assertIn("nicht gefunden", str(ctx.exception))

    def test_file_without_audio(self):
        mp4 = os.path.join(self.tmp, "stumm.mp4")
        subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=25",
             "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4],
            check=True,
        )
        with self.assertRaises(FfmpegError) as ctx:
            analyze_silence(FFMPEG, request([self.clip(path=mp4, dur=2.0)]))
        self.assertIn("keinen Audiostream", str(ctx.exception))


@unittest.skipUnless(FFMPEG, "ffmpeg nicht installiert")
class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = make_server(0)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.tmp = tempfile.mkdtemp()
        cls.wav = os.path.join(cls.tmp, "a.wav")
        write_wav(cls.wav, synth([(1, "tone"), (1, "silence"), (1, "tone")]))

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}"), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}"), dict(e.headers)

    def test_health(self):
        status, body, _ = self.call("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertIsNotNone(body["ffmpeg"])

    def test_analyze_roundtrip_with_cep_origin(self):
        clip = {"clip_id": "x", "name": "a", "media_path": self.wav, "seq_start_ticks": "0",
                "seq_end_ticks": ticks(3), "source_in_ticks": "0"}
        status, body, headers = self.call("POST", "/silence/analyze", request([clip]),
                                          {"Origin": "file://"})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["summary"]["cut_count"], 1)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "file://")

    def test_foreign_website_is_rejected(self):
        status, body, _ = self.call("POST", "/silence/analyze", request([]),
                                    {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_bad_request_is_explained(self):
        status, body, _ = self.call("POST", "/silence/analyze", request([]))
        self.assertEqual(status, 400)
        self.assertIn("Keine Clips", body["error"]["message"])
        status, body, _ = self.call("POST", "/silence/analyze", {"clips": [], "threshold_db": 3})
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
