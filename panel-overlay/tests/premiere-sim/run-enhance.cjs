// Zoom, B-Roll und Swoosh gegen das simulierte Premiere.
const assert = require("assert");
const { install, Seq, TPS, Time } = require("./mock-premiere.cjs");

const TPF = TPS / 25;
const S = (s) => Math.round(s * TPS);
const F = (frames) => frames * TPF;

function fresh(simOpts) {
  for (const m of ["common", "autocut", "enhance", "applySilenceCuts", "applyEnhancements"]) {
    delete require.cache[require.resolve(`./build/${m}.js`)];
  }
  const sim = {
    moveLinked: true, acceptTime: true, autoKey: true, bezierEases: true,
    overwriteAccepts: "ticks", inPointAccepts: "ticks",
    media: {
      "D:/broll/wachtel-futter.mp4": { dur: S(6), hasAudio: true },
      "D:/broll/stall.mp4": { dur: S(1.5), hasAudio: false },
      "D:/assets/swoosh.wav": { dur: S(0.4), hasAudio: true },
    },
    ...simOpts,
  };
  const project = install(sim);
  const es = { ...require("./build/autocut.js"), ...require("./build/enhance.js") };
  const { applySilenceCuts, framesToTickRanges } = require("./build/applySilenceCuts.js");
  const { applyEnhancements } = require("./build/applyEnhancements.js");
  const rt = (x) => JSON.parse(JSON.stringify(x));
  const pp = {
    inspectActiveSequence: async (i) => rt(es.acInspectActiveSequence(i)),
    createWorkingCopy: async (id) => rt(es.acCreateWorkingCopy(id)),
    razorBoundaries: async (id, b) => rt(es.acRazorBoundaries(id, rt(b))),
    checkBoundaries: async (id, r) => rt(es.acCheckBoundaries(id, rt(r))),
    removeRanges: async (id, r) => rt(es.acRemoveRanges(id, rt(r))),
    prepareCompaction: async (id, r) => rt(es.acPrepareCompaction(id, rt(r))),
    compactStep: async (id, n) => rt(es.acCompactStep(id, n)),
    verify: async (id) => rt(es.acVerify(id)),
    resetEnhanceState: async () => rt(es.acResetEnhanceState()),
    fingerprint: async (id) => rt(es.acFingerprint(id)),
    applyZoom: async (id, ev, v) => rt(es.acApplyZoom(id, rt(ev), v)),
    placeBroll: async (id, p, v, f) => rt(es.acPlaceBroll(id, rt(p), v, f)),
    placeAudio: async (id, path, a, p, d) => rt(es.acPlaceAudio(id, path, a, rt(p), d)),
  };
  // Rohaufnahme: V1/A1 verknüpft, ein Take mit In-Punkt 5 s (Keyframe-Zeitbasis!), V2/A2 leer
  const seq = new Seq(sim, "Roh", TPF, 2, 2);
  sim.sequences.push(seq);
  seq.v[0].add(S(0), S(20), S(5), "g1");
  seq.a[0].add(S(0), S(20), S(5), "g1");
  project.activeSequence = seq;
  return { sim, project, pp, seq, applySilenceCuts, framesToTickRanges, applyEnhancements };
}

// Schnitte 2–4 s und 10–11 s -> Stücke in der Kopie: [0,50) [50,200) [200,450)
const CUTS = [{ start_frame: 50, end_frame: 100 }, { start_frame: 250, end_frame: 275 }];

async function cutCopy(ctx) {
  const insp = await ctx.pp.inspectActiveSequence(0);
  const out = await ctx.applySilenceCuts(ctx.pp, insp.sequenceId, ctx.framesToTickRanges(CUTS, TPF), () => {});
  assert.ok(out.ok && out.report.passed, JSON.stringify(out));
  return ctx.sim.sequences.find((s) => s.sequenceID === out.copyId);
}

const PLAN = (over = {}) => ({
  ticksPerFrame: TPF,
  zoom: {
    videoTrackIndex: 0,
    events: [
      { kind: "static", piece_new_start: 50, scale_pct: 110 },
      { kind: "keys", piece_new_start: 200, ease: true,
        keys: [{ frame: 260, pct: 100 }, { frame: 266, pct: 115 }, { frame: 290, pct: 115 }, { frame: 296, pct: 100 }] },
    ],
  },
  broll: {
    videoTrackIndex: 1, fillFrame: true,
    placements: [
      { path: "D:/broll/wachtel-futter.mp4", file: "wachtel-futter.mp4", keyword: "wachtel", word: "Wachteln",
        start_frame: 20, end_frame: 70, source_in_s: 0.5, width: 3840, height: 2160, has_audio: true },
      { path: "D:/broll/stall.mp4", file: "stall.mp4", keyword: "stall", word: "Stall",
        start_frame: 300, end_frame: 330, source_in_s: 0, width: 1920, height: 1080, has_audio: false },
    ],
  },
  swoosh: { path: "D:/assets/swoosh.wav", durationFrames: 10, frames: [50, 260], audioTrackIndex: 1 },
  ...over,
});

async function scenario(name, simOpts, check) {
  const ctx = fresh(simOpts);
  const copy = await cutCopy(ctx);
  const v1Before = copy.v[0].items.map((i) => [i._s, i._e, i._in]);
  const a1Before = copy.a[0].items.map((i) => [i._s, i._e, i._in]);
  const res = await ctx.applyEnhancements(ctx.pp, copy.sequenceID, PLAN(), () => {});
  await check(ctx, copy, res, v1Before, a1Before);
  console.log("✔", name);
}

const valueAtSeq = (clip, seqTicks) => {
  const t = new Time();
  t.ticks = clip._in + (seqTicks - clip._s);
  return clip.motion.scale.getValueAtTime(t);
};

module.exports = (async () => {
  const common = async (ctx, copy, res, v1Before, a1Before) => {
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepStrictEqual(copy.v[0].items.map((i) => [i._s, i._e, i._in]), v1Before, "V1 unverändert");
    assert.deepStrictEqual(copy.a[0].items.map((i) => [i._s, i._e, i._in]), a1Before, "A1 unverändert");
    assert.strictEqual(ctx.sim.keyOutOfRange, 0, "Keyframes in Medienzeit des Clips");
    // Kamera-Wechsel: Stück 2 statisch auf 110 %
    assert.strictEqual(copy.v[0].items[1].motion.scale.value, 110);
    // Punch im dritten Stück: 100 % vorher, 115 % auf dem Höhepunkt, zurück auf 100 %
    const p3 = copy.v[0].items[2];
    assert.strictEqual(valueAtSeq(p3, F(255)), 100);
    assert.strictEqual(valueAtSeq(p3, F(270)), 115);
    assert.strictEqual(valueAtSeq(p3, F(300)), 100);
    const mid = valueAtSeq(p3, F(261.5)); // 25 % der Rampe: weich = deutlich unter 103,75
    assert.ok(mid < 103, "Ease wirkt (gemessen " + mid.toFixed(2) + ")");
    assert.ok(![...p3.motion.scale.keys.keys()].includes(p3._in + 7), "automatischer Key entfernt");
    // B-Roll auf V2: richtige Position/Länge, Ton entfernt, 4K bildfüllend skaliert
    const v2 = copy.v[1].items;
    assert.deepStrictEqual(v2.map((i) => [i._s / TPF, i._e / TPF]), [[20, 70], [300, 330]]);
    assert.strictEqual(v2[0]._in, Math.round(0.5 * 25) * TPF, "Quell-In-Punkt");
    assert.strictEqual(v2[0].motion.scale.value, 50);
    // Swoosh auf A2 an den Zoom-Startpunkten, sonst nichts auf A2
    assert.deepStrictEqual(copy.a[1].items.map((i) => i._s / TPF), [50, 260]);
    // Projektfenster: eigene Ablagen, B-Roll-In/Out wieder freigegeben
    const bins = ctx.project.rootItem.list.map((b) => b.name);
    assert.ok(bins.includes("AutoCut B-Roll") && bins.includes("AutoCut Assets"));
    const pi = ctx.project.rootItem.list.find((b) => b.name === "AutoCut B-Roll").list[0];
    assert.strictEqual(pi._in, null);
  };

  await scenario("Zoom, B-Roll und Swoosh (Bezier wirkt weich)", {}, async (ctx, copy, res, v1, a1) => {
    await common(ctx, copy, res, v1, a1);
    assert.strictEqual(res.zoom.easeMode, "bezier");
    assert.strictEqual(res.zoom.applied, 2);
    assert.strictEqual(res.broll.applied, 2);
    assert.strictEqual(res.swoosh.applied, 2);
  });

  await scenario("Bezier wirkt NICHT weich -> berechnete Ease-Kurve", { bezierEases: false }, async (ctx, copy, res, v1, a1) => {
    await common(ctx, copy, res, v1, a1);
    assert.strictEqual(res.zoom.easeMode, "sampled");
    assert.ok(copy.v[0].items[2].motion.scale.keys.size > 8, "Zwischen-Keyframes gesetzt");
  });

  await scenario("overwriteClip erwartet Sekunden, setInPoint ein Time-Objekt", { overwriteAccepts: "seconds", inPointAccepts: "time" },
    async (ctx, copy, res, v1, a1) => {
      await common(ctx, copy, res, v1, a1);
    });

  {
    const ctx = fresh({});
    const copy = await cutCopy(ctx);
    copy.a[1].add(F(255), F(400), 0, null, { name: "musik" }); // A2 ab 255 belegt
    const musicBefore = copy.a[1].items.map((i) => [i._s, i._e]);
    const res = await ctx.applyEnhancements(ctx.pp, copy.sequenceID, PLAN(), () => {});
    assert.ok(res.ok, JSON.stringify(res));
    assert.strictEqual(res.swoosh.applied, 1);
    assert.ok(res.swoosh.skipped[0].includes("belegt"));
    assert.deepStrictEqual(copy.a[1].items.filter((i) => i.name === "musik").map((i) => [i._s, i._e]), musicBefore, "Musik unangetastet");
    assert.strictEqual(res.broll.applied, 2, "beide passen: Wachtel-Ton landet vor der Musik, stall.mp4 hat keinen Ton");
    console.log("✔ belegte Spur: Swoosh wird ausgelassen und gemeldet");
  }
})().catch((e) => { console.error("✘", e); process.exit(1); });
