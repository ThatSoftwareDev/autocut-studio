// Testet die Schnitt-Logik gegen ein SIMULIERTES Premiere (kein Ersatz für den
// echten Test in Premiere, aber fängt Logikfehler ab).
// Aufruf im Panel-Projektordner:  node tests/premiere-sim/build-and-run.cjs
const ts = require("typescript");
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "../../src");
const out = path.join(__dirname, "build");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
for (const [src, dst] of [
  ["jsx/ppro/common.ts", "common.js"],
  ["jsx/ppro/autocut.ts", "autocut.js"],
  ["jsx/ppro/enhance.ts", "enhance.js"],
  ["js/lib/applySilenceCuts.ts", "applySilenceCuts.js"],
  ["js/lib/applyEnhancements.ts", "applyEnhancements.js"],
]) {
  const code = fs.readFileSync(path.join(root, src), "utf8");
  const res = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  fs.writeFileSync(path.join(out, dst), res.outputText);
}
require("./run.cjs").then(() => require("./run-enhance.cjs"));
