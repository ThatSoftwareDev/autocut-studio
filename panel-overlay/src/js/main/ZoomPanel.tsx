// Einstellungen „Automatischer Zoom“ und Swoosh.

import { assetsDir, defaultSwooshPath, fileExists, pickFile } from "../lib/files";
import { LIMITS, type Settings, type ZoomMode } from "../lib/settings";
import { NumberField } from "./NumberField";

type SetFn = <K extends keyof Settings>(key: K, value: Settings[K]) => void;

const MODES: { value: ZoomMode; label: string; hint: string }[] = [
  { value: "camera", label: "Kamera-Wechsel", hint: "Pro Schnitt abwechselnd 100 % und Zoom-Stärke – wirkt wie eine zweite Kamera." },
  { value: "slow", label: "Slow Zoom", hint: "Innerhalb jedes Sprechabschnitts langsam von 100 % auf die Zoom-Stärke." },
  { value: "punch", label: "Punch bei Betonung", hint: "Kurzer Zoom an lauten Betonungen (Energie-Spitzen), dann zurück." },
];

export const resolvedSwooshPath = (s: Settings) => s.swooshPath || defaultSwooshPath();

export const ZoomPanel = ({ settings, set, disabled }: { settings: Settings; set: SetFn; disabled: boolean }) => {
  const mode = MODES.find((m) => m.value === settings.zoomMode) ?? MODES[0];
  const swooshPath = resolvedSwooshPath(settings);
  const swooshOk = fileExists(swooshPath);
  return (
    <section className="card">
      <label className="toggle">
        <input
          type="checkbox"
          checked={settings.zoomEnabled}
          disabled={disabled}
          onChange={(e: { target: { checked: boolean } }) => set("zoomEnabled", e.target.checked)}
        />
        <h2>Automatischer Zoom</h2>
      </label>

      {settings.zoomEnabled && (
        <>
          <div className="grid">
            <label>Modus</label>
            <select
              value={settings.zoomMode}
              disabled={disabled}
              onChange={(e: { target: { value: string } }) => set("zoomMode", e.target.value as ZoomMode)}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <span />
            <span className="hint small">{mode.hint}</span>

            <label>Zoom-Stärke</label>
            <div className="row">
              <input
                type="range"
                min={LIMITS.zoomStrengthPct.min}
                max={LIMITS.zoomStrengthPct.max}
                step={1}
                value={settings.zoomStrengthPct}
                disabled={disabled}
                onChange={(e: { target: { value: string } }) => set("zoomStrengthPct", Number(e.target.value))}
              />
              <span className="value">{settings.zoomStrengthPct} %</span>
            </div>

            {settings.zoomMode !== "camera" && (
              <>
                <label title="Weiche Beschleunigung und Abbremsung der Zoom-Bewegung">Ease In / Ease Out</label>
                <input
                  type="checkbox"
                  checked={settings.zoomEase}
                  disabled={disabled}
                  onChange={(e: { target: { checked: boolean } }) => set("zoomEase", e.target.checked)}
                />
              </>
            )}

            {settings.zoomMode !== "slow" && (
              <>
                <label title="So lange wird nach einem Zoom-Wechsel mindestens gewartet">Mindestabstand</label>
                <div className="row">
                  <NumberField
                    value={settings.zoomMinGapS}
                    min={LIMITS.zoomMinGapS.min}
                    max={LIMITS.zoomMinGapS.max}
                    step={0.5}
                    decimals={1}
                    disabled={disabled}
                    onCommit={(v) => set("zoomMinGapS", v)}
                  />
                  <span className="unit">s</span>
                </div>
              </>
            )}

            {settings.zoomMode === "punch" && (
              <>
                <label title="Wie viel lauter als dein normaler Sprachpegel eine Betonung sein muss">Betonung ab</label>
                <div className="row">
                  <NumberField
                    value={settings.punchProminenceDb}
                    min={LIMITS.punchProminenceDb.min}
                    max={LIMITS.punchProminenceDb.max}
                    step={1}
                    disabled={disabled}
                    onCommit={(v) => set("punchProminenceDb", v)}
                  />
                  <span className="unit">dB über Sprachpegel</span>
                </div>
                <label>Zoom halten</label>
                <div className="row">
                  <NumberField
                    value={settings.punchHoldS}
                    min={LIMITS.punchHoldS.min}
                    max={LIMITS.punchHoldS.max}
                    step={0.1}
                    decimals={1}
                    disabled={disabled}
                    onCommit={(v) => set("punchHoldS", v)}
                  />
                  <span className="unit">s</span>
                </div>
              </>
            )}

            {settings.zoomMode === "slow" && (
              <>
                <label title="Kürzere Abschnitte bekommen keinen Slow Zoom">Abschnitte ab</label>
                <div className="row">
                  <NumberField
                    value={settings.slowMinSegmentS}
                    min={LIMITS.slowMinSegmentS.min}
                    max={LIMITS.slowMinSegmentS.max}
                    step={0.5}
                    decimals={1}
                    disabled={disabled}
                    onCommit={(v) => set("slowMinSegmentS", v)}
                  />
                  <span className="unit">s</span>
                </div>
              </>
            )}
          </div>

          <label className="toggle sub">
            <input
              type="checkbox"
              checked={settings.swooshEnabled}
              disabled={disabled}
              onChange={(e: { target: { checked: boolean } }) => set("swooshEnabled", e.target.checked)}
            />
            Swoosh-Sound bei jedem Zoom
          </label>
          {settings.swooshEnabled && (
            <div className="grid">
              <label>Datei</label>
              <div className="filebox">
                <span className={swooshOk ? "path" : "path missing"} title={swooshPath}>
                  {swooshPath || "(kein Dokumente-Ordner gefunden)"}
                </span>
                <span className="row">
                  <button
                    disabled={disabled}
                    onClick={() => {
                      const p = pickFile("Swoosh-Datei wählen", assetsDir(), ["wav", "mp3", "aif", "aiff", "m4a"]);
                      if (p) set("swooshPath", p);
                    }}
                  >
                    Durchsuchen …
                  </button>
                  {settings.swooshPath && (
                    <button className="link" disabled={disabled} onClick={() => set("swooshPath", "")}>
                      Standard
                    </button>
                  )}
                </span>
                {!swooshOk && (
                  <span className="hint small">
                    Datei fehlt. Lege deine <code>swoosh.wav</code> in <code>{assetsDir() || "Dokumente\\AutoCut Studio"}</code> oder
                    wähle eine Datei.
                  </span>
                )}
              </div>

              <label>Spur</label>
              <select
                value={settings.swooshTrackIndex}
                disabled={disabled}
                onChange={(e: { target: { value: string } }) => set("swooshTrackIndex", Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((i) => (
                  <option key={i} value={i}>
                    A{i + 1}
                  </option>
                ))}
              </select>

              <label title="Negativ = Swoosh beginnt kurz VOR dem Zoom">Versatz</label>
              <div className="row">
                <NumberField
                  value={settings.swooshOffsetMs}
                  min={LIMITS.swooshOffsetMs.min}
                  max={LIMITS.swooshOffsetMs.max}
                  step={10}
                  disabled={disabled}
                  onCommit={(v) => set("swooshOffsetMs", v)}
                />
                <span className="unit">ms</span>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
};
