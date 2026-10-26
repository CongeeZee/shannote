import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The single-page UI lives in ui.html. It's read from next to this module
 * (dist/ after build, src/web/ in dev).
 */
function loadUi(): string {
  const candidates = [new URL("./ui.html", import.meta.url), new URL("../src/web/ui.html", import.meta.url)];
  for (const c of candidates) {
    const p = fileURLToPath(c);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "<!doctype html><p>ui.html not found. Run <code>npm run build</code>.</p>";
}

export const UI_HTML = loadUi();

const fontCache = new Map<string, Buffer | null>();

/** Bundled fonts (OFL), served locally so the app works offline. */
export function loadFont(name: string): Buffer | null {
  if (fontCache.has(name)) return fontCache.get(name)!;
  let data: Buffer | null = null;
  for (const base of ["./fonts/", "../src/web/fonts/"]) {
    const p = fileURLToPath(new URL(`${base}${name}.woff2`, import.meta.url));
    if (existsSync(p)) {
      data = readFileSync(p);
      break;
    }
  }
  fontCache.set(name, data);
  return data;
}
