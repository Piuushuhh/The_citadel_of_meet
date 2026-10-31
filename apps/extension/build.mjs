import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: {
    page: "src/page.ts",
    content: "src/content.ts",
    background: "src/background.ts",
    popup: "src/popup.ts",
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  sourcemap: false,
  logLevel: "info",
});

cpSync("manifest.json", "dist/manifest.json");
cpSync("popup.html", "dist/popup.html");
console.log("Built to dist/. Load it via chrome://extensions > Load unpacked.");
