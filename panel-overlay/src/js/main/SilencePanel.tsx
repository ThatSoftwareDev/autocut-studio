// Einstellungen und Vorschau-Liste für „Stille entfernen“.

import { LIMITS, type Settings } from "../lib/settings";
import type { SilenceAnalysis } from "../lib/sidecar";
import { fmtPercent, fmtSeconds, fmtTime } from "./format";
import { NumberField } from "./NumberField";

type SetFn = <K extends keyof Settings>(key: K, value: Settings[K]) => void;

export const SilenceSettings = ({
  settings,
  set,
  disabled,
  audioTrackCount,
}: {
  settings: Settings;
  set: SetFn;
  disabled: boolean;
  audioTrackCount: number;
}) => (
  <div className="grid">
    <label>Audiospur für die Analyse</label>
    <select
      value={settings.analysisTrackIndex}
      onChange={(e: { target: { value: string } }) => set("analysisTrackIndex", Number(e.target.value))}
      disabled={disabled}
    >
      {Array.from({ length: Math.max(8, audioTrackCount) }, (_, i) => (
        <option key={i} value={i}>
          A{i + 1}
        </option>
      ))}
    </select>

    <label title="Alles leiser als dieser Pegel gilt als Stille">Schwellwert</label>
    <div className="row">
      <input
        type="range"
        min={LIMITS.thresholdDb.min}
        max={LIMITS.thresholdDb.max}
        step={1}
        value={settings.thresholdDb}
        onChange={(e: { target: { value: string } }) => set("thresholdDb", Number(e.target.value))}
        disabled={disabled}
      />
      <span className="value">{settings.thresholdDb} dB</span>
    </div>

    <label title="Luft, die VOR dem ersten Wort nach einer Pause stehen bleibt">Padding In</label>
    <div className="row">
      <NumberField
        value={settings.paddingInMs}
        min={LIMITS.paddingMs.min}
        max={LIMITS.paddingMs.max}
        step={10}
        onCommit={(v) => set("paddingInMs", v)}
        disabled={disabled}
      />
      <span className="unit">ms vor dem Wort</span>
    </div>

    <label title="Luft, die NACH dem letzten Wort vor einer Pause stehen bleibt">Padding Out</label>
    <div className="row">
      <NumberField
        value={settings.paddingOutMs}
        min={LIMITS.paddingMs.min}
        max={LIMITS.paddingMs.max}
        step={10}
        onCommit={(v) => set("paddingOutMs", v)}
        disabled={disabled}
      />
      <span className="unit">ms nach dem Wort</span>
    </div>

    <label title="Leise Wortenden knapp unter dem Schwellwert zählen noch als Sprache">Ausklang-Schutz</label>
    <div className="row">
      <NumberField
        value={settings.hysteresisDb}
        min={LIMITS.hysteresisDb.min}
        max={LIMITS.hysteresisDb.max}
        step={1}
        onCommit={(v) => set("hysteresisDb", v)}
        disabled={disabled}
      />
      <span className="unit">dB unter Schwellwert (0 = aus)</span>
    </div>

    <label title="Kürzere Pausen werden nie geschnitten">Pausen ab</label>
    <div className="row">
      <NumberField
        value={settings.minSilenceMs}
        min={LIMITS.minSilenceMs.min}
        max={LIMITS.minSilenceMs.max}
        step={50}
        onCommit={(v) => set("minSilenceMs", v)}
        disabled={disabled}
      />
      <span className="unit">ms</span>
    </div>
  </div>
);

export const CutList = ({
  result,
  selected,
  setSelected,
  onJump,
  thresholdDb,
  onUseSuggestion,
}: {
  result: SilenceAnalysis;
  selected: boolean[];
  setSelected: (s: boolean[]) => void;
  onJump: (startFrame: number) => void;
  thresholdDb: number;
  onUseSuggestion: (db: number) => void;
}) => {
  const lv = result.levels;
  let count = 0;
  let seconds = 0;
  result.cuts.forEach((c, i) => {
    if (selected[i]) {
      count++;
      seconds += c.duration_s;
    }
  });
  return (
    <>
      {result.warnings.length > 0 && (
        <div className="msg warn">
          <ul>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {lv.noise_floor_db !== null && (
        <div className="levels">
          Grundrauschen ca. <b>{lv.noise_floor_db} dB</b> · Sprache ca. <b>{lv.speech_level_db} dB</b>
          {lv.suggested_threshold_db !== null && lv.suggested_threshold_db !== thresholdDb && (
            <>
              {" · "}Vorschlag: <b>{lv.suggested_threshold_db} dB</b>{" "}
              <button className="link" onClick={() => onUseSuggestion(lv.suggested_threshold_db as number)}>
                übernehmen
              </button>
            </>
          )}
        </div>
      )}
      <div className="summary">
        <span>
          <b>{count}</b> von {result.cuts.length} Pausen · spart <b>{fmtSeconds(seconds, 1)}</b> (
          {fmtPercent(seconds, result.summary.analyzed_s)} von {fmtTime(result.summary.analyzed_s)})
        </span>
        <span className="row">
          <button className="link" onClick={() => setSelected(result.cuts.map(() => true))}>alle</button>
          <button className="link" onClick={() => setSelected(result.cuts.map(() => false))}>keine</button>
        </span>
      </div>
      {result.cuts.length === 0 ? (
        <p className="hint">Keine Pausen gefunden, die die Kriterien erfüllen.</p>
      ) : (
        <ol className="cuts">
          {result.cuts.map((c, i) => (
            <li key={c.index} className={selected[i] ? "" : "off"}>
              <input
                type="checkbox"
                checked={!!selected[i]}
                onChange={(e: { target: { checked: boolean } }) => {
                  const next = [...selected];
                  next[i] = e.target.checked;
                  setSelected(next);
                }}
              />
              <span className="tc">
                {fmtTime(c.start_s)} → {fmtTime(c.end_s)}
              </span>
              <span className="dur">{fmtSeconds(c.duration_s)}</span>
              <span className="db">{c.mean_db} dB</span>
              <button className="link" title="Abspielposition 1 s vor diese Pause setzen" onClick={() => onJump(c.start_frame)}>
                ansehen
              </button>
            </li>
          ))}
        </ol>
      )}
    </>
  );
};
