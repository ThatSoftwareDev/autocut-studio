// AutoCut Studio – Premiere-Schicht (ExtendScript, läuft IN Premiere).
//
// Grundregeln dieser Datei:
//  * Das Original wird nie verändert. Geschnitten wird nur in einer Kopie,
//    und jede schreibende Funktion prüft vorher, dass die Kopie aktiv ist.
//  * Jede Aktion wird hinterher nachgemessen; bei Abweichung wird abgebrochen.
//  * Nur ES3: keine Array-Methoden wie map/filter/indexOf/forEach verwenden.
//
// Ablauf beim Anwenden (vom Panel orchestriert, damit es Fortschritt gibt):
//  1. acCreateWorkingCopy      Sequenz duplizieren und aktivieren
//  2. acRazorBoundaries        an allen Bereichsgrenzen auf ALLEN Spuren schneiden
//  3. acCheckBoundaries        prüfen, dass kein Clip mehr über eine Grenze ragt
//  4. acRemoveRanges           Clips innerhalb der Bereiche entfernen (Lücken bleiben)
//  5. acPrepareCompaction /
//     acCompactStep            Lücken schließen: jeder Clip rückt um genau die
//                              Summe der davor entfernten Bereiche nach links
//  6. acVerify                 Positionen, Längen, Clip-Anzahl, Bild/Ton-Bezug prüfen
//
// Weil auf allen Spuren an identischen Stellen identisch viel entfernt wird,
// bleibt der zeitliche Abstand zwischen Bild und Ton überall erhalten.

import type {
  BoundaryCheck,
  ClipInfo,
  CutRangeTicks,
  Fail,
  SequenceInspection,
  StepResult,
  VerifyReport,
  WorkingCopyResult,
} from "../../shared/autocut-types";

import {
  TPS,
  fail,
  num,
  pad2,
  findSequence,
  trackCount,
  getTrack,
  label,
  tc,
  requireActive,
  isFail,
  parseRanges,
  rangeContaining,
  tolerance,
} from "./common";
import type { Kind } from "./common";

// ---------------------------------------------------------------------------
// 0. Inspektion (nur lesen)
// ---------------------------------------------------------------------------

export const acInspectActiveSequence = (audioTrackIndex: number): SequenceInspection => {
  const seq = app.project.activeSequence;
  if (!seq) {
    return fail("Keine aktive Sequenz. Öffne die Sequenz, die du schneiden willst, in der Zeitleiste.");
  }
  const vCount = trackCount(seq, "V");
  const aCount = trackCount(seq, "A");
  if (audioTrackIndex < 0 || audioTrackIndex >= aCount) {
    return fail(
      "Audiospur A" + (audioTrackIndex + 1) + " gibt es nicht – die Sequenz hat " + aCount + " Audiospur(en)."
    );
  }
  const tpf = num(seq.timebase);
  if (!(tpf > 0)) return fail("Die Bildrate der Sequenz konnte nicht gelesen werden.");

  const blockers: string[] = [];
  const warnings: string[] = [];

  const kinds: Kind[] = ["V", "A"];
  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k];
    for (let i = 0; i < trackCount(seq, kind); i++) {
      const track = getTrack(seq, kind, i);
      if (track.isLocked()) {
        blockers.push(
          "Spur " + label(kind, i) + " ist gesperrt. Bitte entsperren – sonst würde sie nicht mitgeschnitten und Bild/Ton liefen auseinander."
        );
      }
      if (track.transitions && track.transitions.numItems > 0) {
        blockers.push(
          "Spur " + label(kind, i) + " enthält Übergänge. Bitte für den Stille-Schnitt entfernen (Übergänge später setzen)."
        );
      }
    }
  }

  const track = getTrack(seq, "A", audioTrackIndex);
  if (track.isMuted()) {
    warnings.push("A" + (audioTrackIndex + 1) + " ist stummgeschaltet – analysiert wird trotzdem das Audio der Clips.");
  }
  const clips: ClipInfo[] = [];
  for (let i = 0; i < track.clips.numItems; i++) {
    const c = track.clips[i];
    const name = String(c.name);
    if (c.disabled) {
      warnings.push("„" + name + "“ ist deaktiviert und wird nicht analysiert (dort wird nicht geschnitten).");
      continue;
    }
    const pi = c.projectItem;
    const path = pi ? String(pi.getMediaPath() || "") : "";
    if (!path) {
      blockers.push(
        "„" + name + "“ auf A" + (audioTrackIndex + 1) + " hat keine Mediendatei (verschachtelte Sequenz, Mehrkamera oder Grafik?). Das wird noch nicht unterstützt."
      );
      continue;
    }
    let speed = 1;
    let reversed = 0;
    try {
      speed = c.getSpeed();
      reversed = c.isSpeedReversed();
    } catch (e) {
      // ältere Versionen: Geschwindigkeit nicht lesbar -> als normal annehmen
    }
    if (Math.abs(speed - 1) > 0.0001 || reversed) {
      blockers.push("„" + name + "“ hat eine geänderte Geschwindigkeit/Umkehrung – dafür passen die Zeitstempel nicht.");
      continue;
    }
    clips.push({
      clipId: String(c.nodeId),
      name,
      mediaPath: path,
      seqStartTicks: String(c.start.ticks),
      seqEndTicks: String(c.end.ticks),
      sourceInTicks: String(c.inPoint.ticks),
    });
  }
  if (clips.length === 0 && blockers.length === 0) {
    blockers.push("Auf A" + (audioTrackIndex + 1) + " liegen keine (aktivierten) Clips mit Audio.");
  }

  return {
    ok: true,
    sequenceId: seq.sequenceID,
    sequenceName: String(seq.name),
    ticksPerFrame: String(tpf),
    endTicks: String(seq.end),
    videoTrackCount: vCount,
    audioTrackCount: aCount,
    analysisTrackIndex: audioTrackIndex,
    clips,
    blockers,
    warnings,
  };
};

/** Abspielposition setzen (Vorschau „hinspringen“). Verändert nichts am Schnitt. */
export const acSetPlayhead = (sequenceId: string, ticks: string): { ok: true } | Fail => {
  const seq = findSequence(sequenceId);
  if (!seq) return fail("Sequenz nicht gefunden.");
  const active = app.project.activeSequence;
  if (!active || active.sequenceID !== sequenceId) app.project.openSequence(sequenceId);
  seq.setPlayerPosition(ticks);
  return { ok: true };
};

// ---------------------------------------------------------------------------
// 1. Arbeitskopie
// ---------------------------------------------------------------------------

const clipCount = (seq: Sequence): number => {
  let n = 0;
  for (let i = 0; i < seq.videoTracks.numTracks; i++) n += seq.videoTracks[i].clips.numItems;
  for (let i = 0; i < seq.audioTracks.numTracks; i++) n += seq.audioTracks[i].clips.numItems;
  return n;
};

export const acCreateWorkingCopy = (sequenceId: string): WorkingCopyResult => {
  const orig = findSequence(sequenceId);
  if (!orig) return fail("Die Originalsequenz wurde nicht gefunden.");

  const before: { [id: string]: boolean } = {};
  const seqs = app.project.sequences;
  for (let i = 0; i < seqs.numSequences; i++) before[(seqs as any)[i].sequenceID] = true;

  orig.clone();

  let copy: Sequence | null = null;
  const after = app.project.sequences;
  for (let i = 0; i < after.numSequences; i++) {
    const s = (after as any)[i] as Sequence;
    if (!before[s.sequenceID]) copy = s;
  }
  if (!copy) return fail("Premiere hat keine Kopie der Sequenz erstellt. Es wurde nichts verändert.");

  const d = new Date();
  const stamp =
    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
    pad2(d.getHours()) + "." + pad2(d.getMinutes()) + "." + pad2(d.getSeconds());
  copy.name = String(orig.name) + " – AutoCut " + stamp;

  if (String(copy.end) !== String(orig.end) || clipCount(copy) !== clipCount(orig)) {
    return fail(
      "Die Kopie „" + copy.name + "“ weicht vom Original ab (Länge/Clip-Anzahl). Abgebrochen – bitte die Kopie löschen."
    );
  }

  app.project.openSequence(copy.sequenceID);
  if (!app.project.activeSequence || app.project.activeSequence.sequenceID !== copy.sequenceID) {
    app.project.activeSequence = copy;
  }
  if (!app.project.activeSequence || app.project.activeSequence.sequenceID !== copy.sequenceID) {
    return fail("Kopie „" + copy.name + "“ erstellt, aber sie ließ sich nicht aktivieren. Bitte öffne sie und starte erneut.");
  }
  return { ok: true, sequenceId: copy.sequenceID, name: String(copy.name) };
};

// ---------------------------------------------------------------------------
// 2. Schneiden (Rasierklinge über die QE-Schnittstelle)
// ---------------------------------------------------------------------------

export const acRazorBoundaries = (sequenceId: string, boundaryTicks: string[]): StepResult => {
  const seq = requireActive(sequenceId);
  if (isFail(seq)) return seq;

  app.enableQE();
  const q: any = qe;
  const qSeq = q && q.project ? q.project.getActiveSequence() : null;
  if (!qSeq) return fail("Die QE-Schnittstelle von Premiere ist nicht erreichbar.");
  if (typeof qSeq.name !== "undefined" && String(qSeq.name) !== String(seq.name)) {
    return fail("Interne Sequenz stimmt nicht mit der Arbeitskopie überein – abgebrochen, um nichts Falsches zu schneiden.");
  }

  const settings = seq.getSettings();
  const endTicks = num(seq.end);
  const vCount = trackCount(seq, "V");
  const aCount = trackCount(seq, "A");
  let done = 0;
  for (let i = 0; i < boundaryTicks.length; i++) {
    const ticks = num(boundaryTicks[i]);
    done++;
    if (ticks <= 0 || ticks >= endTicks) continue; // Rand der Sequenz: nichts zu schneiden
    const t = new Time();
    t.ticks = String(ticks);
    const timecode = String(t.getFormatted(settings.videoFrameRate, settings.videoDisplayFormat as any));
    for (let v = 0; v < vCount; v++) qSeq.getVideoTrackAt(v).razor(timecode);
    for (let a = 0; a < aCount; a++) qSeq.getAudioTrackAt(a).razor(timecode);
  }
  return { ok: true, done, total: boundaryTicks.length };
};

export const acCheckBoundaries = (sequenceId: string, ranges: CutRangeTicks[]): BoundaryCheck => {
  const seq = requireActive(sequenceId);
  if (isFail(seq)) return seq;
  const tol = tolerance(seq);
  const rs = parseRanges(ranges);
  const problems: string[] = [];
  const kinds: Kind[] = ["V", "A"];
  for (let k = 0; k < kinds.length; k++) {
    for (let i = 0; i < trackCount(seq, kinds[k]); i++) {
      const clips = getTrack(seq, kinds[k], i).clips;
      for (let c = 0; c < clips.numItems; c++) {
        const s = num(clips[c].start.ticks);
        const e = num(clips[c].end.ticks);
        for (let r = 0; r < rs.length; r++) {
          if (rs[r].a > e) break;
          const crossesA = s < rs[r].a - tol && e > rs[r].a + tol;
          const crossesB = s < rs[r].b - tol && e > rs[r].b + tol;
          if (crossesA || crossesB) {
            if (problems.length < 15) {
              problems.push(
                "Spur " + label(kinds[k], i) + ": Clip ragt über die Schnittstelle bei " +
                  tc(seq, crossesA ? rs[r].a : rs[r].b) + " (Schnitt wurde nicht gesetzt)."
              );
            }
            break;
          }
        }
      }
    }
  }
  return { ok: true, problems };
};

// ---------------------------------------------------------------------------
// 3. Entfernen (ohne Ripple – Lücken werden in Schritt 4 kontrolliert geschlossen)
// ---------------------------------------------------------------------------

export const acRemoveRanges = (sequenceId: string, ranges: CutRangeTicks[]): StepResult => {
  const seq = requireActive(sequenceId);
  if (isFail(seq)) return seq;
  const tol = tolerance(seq);
  const rs = parseRanges(ranges);
  const kinds: Kind[] = ["V", "A"];
  let removed = 0;

  // Mehrere Durchgänge: Premiere entfernt verknüpfte Partner (Bild+Ton) oft
  // gleich mit, wodurch gesammelte Referenzen ungültig werden.
  for (let pass = 0; pass < 4; pass++) {
    const toRemove: TrackItem[] = [];
    for (let k = 0; k < kinds.length; k++) {
      for (let i = 0; i < trackCount(seq, kinds[k]); i++) {
        const clips = getTrack(seq, kinds[k], i).clips;
        for (let c = 0; c < clips.numItems; c++) {
          const s = num(clips[c].start.ticks);
          const e = num(clips[c].end.ticks);
          if (rangeContaining(rs, s, e, tol) >= 0) toRemove.push(clips[c]);
        }
      }
    }
    if (toRemove.length === 0) return { ok: true, done: removed, total: removed };
    for (let j = 0; j < toRemove.length; j++) {
      try {
        if (toRemove[j].remove(false, true) !== false) removed++;
      } catch (e) {
        // bereits mit dem verknüpften Partner entfernt
      }
    }
  }
  return fail("Einige Clip-Stücke in den Stille-Bereichen ließen sich nicht entfernen. Abgebrochen – bitte die Arbeitskopie löschen.");
};

// ---------------------------------------------------------------------------
// 4. Lücken schließen
// ---------------------------------------------------------------------------

type PlanItem = {
  kind: Kind;
  track: number;
  origStart: number;
  duration: number;
  expectedStart: number;
};

type Compaction = {
  sequenceId: string;
  items: PlanItem[];
  next: number;
  tol: number;
  moveMode: "" | "time" | "seconds";
  expectedEnd: number;
  perTrack: { [label: string]: number };
  misalignedLinksBefore: number;
};

let compaction: Compaction | null = null;

/** Wie viele verknüpfte Bild/Ton-Paare haben unterschiedliche Start/Endzeiten? */
const countMisalignedLinks = (seq: Sequence, tol: number): { checked: number; misaligned: number } => {
  let checked = 0;
  let misaligned = 0;
  for (let i = 0; i < seq.videoTracks.numTracks; i++) {
    const clips = seq.videoTracks[i].clips;
    for (let c = 0; c < clips.numItems; c++) {
      const v = clips[c];
      let links: TrackItemCollection | null = null;
      try {
        links = v.getLinkedItems();
      } catch (e) {
        links = null;
      }
      if (!links) continue;
      for (let l = 0; l < links.numItems; l++) {
        const it = links[l];
        if (String(it.mediaType) !== "Audio") continue;
        checked++;
        if (
          Math.abs(num(it.start.ticks) - num(v.start.ticks)) > tol ||
          Math.abs(num(it.end.ticks) - num(v.end.ticks)) > tol
        ) {
          misaligned++;
        }
      }
    }
  }
  return { checked, misaligned };
};

export const acPrepareCompaction = (sequenceId: string, ranges: CutRangeTicks[]): StepResult => {
  const seq = requireActive(sequenceId);
  if (isFail(seq)) return seq;
  const tol = tolerance(seq);
  const rs = parseRanges(ranges);

  // Präfixsummen: wie viel wurde VOR einer Zeit insgesamt entfernt?
  const prefix: number[] = [0];
  for (let r = 0; r < rs.length; r++) prefix.push(prefix[r] + (rs[r].b - rs[r].a));
  const removedBefore = (t: number): number => {
    // größter Bereich mit Ende <= t
    let lo = 0;
    let hi = rs.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rs[mid].b <= t + tol) {
        k = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return prefix[k + 1];
  };

  const items: PlanItem[] = [];
  const perTrack: { [label: string]: number } = {};
  let expectedEnd = 0;
  const kinds: Kind[] = ["V", "A"];
  for (let k = 0; k < kinds.length; k++) {
    for (let i = 0; i < trackCount(seq, kinds[k]); i++) {
      const clips = getTrack(seq, kinds[k], i).clips;
      perTrack[label(kinds[k], i)] = clips.numItems;
      for (let c = 0; c < clips.numItems; c++) {
        const s = num(clips[c].start.ticks);
        const e = num(clips[c].end.ticks);
        if (rangeContaining(rs, s, e, tol) >= 0) {
          return fail("In einem Stille-Bereich liegt noch ein Clip (" + label(kinds[k], i) + ", " + tc(seq, s) + "). Abgebrochen.");
        }
        const expectedStart = s - removedBefore(s);
        items.push({ kind: kinds[k], track: i, origStart: s, duration: e - s, expectedStart });
        if (expectedStart + (e - s) > expectedEnd) expectedEnd = expectedStart + (e - s);
      }
    }
  }
  items.sort((x, y) => x.origStart - y.origStart || (x.kind === y.kind ? x.track - y.track : x.kind === "V" ? -1 : 1));

  compaction = {
    sequenceId,
    items,
    next: 0,
    tol,
    moveMode: "",
    expectedEnd,
    perTrack,
    misalignedLinksBefore: countMisalignedLinks(seq, tol).misaligned,
  };
  return { ok: true, done: 0, total: items.length };
};

const findPlanned = (track: Track, item: PlanItem, tol: number): { clip: TrackItem; atTarget: boolean } | null => {
  const clips = track.clips;
  for (let c = 0; c < clips.numItems; c++) {
    const s = num(clips[c].start.ticks);
    const d = num(clips[c].end.ticks) - s;
    if (Math.abs(d - item.duration) > tol) continue;
    if (Math.abs(s - item.expectedStart) <= tol) return { clip: clips[c], atTarget: true };
    if (Math.abs(s - item.origStart) <= tol) return { clip: clips[c], atTarget: false };
  }
  return null;
};

/** Verschiebt um deltaTicks und misst nach. Erkennt einmalig, welche Art von
 *  Argument diese Premiere-Version für TrackItem.move() erwartet. */
const moveBy = (clip: TrackItem, target: number, state: Compaction): boolean => {
  const modes: Array<"time" | "seconds"> =
    state.moveMode === "seconds" ? ["seconds", "time"] : ["time", "seconds"];
  for (let m = 0; m < modes.length; m++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = num(clip.start.ticks);
      const delta = target - current;
      if (Math.abs(delta) <= state.tol) return true;
      try {
        if (modes[m] === "time") {
          const t = new Time();
          t.ticks = String(delta);
          (clip as any).move(t);
        } else {
          (clip as any).move(delta / TPS);
        }
      } catch (e) {
        break; // diese Variante wird nicht unterstützt
      }
      const after = num(clip.start.ticks);
      if (Math.abs(after - target) <= state.tol) {
        state.moveMode = modes[m];
        return true;
      }
      if (Math.abs(after - current) <= state.tol) break; // Variante ohne Wirkung
    }
  }
  return false;
};

export const acCompactStep = (sequenceId: string, maxItems: number): StepResult => {
  const seq = requireActive(sequenceId);
  if (isFail(seq)) return seq;
  const st = compaction;
  if (!st || st.sequenceId !== sequenceId) return fail("Interner Zustand fehlt – bitte den Vorgang neu starten.");
  const end = Math.min(st.items.length, st.next + Math.max(1, maxItems));
  for (let k = st.next; k < end; k++) {
    const item = st.items[k];
    const found = findPlanned(getTrack(seq, item.kind, item.track), item, st.tol);
    if (!found) {
      return fail("Clip auf " + label(item.kind, item.track) + " bei " + tc(seq, item.origStart) + " nicht mehr auffindbar. Abgebrochen – bitte die Arbeitskopie löschen.");
    }
    if (found.atTarget) continue; // z. B. vom verknüpften Partner bereits mitbewegt
    if (!moveBy(found.clip, item.expectedStart, st)) {
      return fail("Premiere hat einen Clip auf " + label(item.kind, item.track) + " bei " + tc(seq, item.origStart) + " nicht korrekt verschoben. Abgebrochen – bitte die Arbeitskopie löschen.");
    }
    const newDur = num(found.clip.end.ticks) - num(found.clip.start.ticks);
    if (Math.abs(newDur - item.duration) > st.tol) {
      return fail("Ein Clip hat sich beim Verschieben verändert (" + label(item.kind, item.track) + ", " + tc(seq, item.origStart) + "). Abgebrochen.");
    }
  }
  st.next = end;
  return { ok: true, done: st.next, total: st.items.length };
};

// ---------------------------------------------------------------------------
// 5. Prüfen
// ---------------------------------------------------------------------------

export const acVerify = (sequenceId: string): VerifyReport => {
  const seq = requireActive(sequenceId);
  if (isFail(seq)) return seq;
  const st = compaction;
  if (!st || st.sequenceId !== sequenceId) return fail("Interner Zustand fehlt – bitte den Vorgang neu starten.");
  const problems: string[] = [];

  let checkedClips = 0;
  for (let k = 0; k < st.items.length; k++) {
    const item = st.items[k];
    const found = findPlanned(getTrack(seq, item.kind, item.track), item, st.tol);
    checkedClips++;
    if (!found || !found.atTarget) {
      if (problems.length < 15) {
        problems.push("Clip auf " + label(item.kind, item.track) + " (vorher bei " + tc(seq, item.origStart) + ") steht nicht an der erwarteten Stelle.");
      }
    }
  }
  for (const key in st.perTrack) {
    const kind = key.charAt(0) as Kind;
    const idx = Number(key.substring(1)) - 1;
    const now = getTrack(seq, kind, idx).clips.numItems;
    if (now !== st.perTrack[key]) {
      problems.push("Spur " + key + " hat jetzt " + now + " statt " + st.perTrack[key] + " Clip-Stücke.");
    }
  }
  const links = countMisalignedLinks(seq, st.tol);
  if (links.misaligned > st.misalignedLinksBefore) {
    problems.push((links.misaligned - st.misalignedLinksBefore) + " verknüpfte Bild/Ton-Paare sind gegeneinander verschoben.");
  }
  const actualEnd = num(seq.end);
  if (Math.abs(actualEnd - st.expectedEnd) > st.tol) {
    problems.push("Sequenzlänge ist " + tc(seq, actualEnd) + ", erwartet war " + tc(seq, st.expectedEnd) + ".");
  }

  return {
    ok: true,
    passed: problems.length === 0,
    problems,
    expectedEndTicks: String(st.expectedEnd),
    actualEndTicks: String(actualEnd),
    checkedClips,
    checkedLinks: links.checked,
  };
};
