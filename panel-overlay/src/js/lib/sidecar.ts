// Client für den lokalen Python-Helfer. Spricht ausschließlich mit 127.0.0.1.
// Es werden nur Dateipfade und Zeitangaben übertragen – das Audio liest der
// Helfer selbst von deiner Festplatte.

export const SIDECAR_PORT = 47821;
const BASE = `http://127.0.0.1:${SIDECAR_PORT}`;

export class SidecarError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export type Health = {
  ok: true;
  version: string;
  ffmpeg: { path: string; version: string } | null;
  ffmpeg_error?: string;
  whisper_models?: string[];
};

export type SilenceCut = {
  index: number;
  start_frame: number;
  end_frame: number;
  start_s: number;
  end_s: number;
  duration_s: number;
  mean_db: number;
};

export type SilenceAnalysis = {
  ok: true;
  ticks_per_frame: number;
  cuts: SilenceCut[];
  summary: { cut_count: number; removed_s: number; analyzed_s: number };
  levels: {
    noise_floor_db: number | null;
    speech_level_db: number | null;
    suggested_threshold_db: number | null;
    separation_db: number | null;
  };
  warnings: string[];
};

export type ClipPayload = {
  clip_id: string;
  name: string;
  media_path: string;
  seq_start_ticks: string;
  seq_end_ticks: string;
  source_in_ticks: string;
};

export type SilenceRequest = {
  ticks_per_frame: string;
  threshold_db: number;
  padding_in_s: number;
  padding_out_s: number;
  min_silence_s: number;
  hysteresis_db: number;
  clips: ClipPayload[];
};

export type PlanZoomEventDto =
  | { kind: "static"; piece_new_start: number; piece_new_end: number; scale_pct: number; swoosh_frame: number | null; label: string }
  | {
      kind: "keys";
      piece_new_start: number;
      piece_new_end: number;
      keys: { frame: number; pct: number }[];
      ease: boolean;
      swoosh_frame: number | null;
      label: string;
    };

export type PlanBrollDto = {
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

export type PlanRequest = {
  ticks_per_frame: string;
  threshold_db: number;
  clips: ClipPayload[];
  cuts: { start_frame: number; end_frame: number }[];
  zoom: {
    enabled: boolean;
    mode: string;
    strength_pct: number;
    ease: boolean;
    min_gap_s: number;
    slow_min_segment_s: number;
    punch_hold_s: number;
    punch_ramp_s: number;
    punch_prominence_db: number;
  };
  swoosh: { enabled: boolean; path: string; offset_ms: number };
  broll: {
    enabled: boolean;
    folder: string;
    transcript_id: string | null;
    clip_length_s: number;
    min_gap_s: number;
    lead_s: number;
    reuse: boolean;
  };
};

export type PlanResponse = {
  ok: true;
  ticks_per_frame: number;
  timeline: { end_frame: number };
  zoom: { events: PlanZoomEventDto[] };
  swoosh: { events: { frame: number }[]; duration_frames: number; duration_s?: number };
  broll: { placements: PlanBrollDto[]; files: number; warnings: string[] };
  warnings: string[];
};

export type JobStatus = {
  ok: true;
  state: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  result?: { transcript_id: string; word_count: number; segment_count: number; json_path: string; preview: string };
};

export type BrollScan = {
  ok: true;
  files: { file: string; keywords: string[]; duration_s: number; width: number; height: number }[];
  warnings: string[];
};

const NOT_RUNNING =
  "Der lokale Helfer ist nicht erreichbar. Starte „start-sidecar.bat“ im Ordner „sidecar“ " +
  "und lass das Fenster offen. Danach auf „Erneut prüfen“ klicken.";

const request = async <T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(BASE + path, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (e && e.name === "AbortError") {
      throw new SidecarError("Der Helfer hat nicht rechtzeitig geantwortet (Zeitüberschreitung).", "timeout");
    }
    throw new SidecarError(NOT_RUNNING, "unreachable");
  } finally {
    clearTimeout(timer);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    throw new SidecarError(`Unerwartete Antwort vom Helfer (HTTP ${res.status}).`, "bad_response");
  }
  if (!res.ok || !body || body.ok !== true) {
    const err = body && body.error ? body.error : { code: "http_" + res.status, message: `HTTP ${res.status}` };
    throw new SidecarError(err.message, err.code);
  }
  return body as T;
};

export const sidecar = {
  health: () => request<Health>("/health", { method: "GET" }, 8000),
  analyzeSilence: (body: SilenceRequest) =>
    request<SilenceAnalysis>(
      "/silence/analyze",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      15 * 60 * 1000 // lange Aufnahmen: ffmpeg braucht beim ersten Mal etwas
    ),
  plan: (body: PlanRequest) =>
    request<PlanResponse>(
      "/plan",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      10 * 60 * 1000
    ),
  brollScan: (folder: string) =>
    request<BrollScan>(
      "/broll/scan",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder }) },
      5 * 60 * 1000
    ),
  transcribeStart: (clips: ClipPayload[], model: string, language: string) =>
    request<{ ok: true; job_id: string }>(
      "/transcribe/start",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clips, model, language }) },
      30 * 1000
    ),
  job: (id: string) => request<JobStatus>(`/jobs/${encodeURIComponent(id)}`, { method: "GET" }, 15 * 1000),
};
