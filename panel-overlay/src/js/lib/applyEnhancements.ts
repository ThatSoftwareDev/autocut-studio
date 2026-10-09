// Zoom, B-Roll und Swoosh auf die (bereits geschnittene) Arbeitskopie anwenden.
// Reihenfolge: Zoom -> B-Roll -> Swoosh (B-Roll-Ton wird entfernt, bevor der
// Swoosh auf A2 kommt). Nach jedem Schritt werden alle Spuren verglichen: Nur
// die Zielspur des Schritts darf sich verändert haben.

import type { EnhanceResult, ZoomEventTicks } from "../../shared/autocut-types";
import type { PremiereAdapter } from "./premiere";

export type PlanZoomEvent =
  | { kind: "static"; piece_new_start: number; scale_pct: number; label?: string }
  | { kind: "keys"; piece_new_start: number; keys: { frame: number; pct: number }[]; ease: boolean; label?: string };

export type PlanBroll = {
  path: string;
  file: string;
  keyword: string;
  word: string;
  start_frame: number;
  end_frame: number;
  source_in_s: number;
  width: number;
  height: number;
  has_audio: boolean;
};

export type EnhancePlan = {
  ticksPerFrame: number;
  zoom: { events: PlanZoomEvent[]; videoTrackIndex: number } | null;
  broll: { placements: PlanBroll[]; videoTrackIndex: number; fillFrame: boolean } | null;
  swoosh: { path: string; durationFrames: number; frames: number[]; audioTrackIndex: number } | null;
};

type StepReport = { applied: number; skipped: string[]; easeMode?: string };

export type EnhanceOutcome =
  | { ok: true; zoom?: StepReport; broll?: StepReport; swoosh?: StepReport }
  | { ok: false; error: string };

export type EnhanceProgress = { phase: string; done: number; total: number };

const TPS = 254016000000;

const chunks = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const toZoomTicks = (ev: PlanZoomEvent, tpf: number): ZoomEventTicks =>
  ev.kind === "static"
    ? { kind: "static", pieceStartTicks: String(ev.piece_new_start * tpf), scalePct: ev.scale_pct }
    : {
        kind: "keys",
        pieceStartTicks: String(ev.piece_new_start * tpf),
        ease: ev.ease,
        keys: ev.keys.map((k) => ({ ticks: String(k.frame * tpf), pct: k.pct })),
      };

const merge = (acc: StepReport, r: Extract<EnhanceResult, { ok: true }>): StepReport => ({
  applied: acc.applied + r.applied,
  skipped: acc.skipped.concat(r.skipped),
  easeMode: r.easeMode || acc.easeMode,
});

export const applyEnhancements = async (
  pp: PremiereAdapter,
  copyId: string,
  plan: EnhancePlan,
  onProgress: (p: EnhanceProgress) => void
): Promise<EnhanceOutcome> => {
  const tpf = plan.ticksPerFrame;
  await pp.resetEnhanceState();
  const fp0 = await pp.fingerprint(copyId);
  if (!fp0.ok) return { ok: false, error: fp0.error };

  const checkTracks = async (allowed: string[], step: string): Promise<string | null> => {
    const fp = await pp.fingerprint(copyId);
    if (!fp.ok) return fp.error;
    for (const key of Object.keys(fp0.tracks)) {
      if (allowed.includes(key)) continue;
      if (fp.tracks[key] !== fp0.tracks[key]) {
        return `${step}: Spur ${key} wurde unerwartet verändert. Abgebrochen – bitte die Arbeitskopie löschen.`;
      }
    }
    return null;
  };

  const out: { zoom?: StepReport; broll?: StepReport; swoosh?: StepReport } = {};
  const allowed: string[] = [];

  if (plan.zoom && plan.zoom.events.length) {
    let rep: StepReport = { applied: 0, skipped: [] };
    const parts = chunks(plan.zoom.events, 25);
    for (let i = 0; i < parts.length; i++) {
      onProgress({ phase: "Zooms setzen", done: i * 25, total: plan.zoom.events.length });
      const r = await pp.applyZoom(copyId, parts[i].map((e) => toZoomTicks(e, tpf)), plan.zoom.videoTrackIndex);
      if (!r.ok) return { ok: false, error: r.error };
      rep = merge(rep, r);
    }
    const bad = await checkTracks(allowed, "Zoom");
    if (bad) return { ok: false, error: bad };
    out.zoom = rep;
  }

  if (plan.broll && plan.broll.placements.length) {
    let rep: StepReport = { applied: 0, skipped: [] };
    const all = plan.broll.placements.map((p) => ({
      path: p.path,
      startTicks: String(p.start_frame * tpf),
      durationTicks: String((p.end_frame - p.start_frame) * tpf),
      sourceInTicks: String(Math.round((p.source_in_s * TPS) / tpf) * tpf),
      width: p.width,
      height: p.height,
      hasAudio: p.has_audio,
    }));
    const parts = chunks(all, 10);
    for (let i = 0; i < parts.length; i++) {
      onProgress({ phase: "B-Roll einfügen", done: i * 10, total: all.length });
      const r = await pp.placeBroll(copyId, parts[i], plan.broll.videoTrackIndex, plan.broll.fillFrame);
      if (!r.ok) return { ok: false, error: r.error };
      rep = merge(rep, r);
    }
    allowed.push(`V${plan.broll.videoTrackIndex + 1}`);
    const bad = await checkTracks(allowed, "B-Roll");
    if (bad) return { ok: false, error: bad };
    out.broll = rep;
  }

  if (plan.swoosh && plan.swoosh.frames.length) {
    let rep: StepReport = { applied: 0, skipped: [] };
    const parts = chunks(plan.swoosh.frames, 25);
    for (let i = 0; i < parts.length; i++) {
      onProgress({ phase: "Swoosh-Sounds anlegen", done: i * 25, total: plan.swoosh.frames.length });
      const r = await pp.placeAudio(
        copyId,
        plan.swoosh.path,
        plan.swoosh.audioTrackIndex,
        parts[i].map((f) => ({ startTicks: String(f * tpf) })),
        String(plan.swoosh.durationFrames * tpf)
      );
      if (!r.ok) return { ok: false, error: r.error };
      rep = merge(rep, r);
    }
    allowed.push(`A${plan.swoosh.audioTrackIndex + 1}`);
    const bad = await checkTracks(allowed, "Swoosh");
    if (bad) return { ok: false, error: bad };
    out.swoosh = rep;
  }
  return { ok: true, ...out };
};
