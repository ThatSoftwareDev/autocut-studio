// Einstellungen „B-Roll“ und lokale Transkription.

import { pickFolder } from "../lib/files";
import { LIMITS, type Settings, type WhisperModel } from "../lib/settings";
import type { BrollScan } from "../lib/sidecar";
import { NumberField } from "./NumberField";

type SetFn = <K extends keyof Settings>(key: K, value: Settings[K]) => void;

export type TranscriptState =
  | { state: "none" }
  | { state: "running"; progress: number; message: string }
  | { state: "error"; message: string }
  | { state: "done"; id: string; fingerprint: string; wordCount: number; jsonPath: string; preview: string };

type Props = {
  settings: Settings;
  set: SetFn;
  disabled: boolean;
  models: string[];
  scan: BrollScan | null;
  scanError: string | null;
  onScan: () => void;
  transcript: TranscriptState;
  transcriptValid: boolean;
  canTranscribe: boolean;
  onTranscribe: () => void;
};

export const BrollPanel = (p: Props) => {
  const { settings, set, disabled } = p;
  const modelReady = p.models.includes(settings.whisperModel);
  return (
    <section className="card">
      <label className="toggle">
        <input
          type="checkbox"
          checked={settings.brollEnabled}
          disabled={disabled}
          onChange={(e: { target: { checked: boolean } }) => set("brollEnabled", e.target.checked)}
        />
        <h2>B-Roll einfügen</h2>
      </label>

      {settings.brollEnabled && (
        <>
          <div className="grid">
            <label>B-Roll-Ordner</label>
            <div className="filebox">
              <span className={settings.brollFolder ? "path" : "path missing"} title={settings.brollFolder}>
                {settings.brollFolder || "(noch nicht gewählt)"}
              </span>
              <span className="row">
                <button
                  disabled={disabled}
                  onClick={() => {
                    const f = pickFolder("B-Roll-Ordner wählen", settings.brollFolder);
                    if (f) set("brollFolder", f);
                  }}
                >
                  Durchsuchen …
                </button>
                {settings.brollFolder && (
                  <button className="link" disabled={disabled} onClick={p.onScan}>
                    Schlagwörter anzeigen
                  </button>
                )}
              </span>
            </div>

            <label>Videospur</label>
            <select
              value={settings.brollTrackIndex}
              disabled={disabled}
              onChange={(e: { target: { value: string } }) => set("brollTrackIndex", Number(e.target.value))}
            >
              {[1, 2, 3, 4].map((i) => (
                <option key={i} value={i}>
                  V{i + 1}
                </option>
              ))}
            </select>

            <label>Länge je B-Roll</label>
            <div className="row">
              <NumberField
                value={settings.brollClipLengthS}
                min={LIMITS.brollClipLengthS.min}
                max={LIMITS.brollClipLengthS.max}
                step={0.5}
                decimals={1}
                disabled={disabled}
                onCommit={(v) => set("brollClipLengthS", v)}
              />
              <span className="unit">s (kürzer, wenn der Clip kürzer ist)</span>
            </div>

            <label>Mindestabstand</label>
            <div className="row">
              <NumberField
                value={settings.brollMinGapS}
                min={LIMITS.brollMinGapS.min}
                max={LIMITS.brollMinGapS.max}
                step={1}
                decimals={1}
                disabled={disabled}
                onCommit={(v) => set("brollMinGapS", v)}
              />
              <span className="unit">s zwischen zwei B-Rolls</span>
            </div>

            <label title="B-Roll beginnt so viel vor dem Schlagwort">Vorlauf</label>
            <div className="row">
              <NumberField
                value={settings.brollLeadS}
                min={LIMITS.brollLeadS.min}
                max={LIMITS.brollLeadS.max}
                step={0.1}
                decimals={1}
                disabled={disabled}
                onCommit={(v) => set("brollLeadS", v)}
              />
              <span className="unit">s</span>
            </div>

            <label>Optionen</label>
            <div className="stack">
              <label className="inline">
                <input
                  type="checkbox"
                  checked={settings.brollReuse}
                  disabled={disabled}
                  onChange={(e: { target: { checked: boolean } }) => set("brollReuse", e.target.checked)}
                />
                Clips mehrfach verwenden
              </label>
              <label className="inline" title="z. B. 4K-Clip in 1080p-Sequenz auf 50 % – aus lassen, wenn Premiere bei dir automatisch auf Framegröße skaliert">
                <input
                  type="checkbox"
                  checked={settings.brollFillFrame}
                  disabled={disabled}
                  onChange={(e: { target: { checked: boolean } }) => set("brollFillFrame", e.target.checked)}
                />
                Bildfüllend skalieren
              </label>
            </div>

            <label>Whisper-Modell</label>
            <select
              value={settings.whisperModel}
              disabled={disabled}
              onChange={(e: { target: { value: string } }) => set("whisperModel", e.target.value as WhisperModel)}
            >
              {(["tiny", "base", "small", "medium"] as WhisperModel[]).map((m) => (
                <option key={m} value={m}>
                  {m}
                  {p.models.includes(m) ? "" : " (nicht geladen)"}
                </option>
              ))}
            </select>
          </div>

          {p.scanError && <div className="msg error">{p.scanError}</div>}
          {p.scan && (
            <div className="msg">
              <strong>{p.scan.files.length} Clips im Ordner</strong>
              <ul className="kw">
                {p.scan.files.slice(0, 30).map((f) => (
                  <li key={f.file}>
                    <span className="path">{f.file}</span>: {f.keywords.join(", ") || <em>keine Schlagwörter</em>}
                  </li>
                ))}
              </ul>
              {p.scan.warnings.length > 0 && (
                <ul>
                  {p.scan.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!modelReady && (
            <div className="msg warn">
              Whisper-Modell „{settings.whisperModel}“ ist noch nicht heruntergeladen. Einmalig{" "}
              <code>sidecar\download-model.bat {settings.whisperModel}</code> ausführen, dann Helfer neu starten.
            </div>
          )}

          <div className="row">
            <button
              className="primary"
              disabled={disabled || !modelReady || !p.canTranscribe || p.transcript.state === "running"}
              onClick={p.onTranscribe}
            >
              {p.transcript.state === "done" && p.transcriptValid ? "Neu transkribieren" : "Transkribieren (lokal)"}
            </button>
            {!p.canTranscribe && <span className="hint small">Erst die Sequenz analysieren.</span>}
          </div>

          {p.transcript.state === "running" && (
            <div className="progress">
              <div className="label">{p.transcript.message}</div>
              <div className="bar">
                <div style={{ width: `${Math.round(p.transcript.progress * 100)}%` }} />
              </div>
            </div>
          )}
          {p.transcript.state === "error" && <div className="msg error">{p.transcript.message}</div>}
          {p.transcript.state === "done" && (
            <div className={p.transcriptValid ? "msg ok" : "msg warn"}>
              {p.transcriptValid
                ? `Transkript: ${p.transcript.wordCount} Wörter.`
                : "Die Sequenz hat sich seit dem Transkribieren geändert – bitte neu transkribieren."}
              <p className="hint small">„{p.transcript.preview}…“</p>
              <p className="hint small">Gespeichert als JSON: {p.transcript.jsonPath}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
};
