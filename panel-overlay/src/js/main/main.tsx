import { useCallback, useEffect, useState } from "react";
import { subscribeBackgroundColor } from "../lib/utils/bolt";
import { loadSettings, sanitize, saveSettings, type Settings } from "../lib/settings";
import { sidecar, SidecarError, type Health } from "../lib/sidecar";
import { ensureAssetsDir } from "../lib/files";
import { Workflow } from "./Workflow";
import "./main.scss";

type HelperState =
  | { state: "checking" }
  | { state: "ok"; health: Health }
  | { state: "noffmpeg"; health: Health }
  | { state: "down"; message: string };

export const App = () => {
  const [bgColor, setBgColor] = useState("#232323");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [helper, setHelper] = useState<HelperState>({ state: "checking" });

  useEffect(() => {
    if (window.cep) {
      subscribeBackgroundColor(setBgColor);
      ensureAssetsDir(); // „Dokumente\AutoCut Studio“ für swoosh.wav anlegen
    }
  }, []);

  const checkHelper = useCallback(async () => {
    setHelper({ state: "checking" });
    try {
      const health = await sidecar.health();
      setHelper(health.ffmpeg ? { state: "ok", health } : { state: "noffmpeg", health });
    } catch (e: any) {
      setHelper({ state: "down", message: e instanceof SidecarError ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    checkHelper();
  }, [checkHelper]);

  const updateSettings = (s: Settings) => {
    const clean = sanitize(s);
    setSettings(clean);
    saveSettings(clean);
  };

  return (
    <div className="app" style={{ backgroundColor: bgColor }}>
      <header>
        <h1>AutoCut Studio</h1>
        <div className={`status ${helper.state}`}>
          <span className="dot" />
          {helper.state === "checking" && "Prüfe Helfer …"}
          {helper.state === "ok" && `Helfer ${helper.health.version} · ffmpeg ok`}
          {helper.state === "noffmpeg" && "Helfer läuft · ffmpeg fehlt"}
          {helper.state === "down" && "Helfer nicht erreichbar"}
          <button className="link" onClick={checkHelper}>Erneut prüfen</button>
        </div>
      </header>

      {helper.state === "down" && <div className="msg error">{helper.message}</div>}
      {helper.state === "noffmpeg" && (
        <div className="msg error">
          ffmpeg wurde nicht gefunden. Installiere es mit <code>winget install Gyan.FFmpeg</code> (kostenlos) oder lege{" "}
          <code>ffmpeg.exe</code> in den Ordner <code>sidecar\bin</code>, starte den Helfer neu und klicke auf „Erneut
          prüfen“.
          {helper.health.ffmpeg_error ? ` (${helper.health.ffmpeg_error})` : ""}
        </div>
      )}

      <Workflow
        settings={settings}
        onSettings={updateSettings}
        helperReady={helper.state === "ok"}
        whisperModels={helper.state === "ok" ? helper.health.whisper_models ?? [] : []}
      />

      <footer>Alles läuft lokal auf deinem Rechner. Es werden keine Medien hochgeladen.</footer>
    </div>
  );
};
