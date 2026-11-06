import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dashboard assets live in `assets/dashboard/` (shipped with the package) so they stay editable
 * as plain HTML/CSS/JS. The page uses a strict CSP: no inline script or style.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = [path.join(here, "..", "..", "assets", "dashboard"), path.join(here, "..", "assets", "dashboard")].find((d) => {
  try {
    readFileSync(path.join(d, "index.html"));
    return true;
  } catch {
    return false;
  }
});

function load(name: string): string {
  if (!dir) throw new Error("agent-flow dashboard assets not found (assets/dashboard)");
  return readFileSync(path.join(dir, name), "utf8");
}

export const DASHBOARD_HTML = load("index.html");
export const APP_JS = load("app.js");
export const APP_CSS = load("app.css");
export const FAVICON_SVG = load("favicon.svg");
