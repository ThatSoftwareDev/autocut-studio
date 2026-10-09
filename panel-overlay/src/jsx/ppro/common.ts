// Gemeinsame Hilfsfunktionen der Premiere-Schicht (ExtendScript, ES3).
import type { CutRangeTicks, Fail } from "../../shared/autocut-types";

export const TPS = 254016000000;

export type Kind = "V" | "A";

export const fail = (error: string): Fail => ({ ok: false, error });

export const num = (ticks: string | number): number => Number(ticks);

export const pad2 = (n: number): string => (n < 10 ? "0" + n : String(n));

export const findSequence = (id: string): Sequence | null => {
  const seqs = app.project.sequences;
  for (let i = 0; i < seqs.numSequences; i++) {
    const s = (seqs as any)[i] as Sequence;
    if (s && s.sequenceID === id) return s;
  }
  return null;
};

export const trackCount = (seq: Sequence, kind: Kind): number =>
  kind === "V" ? seq.videoTracks.numTracks : seq.audioTracks.numTracks;

export const getTrack = (seq: Sequence, kind: Kind, index: number): Track =>
  kind === "V" ? seq.videoTracks[index] : seq.audioTracks[index];

export const label = (kind: Kind, index: number): string => kind + (index + 1);

export const tc = (seq: Sequence, ticks: number): string => {
  try {
    const t = new Time();
    t.ticks = String(Math.round(ticks));
    const s = seq.getSettings();
    return String(t.getFormatted(s.videoFrameRate, s.videoDisplayFormat as any));
  } catch (e) {
    return (ticks / TPS).toFixed(2) + " s";
  }
};

/** Stellt sicher, dass genau diese Sequenz aktiv ist – sonst wird NICHTS getan. */
export const requireActive = (id: string): Sequence | Fail => {
  const seq = findSequence(id);
  if (!seq) return fail("Die Arbeitskopie wurde nicht gefunden (gelöscht oder umbenannt?).");
  let active = app.project.activeSequence;
  if (!active || active.sequenceID !== id) {
    app.project.openSequence(id);
    active = app.project.activeSequence;
  }
  if (!active || active.sequenceID !== id) {
    return fail(
      "Die Arbeitskopie ist nicht die aktive Sequenz. Klicke in ihre Zeitleiste und versuche es erneut."
    );
  }
  return seq;
};

export const isFail = (x: any): x is Fail => x && x.ok === false;

export type Range = { a: number; b: number };

export const parseRanges = (ranges: CutRangeTicks[]): Range[] => {
  const out: Range[] = [];
  for (let i = 0; i < ranges.length; i++) {
    out.push({ a: num(ranges[i].startTicks), b: num(ranges[i].endTicks) });
  }
  out.sort((x, y) => x.a - y.a);
  return out;
};

/** Index des Bereichs, der [start, end] vollständig enthält, sonst -1 (binäre Suche). */
export const rangeContaining = (ranges: Range[], start: number, end: number, tol: number): number => {
  let lo = 0;
  let hi = ranges.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].a <= start + tol) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found >= 0 && end <= ranges[found].b + tol) return found;
  return -1;
};

export const tolerance = (seq: Sequence): number => Math.floor(num(seq.timebase) / 4);

