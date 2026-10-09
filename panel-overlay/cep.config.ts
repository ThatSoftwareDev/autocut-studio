import type { CEP_Config } from "vite-cep-plugin";
import { version } from "./package.json";

// Bolt-CEP-Konfiguration für AutoCut Studio (nur Premiere).
const config: CEP_Config = {
  version,
  id: "com.autocutstudio.panel",
  displayName: "AutoCut Studio",
  symlink: "local",
  port: 3000,
  servePort: 5000,
  startingDebugPort: 8860,
  extensionManifestVersion: 6.0,
  requiredRuntimeVersion: 9.0,
  hosts: [{ name: "PPRO", version: "[0.0,99.9]" }],

  type: "Panel",
  iconDarkNormal: "./src/assets/light-icon.png",
  iconNormal: "./src/assets/dark-icon.png",
  iconDarkNormalRollOver: "./src/assets/light-icon.png",
  iconNormalRollOver: "./src/assets/dark-icon.png",
  parameters: ["--v=0", "--enable-nodejs", "--mixed-context"],
  width: 420,
  height: 640,

  panels: [
    {
      mainPath: "./main/index.html",
      name: "main",
      panelDisplayName: "AutoCut Studio",
      autoVisible: true,
      width: 420,
      height: 640,
    },
  ],
  build: {
    jsxBin: "off",
    sourceMap: true,
  },
  zxp: {
    country: "DE",
    province: "NRW",
    org: "AutoCut Studio",
    password: "password",
    tsa: ["http://timestamp.digicert.com/"],
    allowSkipTSA: false,
    sourceMap: false,
    jsxBin: "off",
  },
  installModules: [],
  copyAssets: [],
  copyZipAssets: [],
};
export default config;
