// Ablauf: Analysieren -> (Transkribieren) -> Vorschau prüfen -> auf Kopie anwenden.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipInfo, SequenceInspection } from "../../shared/autocut-types";
import { applyEnhancements, type EnhanceOutcome, type EnhancePlan } from "../lib/applyEnhancements";
import { applySilenceCuts, framesToTickRanges, type ApplyOutcome } from "../lib/applySilenceCuts";
import { fileExists } from "../lib/files";
import { cepPremiere } from "../lib/premiere";
import type { Settings } from "../lib/settings";
import {
  sidecar,
  SidecarError,
  type BrollScan,
  type ClipPayload,
  type PlanRequest,
  type PlanResponse,
  type SilenceAnalysis,
} from "../lib/sidecar";
import { BrollPanel, type TranscriptState } from "./BrollPanel";
import { fmtSeconds, fmtTime } from "./format";
import { CutList, SilenceSettings } from "./SilencePanel";
import { resolvedSwooshPath, ZoomPanel } from "./ZoomPanel";

type Inspection = Extract<SequenceInspection, { ok: true }>;
type Analysis = { inspection: Inspection; result: SilenceAnalysis; paramsKey: string; fingerprint: string };
type Progress = { phase: string; done: number; total: number };

const TPS = 254016000000;

const paramsKeyOf = (s: Settings) =>
  JSON.stringify([s.analysisTrackIndex, s.thresholdDb, s.paddingInMs, s.paddingOutMs, s.minSilenceMs, s.hysteresisDb]);

const fingerprintOf = (i: Inspection) =>
  [i.sequenceId, i.endTicks, i.ticksPerFrame, i.videoTrackCount, i.audioTrackCount]
    .concat(i.clips.map((c: ClipInfo) => [c.mediaPath, c.seqStartTicks, c.seqEndTicks, c.sourceInTicks].join("|")))
    .join("#");

const clipsPayload = (i: Inspection): ClipPayload[] =>
  i.clips.map((c) => ({
    clip_id: c.clipId,
    name: c.name,
    media_path: c.mediaPath,
    seq_start_ticks: c.seqStartTicks,
    seq_end_ticks: c.seqEndTicks,
    source_in_ticks: c.sourceInTicks,
  }));

const errText = (e: any) => (e instanceof SidecarError ? e.message : String(e?.message ?? e));

type Props = {
  settings: Settings;
  onSettings: (s: Settings) => void;
  helperReady: boolean;
  whisperModels: string[];
};

export const Workflow = ({ settings, onSettings, helperReady, whisperModels }: Props) => {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [selected, setSelected] = useState<boolean[]>([]);
  const [busy, setBusy] = useState<"" | "analyze" | "apply">("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cutOutcome, setCutOutcome] = useState<ApplyOutcome | null>(null);
  const [enhanceOutcome, setEnhanceOutcome] = useState<EnhanceOutcome | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [transcript, setTranscript] = useState<TranscriptState>({ state: "none" });
  const [scan, setScan] = useState<BrollScan | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [plan, setPlan] = useState<{ key: string; data: PlanResponse } | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [zoomSel, setZoomSel] = useState<boolean[]>([]);
  const [brollSel, setBrollSel] = useState<boolean[]>([]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onSettings({ ...settings, [key]: value });
  const stale = analysis !== null && analysis.paramsKey !== paramsKeyOf(settings);
  const transcriptValid =
    transcript.state === "done" && analysis !== null && transcript.fingerprint === analysis.fingerprint;
  const tpf = analysis ? Number(analysis.inspection.ticksPerFrame) : 0;
  const fps = tpf ? TPS / tpf : 25;
  const swooshPath = resolvedSwooshPath(settings);
  const swooshActive = settings.zoomEnabled && settings.swooshEnabled && fileExists(swooshPath);

  // ------------------------------------------------------------- Plan
  const planRequest: PlanRequest | null = useMemo(() => {
    if (!analysis || stale) return null;
    if (!settings.zoomEnabled && !settings.brollEnabled) return null;
    const brollReady = settings.brollEnabled && !!settings.brollFolder && transcriptValid;
    if (!settings.zoomEnabled && !brollReady) return null;
    return {
      ticks_per_frame: analysis.inspection.ticksPerFrame,
      threshold_db: settings.thresholdDb,
      clips: clipsPayload(analysis.inspection),
      cuts: analysis.result.cuts.filter((_, i) => selected[i]).map((c) => ({ start_frame: c.start_frame, end_frame: c.end_frame })),
      zoom: {
        enabled: settings.zoomEnabled,
        mode: settings.zoomMode,
        strength_pct: settings.zoomStrengthPct,
        ease: settings.zoomEase,
        min_gap_s: settings.zoomMinGapS,
        slow_min_segment_s: settings.slowMinSegmentS,
        punch_hold_s: settings.punchHoldS,
        punch_ramp_s: 0.2,
        punch_prominence_db: settings.punchProminenceDb,
      },
      swoosh: { enabled: swooshActive, path: swooshPath, offset_ms: settings.swooshOffsetMs },
      broll: {
        enabled: brollReady,
        folder: settings.brollFolder,
        transcript_id: transcript.state === "done" ? transcript.id : null,
        clip_length_s: settings.brollClipLengthS,
        min_gap_s: settings.brollMinGapS,
        lead_s: settings.brollLeadS,
        reuse: settings.brollReuse,
      },
    };
  }, [analysis, stale, settings, selected, transcript, transcriptValid, swooshActive, swooshPath]);

  const planKey = planRequest ? JSON.stringify(planRequest) : "";
  const planCurrent = plan !== null && plan.key === planKey;
  const reqCounter = useRef(0);

  useEffect(() => {
    if (!planRequest || !helperReady) {
      setPlanError(null);
      return;
    }
    if (plan && plan.key === planKey) return;
    const myReq = ++reqCounter.current;
    const timer = setTimeout(async () => {
      setPlanBusy(true);
      try {
        const data = await sidecar.plan(planRequest);
        if (myReq !== reqCounter.current) return;
        setPlan({ key: planKey, data });
        setZoomSel(data.zoom.events.map(() => true));
        setBrollSel(data.broll.placements.map(() => true));
        setPlanError(null);
      } catch (e) {
        if (myReq === reqCounter.current) setPlanError(errText(e));
      } finally {
        if (myReq === reqCounter.current) setPlanBusy(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [planKey, helperReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Swoosh-Zeitpunkte aus den AUSGEWÄHLTEN Zooms (überlappende fallen weg)
  const swooshFrames = useMemo(() => {
    if (!planCurrent || !plan || !swooshActive || !plan.data.swoosh.duration_frames) return [];
    const dur = plan.data.swoosh.duration_frames;
    const offset = Math.round((settings.swooshOffsetMs / 1000) * fps);
    const out: number[] = [];
    let lastEnd = -Infinity;
    plan.data.zoom.events.forEach((ev, i) => {
      if (!zoomSel[i] || ev.swoosh_frame === null) return;
      const f = Math.max(0, ev.swoosh_frame + offset);
      if (f < lastEnd) return;
      out.push(f);
      lastEnd = f + dur;
    });
    return out;
  }, [plan, planCurrent, zoomSel, swooshActive, settings.swooshOffsetMs, fps]);

  // ------------------------------------------------------------- Aktionen
  const analyze = async () => {
    setError(null);
    setCutOutcome(null);
    setEnhanceOutcome(null);
    setBlockers([]);
    setBusy("analyze");
    try {
      const insp = await cepPremiere.inspectActiveSequence(settings.analysisTrackIndex);
      if (!insp.ok) {
        setError(insp.error);
        setAnalysis(null);
        return;
      }
      if (insp.blockers.length) {
        setBlockers(insp.blockers);
        setAnalysis(null);
        return;
      }
      const result = await sidecar.analyzeSilence({
        ticks_per_frame: insp.ticksPerFrame,
        threshold_db: settings.thresholdDb,
        padding_in_s: settings.paddingInMs / 1000,
        padding_out_s: settings.paddingOutMs / 1000,
        min_silence_s: settings.minSilenceMs / 1000,
        hysteresis_db: settings.hysteresisDb,
        clips: clipsPayload(insp),
      });
      if (Number(result.ticks_per_frame) !== Number(insp.ticksPerFrame)) {
        setError("Interner Fehler: Bildrate von Helfer und Sequenz passt nicht zusammen. Nichts wurde verändert.");
        return;
      }
      result.warnings = [...insp.warnings, ...result.warnings];
      setAnalysis({ inspection: insp, result, paramsKey: paramsKeyOf(settings), fingerprint: fingerprintOf(insp) });
      setSelected(result.cuts.map(() => true));
    } catch (e) {
      setError(`Analyse fehlgeschlagen: ${errText(e)}`);
      setAnalysis(null);
    } finally {
      setBusy("");
    }
  };

  const transcribe = async () => {
    if (!analysis) return;
    const fp = analysis.fingerprint;
    setTranscript({ state: "running", progress: 0, message: "Starte …" });
    try {
      const { job_id } = await sidecar.transcribeStart(
        clipsPayload(analysis.inspection),
        settings.whisperModel,
        settings.language
      );
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const j = await sidecar.job(job_id);
        if (j.state === "done" && j.result) {
          setTranscript({
            state: "done",
            id: j.result.transcript_id,
            fingerprint: fp,
            wordCount: j.result.word_count,
            jsonPath: j.result.json_path,
            preview: j.result.preview.slice(0, 160),
          });
          return;
        }
        if (j.state === "error") {
          setTranscript({ state: "error", message: j.message });
          return;
        }
        setTranscript({ state: "running", progress: j.progress, message: j.message });
      }
    } catch (e) {
      setTranscript({ state: "error", message: errText(e) });
    }
  };

  const doScan = async () => {
    setScanError(null);
    try {
      setScan(await sidecar.brollScan(settings.brollFolder));
    } catch (e) {
      setScan(null);
      setScanError(errText(e));
    }
  };

  const jumpTo = async (startFrame: number, sequenceId?: string) => {
    if (!analysis) return;
    const preRoll = Math.round(fps);
    const res = await cepPremiere.setPlayhead(
      sequenceId ?? analysis.inspection.sequenceId,
      String(Math.max(0, startFrame - preRoll) * tpf)
    );
    if (!res.ok) setError(res.error);
  };

  const enhancePlan = (): EnhancePlan | null => {
    if (!plan || !planCurrent) return null;
    const d = plan.data;
    const zoomEvents = settings.zoomEnabled ? d.zoom.events.filter((_, i) => zoomSel[i]) : [];
    const brolls = settings.brollEnabled ? d.broll.placements.filter((_, i) => brollSel[i]) : [];
    return {
      ticksPerFrame: tpf,
      zoom: zoomEvents.length ? { events: zoomEvents, videoTrackIndex: 0 } : null,
      broll: brolls.length
        ? { placements: brolls, videoTrackIndex: settings.brollTrackIndex, fillFrame: settings.brollFillFrame }
        : null,
      swoosh: swooshFrames.length
        ? { path: swooshPath, durationFrames: d.swoosh.duration_frames, frames: swooshFrames, audioTrackIndex: settings.swooshTrackIndex }
        : null,
    };
  };

  const apply = async () => {
    if (!analysis) return;
    setConfirmOpen(false);
    setError(null);
    setCutOutcome(null);
    setEnhanceOutcome(null);
    setBusy("apply");
    try {
      const now = await cepPremiere.inspectActiveSequence(analysis.inspection.analysisTrackIndex);
      if (!now.ok) return setError(now.error);
      if (now.sequenceId !== analysis.inspection.sequenceId) {
        return setError(`Bitte aktiviere wieder die analysierte Sequenz „${analysis.inspection.sequenceName}“ in der Zeitleiste.`);
      }
      if (fingerprintOf(now) !== analysis.fingerprint) {
        return setError("Die Sequenz wurde seit der Analyse verändert. Bitte neu analysieren – es wurde nichts geschnitten.");
      }
      const ep = enhancePlan();
      const cuts = analysis.result.cuts.filter((_, i) => selected[i]);
      const cutResult = await applySilenceCuts(cepPremiere, analysis.inspection.sequenceId, framesToTickRanges(cuts, tpf), setProgress);
      setCutOutcome(cutResult);
      if (!cutResult.ok || !cutResult.report.passed) return;
      if (ep && (ep.zoom || ep.broll || ep.swoosh)) {
        setEnhanceOutcome(await applyEnhancements(cepPremiere, cutResult.copyId, ep, setProgress));
      }
      setAnalysis(null); // verhindert doppeltes Anwenden
      setPlan(null);
    } catch (e) {
      setError(`Anwenden fehlgeschlagen: ${errText(e)}`);
    } finally {
      setBusy("");
      setProgress(null);
    }
  };

  // ------------------------------------------------------------- Anzeige
  const r = analysis?.result;
  const cutCount = r ? r.cuts.filter((_, i) => selected[i]).length : 0;
  const cutSeconds = r ? r.cuts.reduce((s, c, i) => s + (selected[i] ? c.duration_s : 0), 0) : 0;
  const needsPlan = !!analysis && (settings.zoomEnabled || (settings.brollEnabled && transcriptValid));
  const zoomCount = planCurrent && plan ? zoomSel.filter(Boolean).length : 0;
  const brollCount = planCurrent && plan ? brollSel.filter(Boolean).length : 0;
  const somethingToDo = cutCount > 0 || zoomCount > 0 || brollCount > 0;
  const canApply =
    !!analysis && !stale && busy === "" && helperReady && somethingToDo && (!needsPlan || (planCurrent && !planBusy));
  const disabled = busy !== "";

  return (
    <>
      <section className="card">
        <h2>Stille entfernen</h2>
        <SilenceSettings
          settings={settings}
          set={set}
          disabled={disabled}
          audioTrackCount={analysis?.inspection.audioTrackCount ?? 0}
        />
        <button className="primary" onClick={analyze} disabled={disabled || !helperReady}>
          {busy === "analyze" ? "Analysiere …" : analysis ? "Neu analysieren" : "Aktive Sequenz analysieren"}
        </button>
        <p className="hint">Die Analyse liest nur – an deiner Sequenz ändert sich dabei nichts.</p>
        {error && <div className="msg error">{error}</div>}
        {blockers.length > 0 && (
          <div className="msg error">
            <strong>So kann ich nicht sicher schneiden:</strong>
            <ul>
              {blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        )}
        {stale && <div className="msg warn">Einstellungen geändert – bitte neu analysieren, bevor du anwendest.</div>}
        {r && (
          <CutList
            result={r}
            selected={selected}
            setSelected={setSelected}
            onJump={(f) => jumpTo(f)}
            thresholdDb={settings.thresholdDb}
            onUseSuggestion={(db) => set("thresholdDb", db)}
          />
        )}
      </section>

      <ZoomPanel settings={settings} set={set} disabled={disabled} />

      <BrollPanel
        settings={settings}
        set={set}
        disabled={disabled}
        models={whisperModels}
        scan={scan}
        scanError={scanError}
        onScan={doScan}
        transcript={transcript}
        transcriptValid={transcriptValid}
        canTranscribe={!!analysis && helperReady}
        onTranscribe={transcribe}
      />

      {analysis && (
        <section className="card">
          <h2>Vorschau &amp; Anwenden</h2>
          <p className="hint small">
            Zeiten in dieser Vorschau beziehen sich auf die <b>geschnittene Kopie</b>.
          </p>
          {planBusy && <p className="hint">Berechne Zooms/B-Roll …</p>}
          {planError && <div className="msg error">{planError}</div>}
          {planCurrent && plan && plan.data.warnings.length > 0 && (
            <div className="msg warn">
              <ul>
                {plan.data.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {settings.brollEnabled && !transcriptValid && (
            <p className="hint">B-Roll: erst transkribieren, dann erscheinen hier die Vorschläge.</p>
          )}

          {planCurrent && plan && settings.zoomEnabled && (
            <>
              <div className="summary">
                <span>
                  <b>{zoomCount}</b> Zooms{swooshActive ? ` · ${swooshFrames.length} Swooshes` : ""}
                  {settings.swooshEnabled && !swooshActive ? " · Swoosh-Datei fehlt" : ""}
                </span>
              </div>
              {plan.data.zoom.events.length > 0 && (
                <ol className="cuts">
                  {plan.data.zoom.events.map((ev, i) => (
                    <li key={i} className={zoomSel[i] ? "zoomrow" : "zoomrow off"}>
                      <input
                        type="checkbox"
                        checked={!!zoomSel[i]}
                        onChange={(e: { target: { checked: boolean } }) => {
                          const n = [...zoomSel];
                          n[i] = e.target.checked;
                          setZoomSel(n);
                        }}
                      />
                      <span className="tc">{fmtTime((ev.kind === "keys" ? ev.keys[0].frame : ev.piece_new_start) / fps)}</span>
                      <span>{ev.label}</span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}

          {planCurrent && plan && settings.brollEnabled && transcriptValid && (
            <>
              <div className="summary">
                <span>
                  <b>{brollCount}</b> B-Rolls aus {plan.data.broll.files} Clips
                </span>
              </div>
              {plan.data.broll.placements.length > 0 && (
                <ol className="cuts">
                  {plan.data.broll.placements.map((p, i) => (
                    <li key={i} className={brollSel[i] ? "brollrow" : "brollrow off"}>
                      <input
                        type="checkbox"
                        checked={!!brollSel[i]}
                        onChange={(e: { target: { checked: boolean } }) => {
                          const n = [...brollSel];
                          n[i] = e.target.checked;
                          setBrollSel(n);
                        }}
                      />
                      <span className="tc">{fmtTime(p.start_frame / fps)}</span>
                      <span title={p.path}>
                        „{p.word}“ → {p.file}
                      </span>
                      <span className="dur">{fmtSeconds((p.end_frame - p.start_frame) / fps, 1)}</span>
                    </li>
                  ))}
                </ol>
              )}
              {plan.data.broll.warnings.length > 0 && (
                <details className="hint small">
                  <summary>{plan.data.broll.warnings.length} Hinweise zum B-Roll-Ordner</summary>
                  <ul>
                    {plan.data.broll.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}

          {!confirmOpen ? (
            <button className="primary" disabled={!canApply} onClick={() => setConfirmOpen(true)}>
              Auf Kopie anwenden …
            </button>
          ) : (
            <div className="confirm">
              <p>
                Ich erstelle eine <b>Kopie</b> von „{analysis.inspection.sequenceName}“ und mache dort:
              </p>
              <ul>
                <li>
                  {cutCount} Pausen entfernen ({fmtSeconds(cutSeconds, 1)}) auf allen Spuren
                </li>
                {zoomCount > 0 && <li>{zoomCount} Zooms auf V1</li>}
                {swooshFrames.length > 0 && (
                  <li>
                    {swooshFrames.length} Swooshes auf A{settings.swooshTrackIndex + 1}
                  </li>
                )}
                {brollCount > 0 && (
                  <li>
                    {brollCount} B-Rolls auf V{settings.brollTrackIndex + 1} (ohne Ton)
                  </li>
                )}
              </ul>
              <p>Das Original bleibt unverändert.</p>
              <div className="row">
                <button onClick={() => setConfirmOpen(false)}>Abbrechen</button>
                <button className="primary" onClick={apply}>
                  Ja, anwenden
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {progress && (
        <div className="progress">
          <div className="label">{progress.phase}</div>
          <div className="bar">
            <div style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
          </div>
        </div>
      )}

      <Outcome cut={cutOutcome} enhance={enhanceOutcome} />
    </>
  );
};

const Outcome = ({ cut, enhance }: { cut: ApplyOutcome | null; enhance: EnhanceOutcome | null }) => {
  if (!cut) return null;
  if (!cut.ok) {
    return (
      <div className="msg error">
        <strong>Abgebrochen.</strong>
        <p style={{ whiteSpace: "pre-line" }}>{cut.error}</p>
        {cut.copyName && (
          <p className="hint">Die angefangene Kopie „{cut.copyName}“ kannst du im Projektfenster löschen. Das Original ist unverändert.</p>
        )}
      </div>
    );
  }
  const steps: { name: string; rep?: { applied: number; skipped: string[]; easeMode?: string } }[] =
    enhance && enhance.ok
      ? [
          { name: "Zooms", rep: enhance.zoom },
          { name: "B-Rolls", rep: enhance.broll },
          { name: "Swooshes", rep: enhance.swoosh },
        ]
      : [];
  const allOk = cut.report.passed && (!enhance || enhance.ok);
  return (
    <div className={allOk ? "msg ok" : "msg error"}>
      <strong>{allOk ? "Fertig – alle Prüfungen bestanden." : "Fertig, aber nicht alles hat geklappt:"}</strong>
      <p>
        Neue Sequenz: „{cut.copyName}“ · {cut.report.checkedClips} Clip-Stücke und {cut.report.checkedLinks} Bild/Ton-Verknüpfungen
        geprüft.
      </p>
      {cut.report.problems.length > 0 && (
        <ul>
          {cut.report.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {enhance && !enhance.ok && <p style={{ whiteSpace: "pre-line" }}>{enhance.error}</p>}
      {steps
        .filter((s) => s.rep)
        .map((s) => (
          <div key={s.name}>
            <p>
              {s.name}: {s.rep!.applied} gesetzt
              {s.rep!.easeMode === "sampled" ? " (Ease als berechnete Kurve, weil Premieres Bezier hier linear wirkte)" : ""}
              {s.rep!.skipped.length ? `, ${s.rep!.skipped.length} ausgelassen:` : ""}
            </p>
            {s.rep!.skipped.length > 0 && (
              <ul>
                {s.rep!.skipped.slice(0, 10).map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      <p className="hint">
        Gefällt dir das Ergebnis nicht: Kopie im Projektfenster löschen – das Original ist unverändert.
      </p>
    </div>
  );
};
