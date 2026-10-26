import { Marked, type Tokens } from "marked";
import type { LinkResolver } from "../vault/resolve.js";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CALLOUT_ICONS: Record<string, string> = {
  note: "✎", info: "ℹ", tip: "★", hint: "★", important: "!", success: "✓", check: "✓", done: "✓",
  question: "?", help: "?", faq: "?", warning: "⚠", caution: "⚠", attention: "⚠", danger: "⚡",
  error: "✕", failure: "✕", bug: "✕", example: "▸", quote: "❝", todo: "☐", abstract: "≡", summary: "≡",
};

/**
 * Renders a note body to HTML for the web app:
 * - raw HTML in notes is escaped, not rendered
 * - [[wikilinks]] become in-app links (or "missing" spans)
 * - Obsidian callouts (> [!type]- Title) become styled, optionally collapsible boxes
 */
export function renderMarkdown(body: string, resolver: LinkResolver, fromPath: string): string {
  const md = new Marked({ gfm: true, breaks: false });
  md.use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start: (src: string) => {
          const i = src.indexOf("[[");
          return i === -1 ? undefined : i > 0 && src[i - 1] === "!" ? i - 1 : i;
        },
        tokenizer(src: string) {
          const m = /^(!?)\[\[([^\[\]\n]+?)\]\]/.exec(src);
          if (!m) return undefined;
          const inner = m[2]!.replace(/\\\|/g, "|");
          const [left, alias] = inner.split("|", 2) as [string, string | undefined];
          const [target, heading] = left.split("#", 2) as [string, string | undefined];
          return {
            type: "wikilink",
            raw: m[0],
            embed: m[1] === "!",
            target: target.trim(),
            heading: heading?.trim(),
            alias: alias?.trim(),
          };
        },
        renderer(token: Tokens.Generic) {
          const { target, heading, alias, embed } = token as unknown as {
            target: string; heading?: string; alias?: string; embed: boolean;
          };
          const label = esc(alias || (target ? target.split("/").pop()! : "") + (heading ? ` › ${heading}` : "") || heading || "");
          const resolved = resolver.resolve(target, fromPath);
          if (!resolved) return `<span class="wikilink missing" title="No note called ${esc(target)}">${label}</span>`;
          const href = `#/note/${encodeURIComponent(resolved)}${heading ? `?h=${encodeURIComponent(heading)}` : ""}`;
          return `<a class="wikilink${embed ? " embed" : ""}" href="${href}">${embed ? "↳ " : ""}${label}</a>`;
        },
      },
    ],
    renderer: {
      html(token: Tokens.HTML | Tokens.Tag) {
        return esc(token.text);
      },
      blockquote(this: { parser: { parse(t: unknown[]): string } }, token: Tokens.Blockquote) {
        const m = token.text.match(/^\[!([\w-]+)\]([-+]?)[ \t]*([^\n]*)\n?([\s\S]*)$/);
        if (!m) return `<blockquote>${this.parser.parse(token.tokens)}</blockquote>\n`;
        const type = m[1]!.toLowerCase();
        const fold = m[2];
        const title = m[3]!.trim() || type[0]!.toUpperCase() + type.slice(1);
        const inner = md.parse(m[4]!) as string;
        const icon = CALLOUT_ICONS[type] ?? "▸";
        const head = `<span class="callout-icon">${icon}</span><span>${md.parseInline(title) as string}</span>`;
        if (fold)
          return `<details class="callout callout-${esc(type)}"${fold === "+" ? " open" : ""}><summary class="callout-title">${head}</summary><div class="callout-body">${inner}</div></details>\n`;
        return `<div class="callout callout-${esc(type)}"><div class="callout-title">${head}</div><div class="callout-body">${inner}</div></div>\n`;
      },
      heading(this: { parser: { parseInline(t: unknown[]): string } }, token: Tokens.Heading) {
        const text = this.parser.parseInline(token.tokens);
        const id = token.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
        return `<h${token.depth} id="h-${esc(id)}" data-heading="${esc(token.text)}">${text}</h${token.depth}>\n`;
      },
      link(this: { parser: { parseInline(t: unknown[]): string } }, token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens);
        const href = token.href.trim();
        if (/^(javascript|data|vbscript):/i.test(href)) return text;
        const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
        return `<a href="${esc(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${text}</a>`;
      },
      image(token: Tokens.Image) {
        return `<span class="embed-file">🖼 ${esc(token.text || token.href)}</span>`;
      },
    },
  });
  return decorate(md.parse(body) as string);
}

const TASK_DATE_RE = /(📅|📆|🗓️?|⏳|🛫|✅)\s*(\d{4}-\d{2}-\d{2})/gu;
const TAG_RE = /(^|[\s(>])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

/** Shows task dates and #tags as pills, leaving code and tag attributes alone. */
function decorate(html: string): string {
  return html
    .split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|<[^>]+>)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(TASK_DATE_RE, '<span class="pill">$1 $2</span>')
            .replace(TAG_RE, '$1<span class="pill">#$2</span>'),
    )
    .join("");
}
