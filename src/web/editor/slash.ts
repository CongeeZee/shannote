/**
 * Notion-style slash commands: type "/" at the start of a line (or after a space)
 * to turn the line into a heading, list, toggle and so on, or "/page Title" to
 * create a new note and link to it. Everything inserted is plain markdown that
 * Obsidian understands (toggles are foldable callouts: `> [!toggle]-`).
 */
import { autocompletion, type Completion, type CompletionContext, type CompletionResult, startCompletion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export type CreateNote = (title: string) => void;

/** A menu entry; `icon` is drawn by the addToOptions renderer below. */
type SlashOption = Completion & { icon: string };

interface Command {
  name: string;
  label: string;
  aliases: string[];
  icon: string;
  run: (view: EditorView, from: number, to: number) => void;
}

/** Existing block marker at the start of a line: heading, task, bullet, number or quote/callout. */
const MARKER = /^(\s*)(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> \[![\w-]+\][-+]? ?|> )?/;

/** Removes the typed "/command", then gives the line a new block marker (replacing any old one). */
function setPrefix(prefix: string, after = "") {
  return (view: EditorView, from: number, to: number) => {
    const line = view.state.doc.lineAt(from);
    // "/h2" typed after some words: drop the space that came before the slash too.
    const after0 = line.text.slice(to - line.from);
    const text = (after0 ? line.text.slice(0, from - line.from) : line.text.slice(0, from - line.from).trimEnd()) + after0;
    const m = text.match(MARKER)!;
    const indent = m[1]!, old = m[2] ?? "";
    const rest = text.slice(indent.length + old.length);
    const caret = Math.min(rest.length, Math.max(0, from - line.from - indent.length - old.length));
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: indent + prefix + rest + after },
      selection: { anchor: line.from + indent.length + prefix.length + caret },
      scrollIntoView: true,
      userEvent: "input.complete",
    });
  };
}

/** Replaces the typed "/command" with whole lines; `|` marks where the cursor goes. */
function insertBlock(block: string) {
  return (view: EditorView, from: number, to: number) => {
    const line = view.state.doc.lineAt(from);
    const rest = (line.text.slice(0, from - line.from) + line.text.slice(to - line.from)).trim();
    let text = block.replace("$", rest);
    // A "---" straight under a paragraph would turn that paragraph into a heading.
    const prev = line.number > 1 ? view.state.doc.line(line.number - 1).text : "";
    if (block.startsWith("---") && prev.trim()) text = "\n" + text;
    const caret = text.indexOf("|");
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: text.replace("|", "") },
      selection: { anchor: line.from + caret },
      scrollIntoView: true,
      userEvent: "input.complete",
    });
  };
}

const COMMANDS: Command[] = [
  { name: "page", label: "New note", aliases: ["note", "new", "subpage"], icon: "📄", run: startPage },
  { name: "toggle", label: "Toggle", aliases: ["fold", "collapse", "details"], icon: "▸", run: setPrefix("> [!toggle]- ", "\n> ") },
  { name: "bullet", label: "Bulleted list", aliases: ["list", "ul", "-"], icon: "•", run: setPrefix("- ") },
  { name: "numbered", label: "Numbered list", aliases: ["ol", "number", "1."], icon: "1.", run: setPrefix("1. ") },
  { name: "todo", label: "To-do", aliases: ["task", "checkbox", "check"], icon: "☐", run: setPrefix("- [ ] ") },
  { name: "h1", label: "Heading 1", aliases: ["heading", "title", "#"], icon: "H1", run: setPrefix("# ") },
  { name: "h2", label: "Heading 2", aliases: ["heading", "subheading", "##"], icon: "H2", run: setPrefix("## ") },
  { name: "h3", label: "Heading 3", aliases: ["heading", "###"], icon: "H3", run: setPrefix("### ") },
  { name: "text", label: "Plain text", aliases: ["paragraph", "plain"], icon: "¶", run: setPrefix("") },
  { name: "quote", label: "Quote", aliases: ["blockquote", ">"], icon: "❝", run: setPrefix("> ") },
  { name: "callout", label: "Callout", aliases: ["note", "info", "tip", "warning"], icon: "💡", run: setPrefix("> [!note] ", "\n> ") },
  { name: "code", label: "Code block", aliases: ["snippet", "```"], icon: "</>", run: insertBlock("```\n$|\n```") },
  { name: "divider", label: "Divider", aliases: ["hr", "line", "rule", "---"], icon: "—", run: insertBlock("---\n|") },
];

/** Picking "New note" without a title yet: leave "/page " in place and ask for one. */
function startPage(view: EditorView, from: number, to: number) {
  view.dispatch({ changes: { from, to, insert: "/page " }, selection: { anchor: from + 6 }, userEvent: "input.complete" });
  startCompletion(view);
}

function rank(cmd: Command, q: string) {
  if (!q) return 0;
  if (cmd.name.startsWith(q)) return 1;
  if (cmd.aliases.some((a) => a.startsWith(q)) || cmd.label.toLowerCase().startsWith(q)) return 2;
  if (cmd.label.toLowerCase().includes(q)) return 3;
  return -1;
}

const toOption = (cmd: Command): SlashOption => ({
  label: cmd.label,
  detail: "/" + cmd.name,
  icon: cmd.icon,
  apply: (view, _c, from, to) => cmd.run(view, from, to),
});

function source(createNote: CreateNote) {
  return (ctx: CompletionContext): CompletionResult | null => {
    // "/page My title" (or "/note …") takes the rest of the line as the new note's title.
    const page = ctx.matchBefore(/(?:^|(?<=\s))\/(?:page|note) [^\n]*$/);
    if (page) {
      const title = page.text.replace(/^\/\w+ /, "").trim().replace(/[[\]|#^]/g, "");
      const option: SlashOption = title
        ? {
            label: `New note “${title}”`,
            detail: "creates it and links here",
            icon: "📄",
            apply: (view, _c, from, to) => {
              const link = `[[${title}]]`;
              view.dispatch({ changes: { from, to, insert: link }, selection: { anchor: from + link.length }, userEvent: "input.complete" });
              createNote(title);
            },
          }
        : { label: "Type a title for the new note…", icon: "📄", apply: () => {} };
      return { from: page.from, filter: false, options: [option] };
    }
    const m = ctx.matchBefore(/(?:^|(?<=\s))\/[\w#>.`-]*$/);
    if (!m) return null;
    const q = m.text.slice(1).toLowerCase();
    const options = COMMANDS.map((c) => [c, rank(c, q)] as const)
      .filter(([, r]) => r >= 0)
      .sort((a, b) => a[1] - b[1])
      .map(([c]) => toOption(c));
    if (!options.length) return null;
    return { from: m.from, filter: false, options };
  };
}

const menuTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    boxShadow: "var(--shadow-lift)",
    padding: "5px",
    fontFamily: "var(--sans)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--sans)", maxHeight: "18em", minWidth: "250px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "5px 10px !important",
    borderRadius: "8px",
    color: "var(--text)",
    fontSize: "14px",
    fontWeight: "600",
    lineHeight: "1.5",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--accent-soft)", color: "var(--text)" },
  ".cm-completionIcon": { display: "none" },
  ".cm-slash-icon": {
    width: "26px",
    height: "26px",
    flex: "none",
    display: "grid",
    placeItems: "center",
    borderRadius: "7px",
    border: "1px solid var(--border)",
    background: "var(--panel-2)",
    color: "var(--muted)",
    fontSize: "12px",
    fontWeight: "750",
  },
  ".cm-completionLabel": { flex: "1" },
  ".cm-completionDetail": { marginLeft: "auto", fontStyle: "normal", fontFamily: "var(--mono)", fontSize: "12px", color: "var(--faint)" },
});

export function slashCommands(createNote: CreateNote): Extension {
  return [
    autocompletion({
      override: [source(createNote)],
      icons: false,
      closeOnBlur: true,
      addToOptions: [{
        position: 20,
        render: (c) => {
          const el = document.createElement("span");
          el.className = "cm-slash-icon";
          el.textContent = (c as SlashOption).icon ?? "";
          return el;
        },
      }],
    }),
    menuTheme,
  ];
}
