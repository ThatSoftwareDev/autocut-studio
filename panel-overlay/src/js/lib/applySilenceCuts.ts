// Führt die bestätigten Stille-Schnitte auf einer KOPIE der Sequenz aus.
// Reine Ablauf-Logik, ohne UI – dadurch auch außerhalb von Premiere testbar.

import type { CutRangeTicks, VerifyReport } from "../../shared/autocut-types";
import type { PremiereAdapter } from "./premiere";

export type CutFrames = { start_frame: number; end_frame: number };

export type ApplyProgress = { phase: string; done: number; total: number };

export type ApplyOutcome =
  | { ok: true; copyId: string; copyName: string; report: Extract<VerifyReport, { ok: true }> }
  | { ok: false; error: string; copyName?: string };

const RAZOR_CHUNK = 40;
const COMPACT_CHUNK = 60;

/** Frames -> Tick-Bereiche; prüft Sortierung und Überlappung. */
export const framesToTickRanges = (cuts: CutFrames[], ticksPerFrame: number): CutRangeTicks[] => {
  const sorted = [...cuts].sort((a, b) => a.start_frame - b.start_frame);
  const out: CutRangeTicks[] = [];
  let lastEnd = -1;
  for (const c of sorted) {
    if (!Number.isInteger(c.start_frame) || !Number.isInteger(c.end_frame) || c.end_frame <= c.start_frame) {
      throw new Error(`Ungültiger Schnittbereich (${c.start_frame}–${c.end_frame}).`);
    }
    if (c.start_frame < lastEnd) throw new Error("Schnittbereiche überlappen sich – Analyse bitte neu starten.");
    lastEnd = c.end_frame;
    const a = c.start_frame * ticksPerFrame;
    const b = c.end_frame * ticksPerFrame;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
      throw new Error("Sequenz zu lang für die Zeitberechnung (über ~9 Stunden).");
    }
    out.push({ startTicks: String(a), endTicks: String(b) });
  }
  return out;
};

export const applySilenceCuts = async (
  pp: PremiereAdapter,
  originalSequenceId: string,
  ranges: CutRangeTicks[],
  onProgress: (p: ApplyProgress) => void
): Promise<ApplyOutcome> => {
  // Auch ohne Schnitte (nur Zoom/B-Roll) läuft derselbe Weg: Kopie anlegen, prüfen.
  onProgress({ phase: "Kopie der Sequenz erstellen", done: 0, total: 1 });
  const copy = await pp.createWorkingCopy(originalSequenceId);
  if (!copy.ok) return { ok: false, error: copy.error };
  const id = copy.sequenceId;
  const failWith = (error: string): ApplyOutcome => ({ ok: false, error, copyName: copy.name });

  // Grenzen von hinten nach vorne schneiden (Reihenfolge ist egal, aber so
  // bleiben frühe Positionen garantiert unberührt, falls etwas abbricht).
  const seen: { [t: string]: true } = {};
  const boundaries: string[] = [];
  for (const r of ranges) {
    for (const t of [r.startTicks, r.endTicks]) {
      if (!seen[t]) {
        seen[t] = true;
        boundaries.push(t);
      }
    }
  }
  boundaries.sort((a, b) => Number(b) - Number(a));

  for (let i = 0; i < boundaries.length; i += RAZOR_CHUNK) {
    onProgress({ phase: "Schneiden (alle Spuren)", done: i, total: boundaries.length });
    const res = await pp.razorBoundaries(id, boundaries.slice(i, i + RAZOR_CHUNK));
    if (!res.ok) return failWith(res.error);
  }

  onProgress({ phase: "Schnitte prüfen", done: 0, total: 1 });
  const check = await pp.checkBoundaries(id, ranges);
  if (!check.ok) return failWith(check.error);
  if (check.problems.length) {
    return failWith("Nicht alle Schnitte wurden gesetzt:\n• " + check.problems.join("\n• "));
  }

  onProgress({ phase: "Stille-Stücke entfernen", done: 0, total: 1 });
  const removed = await pp.removeRanges(id, ranges);
  if (!removed.ok) return failWith(removed.error);

  const prep = await pp.prepareCompaction(id, ranges);
  if (!prep.ok) return failWith(prep.error);
  let done = 0;
  while (done < prep.total) {
    onProgress({ phase: "Lücken schließen", done, total: prep.total });
    const step = await pp.compactStep(id, COMPACT_CHUNK);
    if (!step.ok) return failWith(step.error);
    if (step.done <= done) return failWith("Lücken schließen kommt nicht voran – abgebrochen.");
    done = step.done;
  }

  onProgress({ phase: "Ergebnis prüfen (Sync, Längen, Positionen)", done: 0, total: 1 });
  const report = await pp.verify(id);
  if (!report.ok) return failWith(report.error);
  return { ok: true, copyId: id, copyName: copy.name, report };
};
