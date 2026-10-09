const assert = require("assert");
const { install, Seq, TPS } = require("./mock-premiere.cjs");

const TPF = TPS / 25;
const S = (s) => Math.round(s * TPS);

function fresh(simOpts) {
  delete require.cache[require.resolve("./build/autocut.js")];
  const sim = { moveLinked: true, acceptTime: true, ...simOpts };
  const project = install(sim);
  const es = require("./build/autocut.js");
  const { applySilenceCuts, framesToTickRanges } = require("./build/applySilenceCuts.js");
  const rt = (x) => JSON.parse(JSON.stringify(x)); // wie evalTS: JSON-Rundreise
  const pp = {
    inspectActiveSequence: async (i) => rt(es.acInspectActiveSequence(i)),
    setPlayhead: async (id, t) => rt(es.acSetPlayhead(id, t)),
    createWorkingCopy: async (id) => rt(es.acCreateWorkingCopy(id)),
    razorBoundaries: async (id, b) => rt(es.acRazorBoundaries(id, rt(b))),
    checkBoundaries: async (id, r) => rt(es.acCheckBoundaries(id, rt(r))),
    removeRanges: async (id, r) => rt(es.acRemoveRanges(id, rt(r))),
    prepareCompaction: async (id, r) => rt(es.acPrepareCompaction(id, rt(r))),
    compactStep: async (id, n) => rt(es.acCompactStep(id, n)),
    verify: async (id) => rt(es.acVerify(id)),
  };
  // Original: V1/A1 verknüpft (2 Takes), A2 Musik durchgehend
  const seq = new Seq(sim, "Rohschnitt", TPF, 1, 2);
  sim.sequences.push(seq);
  seq.v[0].add(S(0), S(10), S(0), "g1"); seq.a[0].add(S(0), S(10), S(0), "g1", { name: "take1" });
  seq.v[0].add(S(10), S(20), S(5), "g2"); seq.a[0].add(S(10), S(20), S(5), "g2", { name: "take2" });
  seq.a[1].add(S(0), S(20), S(0), null, { name: "musik" });
  project.activeSequence = seq;
  return { sim, project, es, pp, seq, applySilenceCuts, framesToTickRanges };
}

const CUTS = [
  { start_frame: 50, end_frame: 100 },   // 2.0–4.0 s
  { start_frame: 240, end_frame: 260 },  // 9.6–10.4 s, über die Clipgrenze
  { start_frame: 400, end_frame: 450 },  // 16–18 s
];

async function scenario(name, simOpts, check) {
  const ctx = fresh(simOpts);
  const insp = await ctx.pp.inspectActiveSequence(0);
  assert.ok(insp.ok, JSON.stringify(insp));
  const ranges = ctx.framesToTickRanges(CUTS, Number(insp.ticksPerFrame));
  const phases = [];
  const out = await ctx.applySilenceCuts(ctx.pp, insp.sequenceId, ranges, (p) => phases.push(p.phase));
  await check(ctx, insp, out);
  console.log("✔", name);
}

module.exports = (async () => {
  for (const [name, opts] of [
    ["verknüpfte Clips bewegen sich gemeinsam", { moveLinked: true }],
    ["verknüpfte Clips bewegen sich einzeln", { moveLinked: false }],
    ["move() akzeptiert nur Sekunden", { acceptTime: false }],
  ]) {
    await scenario(name, opts, async (ctx, insp, out) => {
      assert.ok(out.ok, JSON.stringify(out));
      assert.ok(out.report.passed, JSON.stringify(out.report.problems));
      assert.strictEqual(ctx.sim.overwrites, 0, "es darf nichts überschrieben werden");
      const copy = ctx.sim.sequences.find((s) => s.sequenceID === out.copyId);
      assert.strictEqual(Number(copy.end), S(20) - 120 * TPF);
      // Original unverändert
      assert.strictEqual(ctx.seq.end, String(S(20)));
      assert.strictEqual(ctx.seq.allItems().length, 5);
      // Jedes Videostück hat ein deckungsgleiches Tonstück auf A1
      for (const v of copy.v[0].items) {
        const a = copy.a[0].items.find((x) => x._s === v._s && x._e === v._e);
        assert.ok(a, "Ton passend zum Bild bei " + v._s / TPS);
        assert.strictEqual(a._in, v._in, "Quell-In-Punkte von Bild und Ton gleich");
      }
      // Musik ist lückenlos zusammengeschoben
      const m = copy.a[1].items;
      for (let i = 1; i < m.length; i++) assert.strictEqual(m[i]._s, m[i - 1]._e);
      // Nach dem 1. Schnitt beginnt der Inhalt von Sekunde 4 jetzt bei Sekunde 2
      const second = copy.v[0].items[1];
      assert.strictEqual(second._s, S(2));
      assert.strictEqual(second._in, S(4));
    });
  }

  {
    const ctx = fresh({});
    ctx.seq.a[1].locked = true;
    const insp = await ctx.pp.inspectActiveSequence(0);
    assert.ok(insp.blockers.some((b) => b.includes("A2 ist gesperrt")), JSON.stringify(insp.blockers));
    // Selbst wenn man die Sperre ignoriert, fängt die Grenzprüfung es ab:
    const out = await ctx.applySilenceCuts(ctx.pp, insp.sequenceId, ctx.framesToTickRanges(CUTS, TPF), () => {});
    assert.ok(!out.ok && out.error.includes("Nicht alle Schnitte"), JSON.stringify(out));
    assert.strictEqual(ctx.seq.allItems().length, 5, "Original unberührt");
    console.log("✔ gesperrte Spur: Inspektion blockiert, Anwenden bricht sauber ab");
  }
  {
    const ctx = fresh({ acceptTime: false, secondsJitter: TPF * 0.6 });
    const insp = await ctx.pp.inspectActiveSequence(0);
    const out = await ctx.applySilenceCuts(ctx.pp, insp.sequenceId, ctx.framesToTickRanges(CUTS, TPF), () => {});
    assert.ok(!out.ok && out.error.includes("nicht korrekt verschoben"), JSON.stringify(out));
    console.log("✔ ungenaues move(): Abbruch statt falschem Ergebnis");
  }
  {
    const ctx = fresh({});
    const insp = await ctx.pp.inspectActiveSequence(5);
    assert.ok(!insp.ok && insp.error.includes("A6 gibt es nicht"));
    ctx.project.activeSequence = null;
    const none = await ctx.pp.inspectActiveSequence(0);
    assert.ok(!none.ok && none.error.includes("Keine aktive Sequenz"));
    assert.throws(() => ctx.framesToTickRanges([{ start_frame: 10, end_frame: 20 }, { start_frame: 15, end_frame: 30 }], TPF));
    console.log("✔ Fehlerfälle: falsche Spur, keine Sequenz, überlappende Bereiche");
  }
})().catch((e) => { console.error("✘", e); process.exit(1); });
