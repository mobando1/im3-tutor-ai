import esbuild from "esbuild";
import { readFileSync } from "fs";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Ensure dist/ directory exists
mkdirSync(path.join(root, "dist"), { recursive: true });

// Read CSS to inline it
const css = readFileSync(path.join(root, "widget", "styles.css"), "utf-8");

const isWatch = process.argv.includes("--watch");

if (isWatch) {
  const ctx = await esbuild.context({
    entryPoints: [path.join(root, "widget", "tutor-widget.ts")],
    bundle: true,
    minify: false,
    format: "iife",
    target: ["es2020"],
    outfile: path.join(root, "dist", "widget.js"),
    define: {
      __WIDGET_CSS__: JSON.stringify(css),
    },
  });

  await ctx.watch();
  console.log("[IM3 Tutor] Widget watching for changes...");
} else {
  esbuild.buildSync({
    entryPoints: [path.join(root, "widget", "tutor-widget.ts")],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2020"],
    outfile: path.join(root, "dist", "widget.js"),
    define: {
      __WIDGET_CSS__: JSON.stringify(css),
    },
  });

  const stats = readFileSync(path.join(root, "dist", "widget.js"));
  const sizeKB = (stats.length / 1024).toFixed(1);
  console.log(`[IM3 Tutor] Widget built successfully (${sizeKB} KB)`);
}
