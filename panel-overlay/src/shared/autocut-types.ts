// Gemeinsame Typen für Panel (CEF) und ExtendScript (Premiere).
// Zeiten werden als Tick-Strings übergeben (254016000000 Ticks = 1 Sekunde),
// damit es keine Rundungsfehler gibt.

export type Fail = { ok: false; error: string };

export type ClipInfo = {
  clipId: string; // nodeId des TrackItems
  name: string;
  mediaPath: string;
  seqStartTicks: string;
  seqEndTicks: string;
  sourceInTicks: string;
};

export type SequenceInspection =
  | {
      ok: true;
      sequenceId: string;
      sequenceName: string;
      ticksPerFrame: string;
      endTicks: string;
      videoTrackCount: number;
      audioTrackCount: number;
      analysisTrackIndex: number;
      clips: ClipInfo[];
      /** Gründe, warum NICHT geschnitten werden darf. */
      blockers: string[];
      /** Hinweise, die den Schnitt nicht verhindern. */
      warnings: string[];
    }
  | Fail;

/** Ein zu entfernender Bereich in Sequenz-Ticks: [startTicks, endTicks). */
export type CutRangeTicks = { startTicks: string; endTicks: string };

export type WorkingCopyResult = { ok: true; sequenceId: string; name: string } | Fail;

export type StepResult = { ok: true; done: number; total: number; message?: string } | Fail;

export type BoundaryCheck = { ok: true; problems: string[] } | Fail;

export type VerifyReport =
  | {
      ok: true;
      passed: boolean;
      problems: string[];
      expectedEndTicks: string;
      actualEndTicks: string;
      checkedClips: number;
      checkedLinks: number;
    }
  | Fail;

// ---- Schritt 2: Zoom, Swoosh, B-Roll -------------------------------------

export type ZoomKeyTicks = { ticks: string; pct: number };

export type ZoomEventTicks =
  | { kind: "static"; pieceStartTicks: string; scalePct: number }
  | { kind: "keys"; pieceStartTicks: string; keys: ZoomKeyTicks[]; ease: boolean };

export type AudioPlacementTicks = { startTicks: string };

export type BrollPlacementTicks = {
  path: string;
  startTicks: string;
  durationTicks: string;
  sourceInTicks: string;
  width: number;
  height: number;
  hasAudio: boolean;
};

export type EnhanceResult =
  | {
      ok: true;
      applied: number;
      skipped: string[];
      /** Zoom: wie das Ease umgesetzt wurde ("bezier" = Premiere-Kurve, "sampled" = berechnete Zwischen-Keyframes) */
      easeMode?: string;
    }
  | Fail;

export type TrackFingerprint = { ok: true; tracks: { [label: string]: string } } | Fail;
