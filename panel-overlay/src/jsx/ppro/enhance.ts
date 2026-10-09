// AutoCut Studio – Zoom, Swoosh und B-Roll in der Arbeitskopie (ExtendScript, ES3).
//
// Wie in autocut.ts gilt: nur in der aktiven Arbeitskopie arbeiten, jede Aktion
// nachmessen, bei Unklarheit lieber auslassen und melden als falsch setzen.
//
// Keyframe-Zeitbasis: Premiere speichert Effekt-Keyframes in Medienzeit
// (In-Punkt des Clips + Abstand zum Clip-Anfang), nicht in Sequenzzeit.
// Nach dem Setzen wird jeder Keyframe-Wert per getValueAtTime() nachgeprüft.

import type {
  AudioPlacementTicks,
  BrollPlacementTicks,
  EnhanceResult,
  TrackFingerprint,
  ZoomEventTicks,
  ZoomKeyTicks,
} from "../../shared/autocut-types";
import { fail, getTrack, isFail, label, num, requireActive, tc, tolerance } from "./common";

const MOTION = "AE.ADBE Motion";
const INTERP_LINEAR = 0;
const INTERP_BEZIER = 5;
const ASSET_BIN = "AutoCut Assets";
const BROLL_BIN = "AutoCut B-Roll";

// Einmal pro Premiere-Sitzung ermittelt (gleiches Verhalten für alle Clips)
let easeMode: "" | "bezier" | "sampled" = "";
let overwriteMode: "" | "ticks" | "time" | "seconds" = "";
let inPointMode: "" | "ticks" | "time" | "seconds" = "";

const mkTime = (ticks: number): Time => {
  const t = new Time();
  t.ticks = String(Math.round(ticks));
  return t;
};

const easeInOutCubic = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

const findClipAt = (track: Track, startTicks: number, tol: number): TrackItem | null => {
  const clips = track.clips;
  for (let i = 0; i < clips.numItems; i++) {
    if (Math.abs(num(clips[i].start.ticks) - startTicks) <= tol) return clips[i];
  }
  return null;
};

const trackFree = (track: Track, a: number, b: number, tol: number): boolean => {
  const clips = track.clips;
  for (let i = 0; i < clips.numItems; i++) {
    const s = num(clips[i].start.ticks);
    const e = num(clips[i].end.ticks);
    if (s < b - tol && e > a + tol) return false;
  }
  return true;
};

const trackSignature = (track: Track): string => {
  const parts: string[] = [];
  const clips = track.clips;
  for (let i = 0; i < clips.numItems; i++) parts.push(clips[i].start.ticks + "-" + clips[i].end.ticks);
  return parts.join(";");
};

/** Momentaufnahme aller Spuren – das Panel vergleicht sie vor/nach jedem Schritt. */
export const acFingerprint = (sequenceId: string): TrackFingerprint => {
  const seq = requireActive(sequenceId);
  if (isFail(seq)) return seq;
  const tracks: { [label: string]: string } = {};
  for (let i = 0; i < seq.videoTracks.numTracks; i++) tracks[label("V", i)] = trackSignature(seq.videoTracks[i]);
  for (let i = 0; i < seq.audioTracks.numTracks; i++) tracks[label("A", i)] = trackSignature(seq.audioTracks[i]);
  return { ok: true, tracks };
};

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

type ScaleParam = { scale: ComponentParam; base: number };

const motionScale = (clip: TrackItem): ScaleParam | string => {
  const comps = (clip as any).components;
  if (!comps) return "keine Effekt-Komponenten lesbar";
  for (let i = 0; i < comps.numItems; i++) {
    if (String(comps[i].matchName) !== MOTION) continue;
    const props = comps[i].properties;
    const scale = props[1] as ComponentParam;
    const base = Number(scale.getValue());
    if (!(base > 0)) return "Skalierungswert nicht lesbar";
    if (props.numItems > 3) {
      const uniform = props[3].getValue();
      if (uniform === false || uniform === 0) return "„Gleichmäßige Skalierung“ ist ausgeschaltet";
    }
    return { scale, base };
  }
  return "Effekt „Bewegung“ nicht gefunden";
};

/** Sequenz-Ticks -> Medienzeit des Clips (Zeitbasis der Keyframes). */
const mediaTime = (clip: TrackItem, seqTicks: number): Time =>
  mkTime(num(clip.inPoint.ticks) + (seqTicks - num(clip.start.ticks)));

const keyTicksOf = (scale: ComponentParam): number[] => {
  const out: number[] = [];
  const keys = scale.getKeys();
  if (!keys || !(keys as any).length) return out;
  for (let i = 0; i < keys.length; i++) out.push(num(keys[i].ticks));
  return out;
};

const near = (list: number[], v: number, tol: number): boolean => {
  for (let i = 0; i < list.length; i++) if (Math.abs(list[i] - v) <= tol) return true;
  return false;
};

/** Setzt Keyframes und prüft sie nach. Gibt null zurück oder eine Fehlerbeschreibung. */
const applyKeys = (
  clip: TrackItem,
  sp: ScaleParam,
  keys: ZoomKeyTicks[],
  ease: boolean,
  tpf: number,
  tol: number
): string | null => {
  const scale = sp.scale;
  if (scale.isTimeVarying()) return "hat bereits Skalierungs-Keyframes (nicht überschrieben)";
  scale.setTimeVarying(true);
  const autoKeys = keyTicksOf(scale); // manche Versionen legen beim Einschalten selbst einen Key an

  const target: { t: number; media: number; v: number }[] = [];
  for (let i = 0; i < keys.length; i++) {
    const t = num(keys[i].ticks);
    const m = mediaTime(clip, t);
    const v = (sp.base * keys[i].pct) / 100;
    (scale as any).addKey(m);
    scale.setValueAtKey(m, v, true);
    target.push({ t, media: num(m.ticks), v });
  }
  const ours: number[] = [];
  for (let i = 0; i < target.length; i++) ours.push(target[i].media);
  for (let i = 0; i < autoKeys.length; i++) {
    if (!near(ours, autoKeys[i], tol)) (scale as any).removeKey(mkTime(autoKeys[i]));
  }

  const setInterp = (mode: number) => {
    for (let i = 0; i < target.length; i++) (scale as any).setInterpolationTypeAtKey(mkTime(target[i].media), mode, true);
  };

  if (ease && easeMode !== "sampled") {
    setInterp(INTERP_BEZIER);
    if (easeMode === "") {
      // Einmalig nachmessen: ist die Bezier-Kurve wirklich weich (langsamer Anfang)?
      for (let i = 0; i + 1 < target.length; i++) {
        const a = target[i];
        const b = target[i + 1];
        if (Math.abs(b.v - a.v) < 0.5 || b.t - a.t < 4 * tpf) continue;
        const probe = Number((scale as any).getValueAtTime(mkTime(a.media + (b.media - a.media) * 0.25)));
        const fraction = (probe - a.v) / (b.v - a.v);
        easeMode = fraction < 0.2 ? "bezier" : "sampled";
        break;
      }
    }
  }
  if (ease && easeMode === "sampled") {
    setInterp(INTERP_LINEAR);
    // Exakte Ease-In/Out-Kurve über Zwischen-Keyframes (ein Key pro Frame)
    for (let i = 0; i + 1 < target.length; i++) {
      const a = target[i];
      const b = target[i + 1];
      if (Math.abs(b.v - a.v) < 0.01) continue;
      const steps = Math.floor((b.t - a.t) / tpf);
      for (let s = 1; s < steps; s++) {
        const m = mkTime(a.media + s * tpf);
        const v = a.v + (b.v - a.v) * easeInOutCubic(s / steps);
        (scale as any).addKey(m);
        scale.setValueAtKey(m, v, true);
        (scale as any).setInterpolationTypeAtKey(m, INTERP_LINEAR, true);
      }
    }
  } else if (!ease) {
    setInterp(INTERP_LINEAR);
  }

  // Nachprüfen: liegt an jedem gewünschten Zeitpunkt der gewünschte Wert an?
  for (let i = 0; i < target.length; i++) {
    const got = Number((scale as any).getValueAtTime(mkTime(target[i].media)));
    if (Math.abs(got - target[i].v) > 0.5) {
      return "Keyframe-Prüfung fehlgeschlagen (erwartet " + target[i].v.toFixed(1) + ", gelesen " + got.toFixed(1) + ")";
    }
  }
  return null;
};

export const acResetEnhanceState = (): { ok: true } => {
  easeMode = "";
  overwriteMode = "";
  inPointMode = "";
  return { ok: true };
};

export const acApplyZoom = (sequenceId: string, events: ZoomEventTicks[], videoTrackIndex: number): EnhanceResult => {
  const seq = requireActive(sequenceId);
  if (isFail(seq)) return seq;
  if (videoTrackIndex >= seq.videoTracks.numTracks) return fail("Videospur V" + (videoTrackIndex + 1) + " gibt es nicht.");
  const tol = tolerance(seq);
  const tpf = num(seq.timebase);
  const track = getTrack(seq, "V", videoTrackIndex);
  const skipped: string[] = [];
  let applied = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const start = num(ev.pieceStartTicks);
    const where = label("V", videoTrackIndex) + " bei " + tc(seq, start);
    const clip = findClipAt(track, start, tol);
    if (!clip) {
      skipped.push(where + ": kein Clip-Stück gefunden");
      continue;
    }
    const sp = motionScale(clip);
    if (typeof sp === "string") {
      skipped.push(where + ": " + sp);
      continue;
    }
    if (ev.kind === "static") {
      if (sp.scale.isTimeVarying()) {
        skipped.push(where + ": hat bereits Skalierungs-Keyframes (nicht überschrieben)");
        continue;
      }
      const v = (sp.base * ev.scalePct) / 100;
      sp.scale.setValue(v, true);
      if (Math.abs(Number(sp.scale.getValue()) - v) > 0.5) {
        return fail(where + ": Skalierung ließ sich nicht setzen. Abgebrochen.");
      }
      applied++;
      continue;
    }
    // Keyframes müssen innerhalb des Clip-Stücks liegen
    const cs = num(clip.start.ticks);
    const ce = num(clip.end.ticks);
    let inside = true;
    for (let k = 0; k < ev.keys.length; k++) {
      const t = num(ev.keys[k].ticks);
      if (t < cs - tol || t >= ce) inside = false;
    }
    if (!inside) {
      skipped.push(where + ": Zoom würde über das Clip-Ende hinausgehen");
      continue;
    }
    const err = applyKeys(clip, sp, ev.keys, ev.ease, tpf, tol);
    if (err) {
      if (err.indexOf("Prüfung") >= 0) return fail(where + ": " + err + ". Abgebrochen.");
      skipped.push(where + ": " + err);
      continue;
    }
    applied++;
  }
  return { ok: true, applied, skipped, easeMode };
};

// ---------------------------------------------------------------------------
// Dateien importieren / platzieren
// ---------------------------------------------------------------------------

const normPath = (p: string): string => String(p).replace(/\\/g, "/").toLowerCase();

const findOrCreateBin = (name: string): ProjectItem => {
  const root = app.project.rootItem;
  for (let i = 0; i < root.children.numItems; i++) {
    const c = root.children[i];
    if (c.type === 2 && String(c.name) === name) return c;
  }
  return root.createBin(name);
};

const findByPath = (bin: ProjectItem, path: string): ProjectItem | null => {
  const want = normPath(path);
  for (let i = 0; i < bin.children.numItems; i++) {
    const c = bin.children[i];
    if (c.type === 2) continue;
    let p = "";
    try {
      p = String(c.getMediaPath() || "");
    } catch (e) {
      p = "";
    }
    if (p && normPath(p) === want) return c;
  }
  return null;
};

/** Importiert fehlende Dateien in die Ablage und liefert Pfad -> ProjectItem. */
const importInto = (binName: string, paths: string[]): { items: { [p: string]: ProjectItem }; missing: string[] } => {
  const bin = findOrCreateBin(binName);
  const items: { [p: string]: ProjectItem } = {};
  const toImport: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const found = findByPath(bin, paths[i]);
    if (found) items[normPath(paths[i])] = found;
    else if (!(normPath(paths[i]) in items)) toImport.push(paths[i]);
  }
  if (toImport.length) {
    app.project.importFiles(toImport as any, true as any, bin as any, false as any);
  }
  const missing: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const key = normPath(paths[i]);
    if (items[key]) continue;
    const found = findByPath(bin, paths[i]);
    if (found) items[key] = found;
    else missing.push(paths[i]);
  }
  return { items, missing };
};

const clipKeys = (track: Track): { [k: string]: boolean } => {
  const out: { [k: string]: boolean } = {};
  const clips = track.clips;
  for (let i = 0; i < clips.numItems; i++) out[clips[i].start.ticks + "-" + clips[i].end.ticks] = true;
  return out;
};

const newClips = (track: Track, before: { [k: string]: boolean }): TrackItem[] => {
  const out: TrackItem[] = [];
  const clips = track.clips;
  for (let i = 0; i < clips.numItems; i++) {
    if (!before[clips[i].start.ticks + "-" + clips[i].end.ticks]) out.push(clips[i]);
  }
  return out;
};

/** overwriteClip mit Selbstkalibrierung: Die Doku nennt widersprüchliche
 *  Zeitformate (Ticks-String / Time / Sekunden). Jede Variante wird nachgemessen. */
const overwriteAt = (track: Track, item: ProjectItem, startTicks: number, tol: number): TrackItem | null => {
  const order: Array<"ticks" | "time" | "seconds"> =
    overwriteMode === "time" ? ["time", "ticks", "seconds"] :
    overwriteMode === "seconds" ? ["seconds", "ticks", "time"] : ["ticks", "time", "seconds"];
  for (let m = 0; m < order.length; m++) {
    const before = clipKeys(track);
    const arg: any =
      order[m] === "ticks" ? String(Math.round(startTicks)) :
      order[m] === "time" ? mkTime(startTicks) : startTicks / 254016000000;
    try {
      (track as any).overwriteClip(item, arg);
    } catch (e) {
      continue;
    }
    const added = newClips(track, before);
    let hit: TrackItem | null = null;
    for (let i = 0; i < added.length; i++) {
      if (Math.abs(num(added[i].start.ticks) - startTicks) <= tol) hit = added[i];
    }
    if (hit) {
      overwriteMode = order[m];
      return hit;
    }
    for (let i = 0; i < added.length; i++) {
      try {
        added[i].remove(false, true); // falsch platziert -> wieder weg
      } catch (e) {
        // bereits entfernt
      }
    }
  }
  return null;
};

export const acPlaceAudio = (
  sequenceId: string,
  filePath: string,
  audioTrackIndex: number,
  placements: AudioPlacementTicks[],
  durationTicks: string
): EnhanceResult => {
  const seq = requireActive(sequenceId);
  if (isFail(seq)) return seq;
  if (audioTrackIndex >= seq.audioTracks.numTracks) {
    return fail("Audiospur A" + (audioTrackIndex + 1) + " gibt es in der Sequenz nicht. Bitte anlegen (Rechtsklick auf die Spurköpfe › Spur hinzufügen).");
  }
  const imp = importInto(ASSET_BIN, [filePath]);
  if (imp.missing.length) return fail("Swoosh-Datei konnte nicht importiert werden: " + filePath);
  const item = imp.items[normPath(filePath)];
  const tol = tolerance(seq);
  const dur = num(durationTicks);
  const track = getTrack(seq, "A", audioTrackIndex);
  const skipped: string[] = [];
  let applied = 0;
  for (let i = 0; i < placements.length; i++) {
    const t = num(placements[i].startTicks);
    const where = label("A", audioTrackIndex) + " bei " + tc(seq, t);
    if (!trackFree(track, t, t + dur, tol)) {
      skipped.push(where + ": Spur ist dort belegt");
      continue;
    }
    const clip = overwriteAt(track, item, t, tol);
    if (!clip) return fail(where + ": Swoosh ließ sich nicht korrekt platzieren. Abgebrochen.");
    applied++;
  }
  return { ok: true, applied, skipped };
};

/** In/Out-Punkt der Quelle setzen und nachprüfen (Doku widersprüchlich: Ticks/Sekunden). */
const setSourceRange = (item: ProjectItem, inTicks: number, outTicks: number, tol: number): boolean => {
  const order: Array<"ticks" | "time" | "seconds"> =
    inPointMode === "time" ? ["time", "ticks", "seconds"] :
    inPointMode === "seconds" ? ["seconds", "ticks", "time"] : ["ticks", "time", "seconds"];
  for (let m = 0; m < order.length; m++) {
    const conv = (t: number): any =>
      order[m] === "ticks" ? String(Math.round(t)) : order[m] === "time" ? mkTime(t) : t / 254016000000;
    try {
      (item as any).setInPoint(conv(inTicks), 4);
      (item as any).setOutPoint(conv(outTicks), 4);
      const gotIn = num((item as any).getInPoint().ticks);
      const gotOut = num((item as any).getOutPoint().ticks);
      if (Math.abs(gotIn - inTicks) <= tol && Math.abs(gotOut - outTicks) <= tol) {
        inPointMode = order[m];
        return true;
      }
    } catch (e) {
      // nächste Variante
    }
  }
  return false;
};

const deselectAll = (seq: Sequence) => {
  try {
    const sel = seq.getSelection();
    for (let i = 0; i < sel.length; i++) sel[i].setSelected(false, true);
  } catch (e) {
    // keine Auswahl
  }
};

export const acPlaceBroll = (
  sequenceId: string,
  placements: BrollPlacementTicks[],
  videoTrackIndex: number,
  fillFrame: boolean
): EnhanceResult => {
  const seq = requireActive(sequenceId);
  if (isFail(seq)) return seq;
  if (videoTrackIndex >= seq.videoTracks.numTracks) {
    return fail("Videospur V" + (videoTrackIndex + 1) + " gibt es in der Sequenz nicht. Bitte anlegen.");
  }
  const paths: string[] = [];
  for (let i = 0; i < placements.length; i++) paths.push(placements[i].path);
  const imp = importInto(BROLL_BIN, paths);

  const tol = tolerance(seq);
  const vTrack = getTrack(seq, "V", videoTrackIndex);
  const settings = seq.getSettings();
  const skipped: string[] = [];
  let applied = 0;

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const start = num(p.startTicks);
    const dur = num(p.durationTicks);
    const srcIn = num(p.sourceInTicks);
    const where = label("V", videoTrackIndex) + " bei " + tc(seq, start);
    const item = imp.items[normPath(p.path)];
    if (!item) {
      skipped.push(where + ": Datei ließ sich nicht importieren (" + p.path + ")");
      continue;
    }
    if (!trackFree(vTrack, start, start + dur, tol)) {
      skipped.push(where + ": Spur ist dort belegt");
      continue;
    }
    // Ton der B-Roll würde auf der gleichnamigen Audiospur landen – die muss frei sein
    if (p.hasAudio && videoTrackIndex < seq.audioTracks.numTracks && !trackFree(getTrack(seq, "A", videoTrackIndex), start, start + dur, tol)) {
      skipped.push(where + ": A" + (videoTrackIndex + 1) + " ist dort belegt (B-Roll-Ton würde sie überschreiben)");
      continue;
    }
    const audioBefore: { [k: string]: boolean }[] = [];
    for (let a = 0; a < seq.audioTracks.numTracks; a++) audioBefore.push(clipKeys(seq.audioTracks[a]));

    const ranged = setSourceRange(item, srcIn, srcIn + dur, tol);
    const clip = overwriteAt(vTrack, item, start, tol);
    try {
      (item as any).clearInPoint();
      (item as any).clearOutPoint();
    } catch (e) {
      // ältere Versionen
    }
    if (!clip) return fail(where + ": B-Roll ließ sich nicht korrekt platzieren. Abgebrochen.");

    // Länge prüfen, notfalls kürzen
    if (num(clip.end.ticks) - num(clip.start.ticks) > dur + tol) {
      clip.end = mkTime(start + dur);
      if (num(clip.end.ticks) - num(clip.start.ticks) > dur + tol) {
        return fail(where + ": B-Roll ließ sich nicht auf die geplante Länge kürzen" + (ranged ? "" : " (In/Out-Punkte nicht setzbar)") + ". Abgebrochen.");
      }
    }

    // B-Roll-Ton entfernen (nur das neu hinzugekommene Audio)
    const newAudio: TrackItem[] = [];
    for (let a = 0; a < seq.audioTracks.numTracks; a++) {
      const added = newClips(seq.audioTracks[a], audioBefore[a]);
      for (let k = 0; k < added.length; k++) newAudio.push(added[k]);
    }
    if (newAudio.length) {
      deselectAll(seq);
      clip.setSelected(true, true);
      seq.unlinkSelection();
      clip.setSelected(false, true);
      for (let k = 0; k < newAudio.length; k++) newAudio[k].remove(false, true);
      if (!findClipAt(vTrack, start, tol)) return fail(where + ": Beim Entfernen des B-Roll-Tons verschwand das Bild. Abgebrochen.");
    }

    if (fillFrame && p.width > 0 && p.height > 0) {
      const fill = Math.max(settings.videoFrameWidth / p.width, settings.videoFrameHeight / p.height) * 100;
      if (Math.abs(fill - 100) > 0.5) {
        const sp = motionScale(clip);
        if (typeof sp !== "string") sp.scale.setValue(fill, true);
      }
    }
    applied++;
  }
  for (let i = 0; i < imp.missing.length; i++) skipped.push("Nicht importierbar: " + imp.missing[i]);
  return { ok: true, applied, skipped };
};
