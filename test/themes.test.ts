import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The themes live entirely in ui.html, so these tests read the stylesheet that actually ships.
const html = readFileSync(join(import.meta.dirname, "../src/web/ui.html"), "utf8");
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

type Tokens = Record<string, string>;
const decls = (body: string): Tokens => {
  const out: Tokens = {};
  // Values can span lines and contain url("…;…") or commas, but never a bare ";" outside quotes.
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*((?:[^;"]|"[^"]*")+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
};
const block = (selector: string): Tokens => {
  const i = css.indexOf(selector + " {");
  if (i < 0) throw new Error(`no ${selector} block`);
  return decls(css.slice(i + selector.length + 2, css.indexOf("\n}", i)));
};

export const base = block(":root");
export const themeIds = [...css.matchAll(/:root\[data-theme="(\w+)"\] \{/g)].map((m) => m[1]!);
export const tokens = (id: string): Tokens => (id === "light" ? { ...base } : { ...base, ...block(`:root[data-theme="${id}"]`) });

/** Substitutes var() references, as the browser does on :root. */
export function resolve(t: Tokens, value: string, depth = 0): string {
  if (depth > 10) throw new Error(`var() cycle in ${value}`);
  return value.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name: string, fallback?: string) =>
    resolve(t, t[name] ?? fallback ?? "", depth + 1),
  );
}

type RGBA = [number, number, number, number];
export function parse(c: string): RGBA {
  c = c.trim();
  let m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)).concat(1) as RGBA;
  m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) return [+m[1]!, +m[2]!, +m[3]!, m[4] === undefined ? 1 : +m[4]];
  // color-mix(in srgb, <colour> P%, transparent): the colour at alpha P (premultiplied mixing).
  m = c.match(/^color-mix\(in srgb,\s*(#[0-9a-f]{6})\s+([\d.]+)%,\s*transparent\)$/i);
  if (m) { const [r, g, b] = parse(m[1]!); return [r, g, b, +m[2]! / 100]; }
  throw new Error(`can't parse colour ${c}`);
}
const over = (top: RGBA, under: RGBA): RGBA => {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a)).concat(1) as RGBA;
};
const lum = ([r, g, b]: RGBA) => {
  const ch = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
export const contrast = (x: RGBA, y: RGBA) => {
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi! + 0.05) / (lo! + 0.05);
};

/**
 * What can sit behind text: the page colour alone, and the page with the theme's light field at
 * its brightest. Every stop of the backdrop is stacked on top, which no real pixel exceeds.
 */
export function backdrops(t: Tokens): RGBA[] {
  const bg = parse(resolve(t, t["--bg"]!));
  const field = [...resolve(t, t["--backdrop"] ?? "none").matchAll(/rgba\([^)]*\)/g)].map((m) => parse(m[0]));
  return [bg, field.reduce((acc, c) => over(c, acc), bg)];
}

/** The lowest contrast of a token's colour against a surface, over every backdrop. */
export function worst(t: Tokens, fg: string, surface?: string): number {
  const f = parse(resolve(t, t[fg]!));
  return Math.min(...backdrops(t).map((b) => {
    const s = surface ? over(parse(resolve(t, t[surface]!)), b) : b;
    return contrast(over(f, s), s);
  }));
}

describe("themes", () => {
  it("defines the new themes alongside Paper and Espresso", () => {
    expect(themeIds).toEqual(["dark", "glass", "void", "terminal"]);
  });

  it("gives every theme the whole palette, so nothing leaks in from Paper", () => {
    // Espresso set the bar for what a dark theme must override; the new themes must cover it too.
    const required = Object.keys(block(':root[data-theme="dark"]'));
    for (const id of themeIds.filter((x) => x !== "dark")) {
      const own = block(`:root[data-theme="${id}"]`);
      expect(required.filter((k) => !(k in own)), id).toEqual([]);
      for (const k of ["--overlay", "--backdrop", "--orb", "--orb-a", "--orb-b"]) expect(own, `${id} ${k}`).toHaveProperty(k);
    }
  });

  it("keeps the OS dark default from applying over a chosen theme", () => {
    // It used to be :root:not([data-theme="light"]), which put Espresso under every other theme.
    expect(css).toContain(":root:not([data-theme]) {");
    expect(css).not.toContain(':not([data-theme="light"])');
  });

  it("drops translucency for anyone who asked for less of it or more contrast", () => {
    const rule = css.slice(css.indexOf("@media (prefers-reduced-transparency: reduce), (prefers-contrast: more)"));
    // Must match the theme selectors' specificity to beat them; a bare :root would lose.
    expect(rule).toMatch(/^[^}]*:root\[data-theme\] \{ --glass: 100%; \}/);
    // And every translucent panel is built on --glass, so that one switch reaches all of them.
    for (const id of themeIds.filter((x) => x !== "dark"))
      for (const k of ["--panel", "--side"]) expect(block(`:root[data-theme="${id}"]`)[k], `${id} ${k}`).toContain("var(--glass)");
  });

  it("restores the theme before the first paint, and only a theme that exists", () => {
    const head = html.slice(0, html.indexOf("<style>"));
    const allowed = head.match(/\/\^\(([\w|]+)\)\$\//)?.[1]?.split("|");
    expect(allowed?.sort()).toEqual(["light", ...themeIds].sort());
  });

  it("lists every theme and orb in the picker, and every orb has a painter", () => {
    const list = (name: string) => [...(html.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))?.[1] ?? "").matchAll(/id: "(\w+)"/g)].map((m) => m[1]);
    expect(list("THEMES").sort()).toEqual(["auto", "light", ...themeIds].sort());
    const orbs = list("ORBS").filter((o) => o !== "auto");
    const painters = [...(html.match(/const ORB_PAINTERS = \{([^}]*)\}/)?.[1] ?? "").matchAll(/(\w+):/g)].map((m) => m[1]);
    expect(orbs.sort()).toEqual(painters.sort());
    // Each theme's default orb is one the picker offers.
    for (const id of ["light", ...themeIds]) expect(orbs, id).toContain(resolve(tokens(id), tokens(id)["--orb"]!));
  });

  // WCAG 2.2: 4.5:1 for body text, 3:1 for large text and UI parts. Translucent panels have no
  // single contrast ratio, so each check is made against the brightest the light field gets.
  describe.each(["light", ...themeIds])("contrast in %s", (id) => {
    const t = tokens(id);
    it("body text on the page, panels, sidebar and overlays", () => {
      for (const s of [undefined, "--panel", "--side", "--overlay"]) expect(worst(t, "--text", s), String(s)).toBeGreaterThanOrEqual(7);
    });
    it("secondary text and links", () => {
      for (const s of [undefined, "--panel"]) {
        expect(worst(t, "--muted", s), `muted ${s}`).toBeGreaterThanOrEqual(4.5);
        expect(worst(t, "--accent", s), `accent ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it("faint labels and status colours", () => {
      expect(worst(t, "--faint", "--panel")).toBeGreaterThanOrEqual(2.8);
      for (const c of ["--danger", "--ok", "--warn"]) expect(worst(t, c, "--panel"), c).toBeGreaterThanOrEqual(3);
    });
    it("text on filled buttons and the toast", () => {
      const solid = (fg: string, bg: string) => contrast(parse(resolve(t, t[fg]!)), parse(resolve(t, t[bg]!)));
      expect(solid("--on-accent", "--accent")).toBeGreaterThanOrEqual(4.5);
      expect(solid("--toast-fg", "--toast-bg")).toBeGreaterThanOrEqual(7);
    });
  });
});
