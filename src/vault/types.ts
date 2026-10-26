export interface Heading {
  level: number;
  text: string;
  /** 1-based line number in the full file (including frontmatter). */
  line: number;
}

export interface Link {
  /** Raw link target as written, without heading or alias: `[[Note#H|alias]]` → `Note`. */
  target: string;
  heading?: string;
  alias?: string;
  embed: boolean;
  /** True when the link appears inside frontmatter (e.g. a `related:` list). */
  inFrontmatter: boolean;
  line: number;
}

export type TaskStatus = "todo" | "done" | "cancelled" | "in_progress" | "other";

export interface Task {
  /**
   * Stable identifier. Uses an explicit Obsidian Tasks `🆔 id` when present;
   * otherwise a hash of the note path and the task's text (stable when the task
   * moves within the note, changes if its text is edited).
   */
  id: string;
  line: number;
  /** Task text with date/id markers removed. */
  text: string;
  /** The full original line. */
  raw: string;
  statusChar: string;
  status: TaskStatus;
  due?: string;
  scheduled?: string;
  start?: string;
  doneDate?: string;
  recurrence?: string;
  tags: string[];
  indent: number;
}

export interface ParsedNote {
  /** Vault-relative POSIX path, e.g. `notes/Thesis scope.md`. */
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  /** Set when frontmatter exists but is not valid YAML. */
  frontmatterError?: string;
  /** Body text with frontmatter removed. */
  body: string;
  /** Number of lines the frontmatter block occupies (0 if none). */
  bodyLineOffset: number;
  headings: Heading[];
  links: Link[];
  /** Lowercased, de-duplicated tags from frontmatter and inline `#tags`, without `#`. */
  tags: string[];
  tasks: Task[];
  wordCount: number;
}
