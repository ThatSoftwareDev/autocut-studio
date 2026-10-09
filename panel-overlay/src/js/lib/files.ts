// Dateiauswahl und Standardpfade im CEP-Panel (nur lokal, nichts wird hochgeladen).

import { fs, path } from "./cep/node";
import { csi } from "./utils/bolt";

const cepFs = (): any => (typeof window !== "undefined" ? (window as any).cep?.fs : undefined);

/** „Dokumente\AutoCut Studio“ – der feste Ablageort für Swoosh & Co. */
export const assetsDir = (): string => {
  try {
    const docs = csi.getSystemPath("myDocuments" as any);
    return path.join(docs, "AutoCut Studio");
  } catch {
    return "";
  }
};

export const defaultSwooshPath = (): string => {
  const dir = assetsDir();
  return dir ? path.join(dir, "swoosh.wav") : "";
};

/** Legt den Ablageordner an, damit du ihn im Explorer sofort findest. */
export const ensureAssetsDir = (): string => {
  const dir = assetsDir();
  try {
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Kein Schreibrecht? Dann bleibt nur die manuelle Auswahl.
  }
  return dir;
};

export const fileExists = (p: string): boolean => {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export const pickFile = (title: string, initialDir: string, types: string[]): string | null => {
  const f = cepFs();
  if (!f) return null;
  const res = f.showOpenDialogEx(false, false, title, initialDir || "", types);
  return res && !res.err && res.data && res.data.length ? String(res.data[0]) : null;
};

export const pickFolder = (title: string, initialDir: string): string | null => {
  const f = cepFs();
  if (!f) return null;
  const res = f.showOpenDialogEx(false, true, title, initialDir || "", []);
  return res && !res.err && res.data && res.data.length ? String(res.data[0]) : null;
};
