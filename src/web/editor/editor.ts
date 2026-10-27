/**
 * Browser-side note editor: CodeMirror 6 with markdown "live preview"
 * (markup is hidden except on the line you're editing) and optional vim keys.
 * Bundled by esbuild into dist/editor.js and exposed as window.ShannoteEditor.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, type Extension, RangeSetBuilder, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  MatchDecorator,
  placeholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import { slashCommands } from "./slash";

export interface EditorOptions {
  doc: string;
  vim?: boolean;
  readOnly?: boolean;
  onChange?: (doc: string) => void;
  onSave?: () => void;
  onQuit?: () => void;
  onOpenLink?: (target: string) => void;
  onVimMode?: (mode: string) => void;
  /** "/page Title" inserted a [[Title]] link; create that note. */
  onCreateNote?: (title: string) => void;
}

// ------------------------------------------------------------------ live preview

/** Markup that's hidden when the cursor isn't on its line. */
const HIDE = new Set(["HeaderMark", "EmphasisMark", "CodeMark", "StrikethroughMark", "QuoteMark"]);

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-task-box";
    box.setAttribute("aria-label", this.checked ? "Mark not done" : "Mark done");
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", () => {
      // pos points at the "[" of "[ ]"; flip the character inside.
      const inside = view.state.doc.sliceString(this.pos + 1, this.pos + 2);
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: inside === " " ? "x" : " " } });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-bullet";
    s.textContent = "•";
    return s;
  }
}

function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) lines.add(i);
  }
  return lines;
}

function buildPreview(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(view);
  const marks: Array<{ from: number; to: number; deco: Decoration }> = [];
  const onActive = (pos: number) => active.has(state.doc.lineAt(pos).number);

  // Frontmatter at the very top is shown faint and small.
  const fmEnd = frontmatterEnd(state);
  if (fmEnd && state.selection.main.head <= fmEnd) {
    const last = state.doc.lineAt(Math.max(0, fmEnd - 1)).number;
    for (let i = 1; i <= last; i++) {
      const l = state.doc.line(i);
      marks.push({ from: l.from, to: l.from, deco: Decoration.line({ class: "cm-fm" }) });
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.from < fmEnd) return node.name === "Document" ? undefined : false;
        const name = node.name;
        const heading = name.match(/^ATXHeading(\d)$/);
        if (heading) {
          marks.push({ from: node.from, to: node.from, deco: Decoration.line({ class: `cm-h cm-h${heading[1]}` }) });
          return;
        }
        if (name === "Blockquote") {
          for (let p = node.from; p <= node.to; ) {
            const l = state.doc.lineAt(p);
            marks.push({ from: l.from, to: l.from, deco: Decoration.line({ class: "cm-quote" }) });
            p = l.to + 1;
          }
          return;
        }
        if (name === "FencedCode") {
          for (let p = node.from; p <= node.to; ) {
            const l = state.doc.lineAt(p);
            marks.push({ from: l.from, to: l.from, deco: Decoration.line({ class: "cm-codeblock" }) });
            p = l.to + 1;
          }
          return false;
        }
        if (onActive(node.from)) return;
        if (HIDE.has(name)) {
          // Swallow the space after "#" / ">" too.
          let end = node.to;
          if ((name === "HeaderMark" || name === "QuoteMark") && state.doc.sliceString(end, end + 1) === " ") end++;
          if (end > node.from) marks.push({ from: node.from, to: end, deco: Decoration.replace({}) });
          return;
        }
        if (name === "TaskMarker") {
          const checked = /x/i.test(state.doc.sliceString(node.from, node.to));
          marks.push({ from: node.from, to: node.to, deco: Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }) });
          if (checked) {
            const line = state.doc.lineAt(node.to);
            if (line.to > node.to + 1) marks.push({ from: node.to + 1, to: line.to, deco: Decoration.mark({ class: "cm-done" }) });
          }
          return;
        }
        if (name === "ListMark") {
          const txt = state.doc.sliceString(node.from, node.to);
          const after = state.doc.sliceString(node.to, node.to + 4);
          // Hide the bullet on task lines (the checkbox replaces it); show "•" for plain bullets.
          if (/^ \[[ xX]\]/.test(after)) marks.push({ from: node.from, to: node.to + 1, deco: Decoration.replace({}) });
          else if (/^[-*+]$/.test(txt)) marks.push({ from: node.from, to: node.to, deco: Decoration.replace({ widget: new BulletWidget() }) });
          return;
        }
        if (name === "Link") {
          // [text](url) → text styled as a link; hide brackets and url.
          const text = state.doc.sliceString(node.from, node.to);
          const m = text.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
          if (m) {
            marks.push({ from: node.from, to: node.from + 1, deco: Decoration.replace({}) });
            marks.push({
              from: node.from + 1,
              to: node.from + 1 + m[1]!.length,
              deco: Decoration.mark({ class: "cm-link", attributes: { "data-href": m[2]! } }),
            });
            marks.push({ from: node.from + 1 + m[1]!.length, to: node.to, deco: Decoration.replace({}) });
          }
          return false;
        }
        return;
      },
    });
  }

  // [[wikilinks]]: hide the brackets (and target, when there's an alias) off the active line.
  const text = state.doc.toString();
  const re = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/g;
  for (const { from, to } of view.visibleRanges) {
    re.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && m.index < to) {
      const start = m.index;
      const end = start + m[0].length;
      if (start < fmEnd) continue;
      const target = m[1]!;
      const attrs = { class: "cm-wikilink", attributes: { "data-target": target } };
      if (onActive(start)) {
        marks.push({ from: start, to: end, deco: Decoration.mark(attrs) });
        continue;
      }
      if (m[2]) {
        marks.push({ from: start, to: start + 3 + target.length, deco: Decoration.replace({}) });
        marks.push({ from: start + 3 + target.length, to: end - 2, deco: Decoration.mark(attrs) });
      } else {
        marks.push({ from: start, to: start + 2, deco: Decoration.replace({}) });
        marks.push({ from: start + 2, to: end - 2, deco: Decoration.mark(attrs) });
      }
      marks.push({ from: end - 2, to: end, deco: Decoration.replace({}) });
    }
  }

  // RangeSetBuilder needs sorted input; line decorations (zero width) go first at a position.
  marks.sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let lastTo = -1;
  for (const m of marks) {
    const isReplace = m.to > m.from && (m.deco as unknown as { point: boolean }).point;
    // Skip replacements that overlap an earlier one (e.g. nested marks).
    if (isReplace && m.from < lastTo) continue;
    try {
      builder.add(m.from, m.to, m.deco);
      if (isReplace) lastTo = m.to;
    } catch {
      /* out-of-order edge case: drop it rather than break the editor */
    }
  }
  return builder.finish();
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildPreview(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = buildPreview(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ------------------------------------------------------------------ frontmatter fold

function frontmatterEnd(state: EditorState): number {
  const m = state.doc.sliceString(0, Math.min(state.doc.length, 4000)).match(/^---\n[\s\S]*?\n---(?=\n|$)/);
  return m ? m[0].length : 0;
}

class PropsWidget extends WidgetType {
  constructor(readonly count: number) {
    super();
  }
  eq(o: PropsWidget) {
    return o.count === this.count;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-props";
    el.textContent = `Properties · ${this.count}`;
    el.title = "Click to edit the note's properties (frontmatter)";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: 4 } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** Folds the frontmatter into one "Properties" chip unless the cursor is inside it. */
const frontmatterFold = StateField.define<DecorationSet>({
  create: (state) => buildFold(state),
  update: (deco, tr) => (tr.docChanged || tr.selection ? buildFold(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

function buildFold(state: EditorState): DecorationSet {
  const end = frontmatterEnd(state);
  if (!end) return Decoration.none;
  const head = state.selection.main.head;
  if (head <= end) return Decoration.none;
  const lines = state.doc.sliceString(0, end).split("\n").filter((l) => /^[\w-]+:/.test(l)).length;
  return Decoration.set([Decoration.replace({ widget: new PropsWidget(lines), block: true }).range(0, end)]);
}

// #tags as pills (always, since they're plain text anyway).
const tagMatcher = new MatchDecorator({
  regexp: /(?<=^|\s)#[\p{L}\p{N}_\-/]+/gu,
  decoration: Decoration.mark({ class: "cm-tag" }),
});
const tagPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = tagMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = tagMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

const highlight = HighlightStyle.define([
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--faint)" },
  { tag: t.monospace, fontFamily: "var(--mono)", fontSize: ".88em", background: "var(--panel-2)", borderRadius: "5px", padding: "0 3px" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--faint)" },
  { tag: [t.processingInstruction, t.meta], color: "var(--faint)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: t.contentSeparator, color: "var(--faint)" },
]);

const theme = EditorView.theme({
  "&": { fontFamily: "var(--serif)", fontSize: "16.5px", color: "var(--text)", background: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.75", overflow: "visible" },
  ".cm-content": { padding: "0", caretColor: "var(--accent)", minHeight: "50vh" },
  ".cm-line": { padding: "0 2px" },
  ".cm-activeLine": { background: "color-mix(in srgb, var(--panel-2) 55%, transparent)", borderRadius: "6px" },
  "&:not(.cm-focused) .cm-activeLine": { background: "transparent" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { background: "var(--mark) !important" },
  ".cm-h": { fontFamily: "var(--display)", fontWeight: "560", letterSpacing: "-.01em", lineHeight: "1.35" },
  ".cm-h1": { fontSize: "1.6em", paddingTop: ".5em" },
  ".cm-h2": { fontSize: "1.32em", paddingTop: ".6em" },
  ".cm-h3": { fontSize: "1.12em", paddingTop: ".4em" },
  ".cm-h4, .cm-h5, .cm-h6": { fontSize: "1em" },
  ".cm-fm": { fontFamily: "var(--mono)", fontSize: "12.5px", color: "var(--faint)", lineHeight: "1.6" },
  ".cm-quote": { borderLeft: "3px solid var(--border-strong)", paddingLeft: "14px !important", color: "var(--muted)", fontStyle: "italic" },
  ".cm-codeblock": { fontFamily: "var(--mono)", fontSize: "13.5px", background: "var(--panel-2)", lineHeight: "1.6" },
  ".cm-wikilink": { color: "var(--accent)", cursor: "pointer", background: "linear-gradient(transparent 62%, color-mix(in srgb, var(--accent-soft) 85%, transparent) 62%)" },
  ".cm-link": { color: "var(--accent)", textDecoration: "underline", textDecorationColor: "var(--accent-soft)", cursor: "pointer" },
  ".cm-tag": { fontFamily: "var(--sans)", fontSize: ".82em", fontWeight: "700", background: "var(--panel-2)", color: "var(--muted)", borderRadius: "999px", padding: "1px 7px" },
  ".cm-done": { color: "var(--faint)", textDecoration: "line-through" },
  ".cm-bullet": { color: "var(--faint)", padding: "0 .3em 0 .1em" },
  ".cm-task-box": { verticalAlign: "-3px", marginRight: "6px !important" },
  ".cm-props": { display: "inline-block", fontFamily: "var(--sans)", fontSize: "12.5px", fontWeight: "700", color: "var(--faint)", background: "var(--panel-2)", border: "1px dashed var(--border-strong)", borderRadius: "999px", padding: "1px 10px", margin: "0 0 4px", cursor: "pointer" },
  ".cm-props:hover": { color: "var(--accent)", borderColor: "var(--accent)" },
  ".cm-placeholder": { color: "var(--faint)", fontStyle: "italic" },
  ".cm-vim-panel, .cm-panels": { background: "var(--panel-2)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: "13px", borderTop: "1px solid var(--border)" },
  ".cm-vim-panel input": { color: "var(--text)", background: "transparent", fontFamily: "var(--mono)" },
  ".cm-fat-cursor": { background: "color-mix(in srgb, var(--accent) 55%, transparent) !important", color: "var(--on-accent) !important" },
  "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid var(--accent)" },
});

// ------------------------------------------------------------------ vim ex commands

let vimHandlers: { save?: () => void; quit?: () => void } = {};
let exDefined = false;
function defineEx() {
  if (exDefined) return;
  exDefined = true;
  Vim.defineEx("write", "w", () => vimHandlers.save?.());
  Vim.defineEx("quit", "q", () => vimHandlers.quit?.());
  Vim.defineEx("wq", "wq", () => {
    vimHandlers.save?.();
    vimHandlers.quit?.();
  });
  Vim.defineEx("xit", "x", () => {
    vimHandlers.save?.();
    vimHandlers.quit?.();
  });
  // jk / jj are common insert-mode escapes; leave defaults alone but allow Ctrl-[.
}

// ------------------------------------------------------------------ public API

export function create(parent: HTMLElement, opts: EditorOptions) {
  defineEx();
  const vimSlot = new Compartment();
  const roSlot = new Compartment();

  const extensions: Extension[] = [
    vimSlot.of(opts.vim ? vim({ status: true }) : []),
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, addKeymap: true }),
    syntaxHighlighting(highlight),
    livePreview,
    frontmatterFold,
    tagPlugin,
    slashCommands((title) => opts.onCreateNote?.(title)),
    theme,
    placeholder("Start writing… (type / for commands; markdown works: # heading, **bold**, - [ ] task, [[link]])"),
    roSlot.of([EditorState.readOnly.of(!!opts.readOnly), EditorView.editable.of(!opts.readOnly)]),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (opts.onSave?.(), true) },
      { key: "Mod-b", run: (v) => wrap(v, "**") },
      { key: "Mod-i", run: (v) => wrap(v, "*") },
      { key: "Mod-Enter", run: (v) => toggleTask(v) },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange?.(u.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      click: (e) => {
        const el = (e.target as HTMLElement).closest("[data-target],[data-href]") as HTMLElement | null;
        if (!el) return false;
        // Plain click edits; Ctrl/Cmd-click (or a click while not focused) follows the link.
        if (!(e.ctrlKey || e.metaKey)) return false;
        e.preventDefault();
        if (el.dataset.target) opts.onOpenLink?.(el.dataset.target);
        else if (el.dataset.href) window.open(el.dataset.href, "_blank", "noopener");
        return true;
      },
    }),
  ];

  // Start the cursor after the frontmatter (so it's folded) and the title line.
  const start = EditorState.create({ doc: opts.doc });
  const fmEnd = frontmatterEnd(start);
  const afterTitle = start.doc.sliceString(fmEnd).match(/^\s*#[^\n]*\n?/);
  const anchor = Math.min(start.doc.length, fmEnd + (afterTitle ? afterTitle[0].length : fmEnd ? 1 : 0));
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: opts.doc, extensions, selection: EditorSelection.cursor(anchor) }),
  });
  const bindVim = () => {
    vimHandlers = { save: opts.onSave, quit: opts.onQuit };
    const cm = getCM(view);
    if (cm && opts.onVimMode) {
      cm.on("vim-mode-change", (e: { mode: string; subMode?: string }) => opts.onVimMode!(e.subMode ? `${e.mode} ${e.subMode}` : e.mode));
      opts.onVimMode("normal");
    }
  };
  if (opts.vim) bindVim();
  view.contentDOM.addEventListener("focus", () => (vimHandlers = { save: opts.onSave, quit: opts.onQuit }));

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    /** Replaces the text (e.g. after someone else saved), keeping the cursor near where it was. */
    setDoc(doc: string) {
      const cur = view.state.doc.toString();
      if (cur === doc) return;
      // Minimal change: common prefix/suffix, so the cursor and scroll stay put.
      let a = 0;
      while (a < cur.length && a < doc.length && cur[a] === doc[a]) a++;
      let b = 0;
      while (b < cur.length - a && b < doc.length - a && cur[cur.length - 1 - b] === doc[doc.length - 1 - b]) b++;
      view.dispatch({ changes: { from: a, to: cur.length - b, insert: doc.slice(a, doc.length - b) } });
    },
    setVim(on: boolean) {
      view.dispatch({ effects: vimSlot.reconfigure(on ? vim({ status: true }) : []) });
      if (on) bindVim();
      else opts.onVimMode?.("");
      view.focus();
    },
    setReadOnly(ro: boolean) {
      view.dispatch({ effects: roSlot.reconfigure([EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]) });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

function wrap(view: EditorView, mark: string): boolean {
  const changes = view.state.changeByRange((r) => {
    const text = view.state.sliceDoc(r.from, r.to);
    if (text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2)
      return { changes: { from: r.from, to: r.to, insert: text.slice(mark.length, -mark.length) }, range: r.from === r.to ? r : { from: r.from, to: r.to - mark.length * 2 } as never };
    return {
      changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }],
      range: (r.empty ? { anchor: r.from + mark.length } : { anchor: r.from + mark.length, head: r.to + mark.length }) as never,
    };
  });
  view.dispatch(view.state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  return true;
}

/** Ctrl-Enter: turn the line into a task, or tick/untick it. */
function toggleTask(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = line.text.match(/^(\s*)([-*+] )?(\[[ xX]\] )?/)!;
  const indent = m[1]!.length;
  let change;
  if (m[3]) {
    const pos = line.from + indent + (m[2]?.length ?? 0) + 1;
    change = { from: pos, to: pos + 1, insert: /x/i.test(m[3]) ? " " : "x" };
  } else if (m[2]) change = { from: line.from + indent + m[2].length, insert: "[ ] " };
  else change = { from: line.from + indent, insert: "- [ ] " };
  view.dispatch({ changes: change });
  return true;
}

declare global {
  interface Window {
    ShannoteEditor: { create: typeof create };
  }
}
window.ShannoteEditor = { create };
