// Premiere-Adapter: die EINZIGE Stelle im Panel, die mit Premiere spricht.
// Bei einem späteren Umstieg auf UXP wird nur diese Datei (plus die
// ExtendScript-Schicht) ersetzt – Panel-UI und Analyse bleiben gleich.

import { evalTS } from "./utils/bolt";
import type {
  AudioPlacementTicks,
  BoundaryCheck,
  BrollPlacementTicks,
  CutRangeTicks,
  EnhanceResult,
  TrackFingerprint,
  ZoomEventTicks,
  SequenceInspection,
  StepResult,
  VerifyReport,
  WorkingCopyResult,
} from "../../shared/autocut-types";

export interface PremiereAdapter {
  inspectActiveSequence(audioTrackIndex: number): Promise<SequenceInspection>;
  setPlayhead(sequenceId: string, ticks: string): Promise<{ ok: true } | { ok: false; error: string }>;
  createWorkingCopy(sequenceId: string): Promise<WorkingCopyResult>;
  razorBoundaries(sequenceId: string, boundaryTicks: string[]): Promise<StepResult>;
  checkBoundaries(sequenceId: string, ranges: CutRangeTicks[]): Promise<BoundaryCheck>;
  removeRanges(sequenceId: string, ranges: CutRangeTicks[]): Promise<StepResult>;
  prepareCompaction(sequenceId: string, ranges: CutRangeTicks[]): Promise<StepResult>;
  compactStep(sequenceId: string, maxItems: number): Promise<StepResult>;
  verify(sequenceId: string): Promise<VerifyReport>;
  // Schritt 2
  resetEnhanceState(): Promise<{ ok: true }>;
  fingerprint(sequenceId: string): Promise<TrackFingerprint>;
  applyZoom(sequenceId: string, events: ZoomEventTicks[], videoTrackIndex: number): Promise<EnhanceResult>;
  placeBroll(sequenceId: string, placements: BrollPlacementTicks[], videoTrackIndex: number, fillFrame: boolean): Promise<EnhanceResult>;
  placeAudio(
    sequenceId: string,
    filePath: string,
    audioTrackIndex: number,
    placements: AudioPlacementTicks[],
    durationTicks: string
  ): Promise<EnhanceResult>;
}

/** ExtendScript-Fehler (Exceptions) in eine verständliche Meldung umwandeln. */
const guard = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (e: any) {
    const msg = e && e.message ? e.message : String(e);
    return { ok: false, error: `Premiere-Fehler bei „${what}“: ${msg}` } as unknown as T;
  }
};

export const cepPremiere: PremiereAdapter = {
  inspectActiveSequence: (i) => guard("Sequenz lesen", () => evalTS("acInspectActiveSequence", i)),
  setPlayhead: (id, t) => guard("Abspielposition", () => evalTS("acSetPlayhead", id, t)),
  createWorkingCopy: (id) => guard("Kopie erstellen", () => evalTS("acCreateWorkingCopy", id)),
  razorBoundaries: (id, b) => guard("Schneiden", () => evalTS("acRazorBoundaries", id, b)),
  checkBoundaries: (id, r) => guard("Schnitte prüfen", () => evalTS("acCheckBoundaries", id, r)),
  removeRanges: (id, r) => guard("Entfernen", () => evalTS("acRemoveRanges", id, r)),
  prepareCompaction: (id, r) => guard("Lücken vorbereiten", () => evalTS("acPrepareCompaction", id, r)),
  compactStep: (id, n) => guard("Lücken schließen", () => evalTS("acCompactStep", id, n)),
  verify: (id) => guard("Ergebnis prüfen", () => evalTS("acVerify", id)),
  resetEnhanceState: () => guard("Zustand zurücksetzen", () => evalTS("acResetEnhanceState")),
  fingerprint: (id) => guard("Spuren lesen", () => evalTS("acFingerprint", id)),
  applyZoom: (id, ev, v) => guard("Zoom setzen", () => evalTS("acApplyZoom", id, ev, v)),
  placeBroll: (id, p, v, f) => guard("B-Roll einfügen", () => evalTS("acPlaceBroll", id, p, v, f)),
  placeAudio: (id, path, a, p, d) => guard("Swoosh anlegen", () => evalTS("acPlaceAudio", id, path, a, p, d)),
};
