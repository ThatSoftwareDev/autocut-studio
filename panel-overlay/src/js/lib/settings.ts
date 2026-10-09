// Panel-Einstellungen, lokal im Panel gespeichert (localStorage von CEP).

export type ZoomMode = "camera" | "slow" | "punch";
export type WhisperModel = "tiny" | "base" | "small" | "medium";

export type Settings = {
  // Stille entfernen
  analysisTrackIndex: number; // 0 = A1
  thresholdDb: number;
  paddingInMs: number; // Luft VOR dem ersten Wort nach einer Pause
  paddingOutMs: number; // Luft NACH dem letzten Wort vor einer Pause
  minSilenceMs: number;
  hysteresisDb: number; // Ausklang-Schutz
  // Automatischer Zoom
  zoomEnabled: boolean;
  zoomMode: ZoomMode;
  zoomStrengthPct: number; // 105..125
  zoomEase: boolean;
  zoomMinGapS: number;
  punchHoldS: number;
  punchProminenceDb: number;
  slowMinSegmentS: number;
  // Swoosh
  swooshEnabled: boolean;
  swooshPath: string; // leer = Standard „Dokumente\AutoCut Studio\swoosh.wav“
  swooshTrackIndex: number; // 1 = A2
  swooshOffsetMs: number;
  // B-Roll
  brollEnabled: boolean;
  brollFolder: string;
  brollTrackIndex: number; // 1 = V2
  brollClipLengthS: number;
  brollMinGapS: number;
  brollLeadS: number;
  brollReuse: boolean;
  brollFillFrame: boolean;
  whisperModel: WhisperModel;
  language: string;
  // Schritt 3 (Versprecher) – noch ohne Oberfläche
  fillerWords: string[];
};

export const DEFAULT_SETTINGS: Settings = {
  analysisTrackIndex: 0,
  thresholdDb: -40,
  paddingInMs: 80,
  paddingOutMs: 150,
  minSilenceMs: 400,
  hysteresisDb: 6,
  zoomEnabled: false,
  zoomMode: "camera",
  zoomStrengthPct: 110,
  zoomEase: true,
  zoomMinGapS: 3,
  punchHoldS: 0.8,
  punchProminenceDb: 6,
  slowMinSegmentS: 2,
  swooshEnabled: false,
  swooshPath: "",
  swooshTrackIndex: 1,
  swooshOffsetMs: 0,
  brollEnabled: false,
  brollFolder: "",
  brollTrackIndex: 1,
  brollClipLengthS: 3,
  brollMinGapS: 6,
  brollLeadS: 0.2,
  brollReuse: false,
  brollFillFrame: true,
  whisperModel: "small",
  language: "de",
  fillerWords: ["äh", "ähm", "öh", "öhm", "hm", "mhm"],
};

export const LIMITS = {
  thresholdDb: { min: -70, max: -15 },
  paddingMs: { min: 0, max: 1000 },
  minSilenceMs: { min: 100, max: 5000 },
  hysteresisDb: { min: 0, max: 15 },
  zoomStrengthPct: { min: 105, max: 125 },
  zoomMinGapS: { min: 0, max: 30 },
  punchHoldS: { min: 0.2, max: 5 },
  punchProminenceDb: { min: 2, max: 15 },
  slowMinSegmentS: { min: 0.5, max: 20 },
  swooshOffsetMs: { min: -1000, max: 1000 },
  brollClipLengthS: { min: 1, max: 15 },
  brollMinGapS: { min: 0, max: 60 },
  brollLeadS: { min: 0, max: 2 },
};

const KEY = "autocut-studio.settings.v2";
const OLD_KEY = "autocut-studio.settings.v1";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const n = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
const b = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const lim = (v: unknown, key: keyof typeof LIMITS, d: number) => clamp(n(v, d), LIMITS[key].min, LIMITS[key].max);

export const sanitize = (s: Partial<Settings> & { paddingMs?: number }): Settings => {
  const d = DEFAULT_SETTINGS;
  const m: any = { ...d, ...s };
  // Übernahme aus Version 1 (ein gemeinsames Padding)
  if (s.paddingMs !== undefined && s.paddingInMs === undefined) m.paddingInMs = s.paddingMs;
  if (s.paddingMs !== undefined && s.paddingOutMs === undefined) m.paddingOutMs = s.paddingMs;
  return {
    analysisTrackIndex: Math.max(0, Math.floor(n(m.analysisTrackIndex, 0))),
    thresholdDb: lim(m.thresholdDb, "thresholdDb", d.thresholdDb),
    paddingInMs: lim(m.paddingInMs, "paddingMs", d.paddingInMs),
    paddingOutMs: lim(m.paddingOutMs, "paddingMs", d.paddingOutMs),
    minSilenceMs: lim(m.minSilenceMs, "minSilenceMs", d.minSilenceMs),
    hysteresisDb: lim(m.hysteresisDb, "hysteresisDb", d.hysteresisDb),
    zoomEnabled: b(m.zoomEnabled, d.zoomEnabled),
    zoomMode: ["camera", "slow", "punch"].includes(m.zoomMode) ? m.zoomMode : d.zoomMode,
    zoomStrengthPct: lim(m.zoomStrengthPct, "zoomStrengthPct", d.zoomStrengthPct),
    zoomEase: b(m.zoomEase, d.zoomEase),
    zoomMinGapS: lim(m.zoomMinGapS, "zoomMinGapS", d.zoomMinGapS),
    punchHoldS: lim(m.punchHoldS, "punchHoldS", d.punchHoldS),
    punchProminenceDb: lim(m.punchProminenceDb, "punchProminenceDb", d.punchProminenceDb),
    slowMinSegmentS: lim(m.slowMinSegmentS, "slowMinSegmentS", d.slowMinSegmentS),
    swooshEnabled: b(m.swooshEnabled, d.swooshEnabled),
    swooshPath: typeof m.swooshPath === "string" ? m.swooshPath : "",
    swooshTrackIndex: Math.max(0, Math.floor(n(m.swooshTrackIndex, d.swooshTrackIndex))),
    swooshOffsetMs: lim(m.swooshOffsetMs, "swooshOffsetMs", d.swooshOffsetMs),
    brollEnabled: b(m.brollEnabled, d.brollEnabled),
    brollFolder: typeof m.brollFolder === "string" ? m.brollFolder : "",
    brollTrackIndex: Math.max(1, Math.floor(n(m.brollTrackIndex, d.brollTrackIndex))),
    brollClipLengthS: lim(m.brollClipLengthS, "brollClipLengthS", d.brollClipLengthS),
    brollMinGapS: lim(m.brollMinGapS, "brollMinGapS", d.brollMinGapS),
    brollLeadS: lim(m.brollLeadS, "brollLeadS", d.brollLeadS),
    brollReuse: b(m.brollReuse, d.brollReuse),
    brollFillFrame: b(m.brollFillFrame, d.brollFillFrame),
    whisperModel: ["tiny", "base", "small", "medium"].includes(m.whisperModel) ? m.whisperModel : d.whisperModel,
    language: typeof m.language === "string" && m.language.length >= 2 ? m.language : d.language,
    fillerWords: Array.isArray(m.fillerWords) ? m.fillerWords.map(String) : d.fillerWords,
  };
};

export const loadSettings = (): Settings => {
  try {
    const raw = window.localStorage.getItem(KEY) ?? window.localStorage.getItem(OLD_KEY);
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
};

export const saveSettings = (s: Settings) => {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Speichern ist Komfort – Fehler hier dürfen nichts blockieren.
  }
};
