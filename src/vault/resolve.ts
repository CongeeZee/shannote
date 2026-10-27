/**
 * Resolves wikilink targets to vault paths using Obsidian's rules:
 * 1. Exact vault-relative path (with or without `.md`).
 * 2. Path suffix match (`folder/Note` matches `a/folder/Note.md`).
 * 3. File name match, case-insensitive. If several notes share a name, the one
 *    nearest the linking note wins (most shared folders), then the shortest path,
 *    then alphabetical.
 */
export class LinkResolver {
  private byPath = new Map<string, string>();
  private byName = new Map<string, string[]>();

  constructor(paths: Iterable<string>) {
    for (const p of paths) this.add(p);
  }

  add(path: string): void {
    const key = normalise(path);
    this.byPath.set(key, path);
    const name = key.split("/").pop()!;
    const list = this.byName.get(name) ?? [];
    list.push(path);
    list.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    this.byName.set(name, list);
  }

  /** Returns the resolved path, or null if the target doesn't exist. */
  resolve(target: string, fromPath?: string): string | null {
    if (!target) return fromPath ?? null; // `[[#Heading]]` links to the same note
    const key = normalise(target.replace(/^\.?\//, ""));
    const exact = this.byPath.get(key);
    if (exact) return exact;

    // Relative to the linking note's folder.
    if (fromPath && fromPath.includes("/")) {
      const dir = normalise(fromPath).split("/").slice(0, -1).join("/");
      const rel = this.byPath.get(`${dir}/${key}`);
      if (rel) return rel;
    }

    const name = key.split("/").pop()!;
    const candidates = this.byName.get(name);
    if (!candidates) return null;
    if (key.includes("/")) {
      const suffix = candidates.find((c) => normalise(c).endsWith(`/${key}`));
      return suffix ?? null;
    }
    if (candidates.length > 1 && fromPath) {
      // Same name in several folders: prefer the one closest to the linking note
      // (most shared leading folders), like Obsidian does, then shortest path.
      const from = normalise(fromPath).split("/").slice(0, -1);
      const shared = (c: string) => {
        const parts = normalise(c).split("/").slice(0, -1);
        let n = 0;
        while (n < parts.length && n < from.length && parts[n] === from[n]) n++;
        return n;
      };
      return [...candidates].sort((a, b) => shared(b) - shared(a))[0]!;
    }
    return candidates[0]!;
  }

  /** Names shared by more than one note (ambiguous link targets). */
  duplicates(): Array<{ name: string; paths: string[] }> {
    return [...this.byName.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([name, paths]) => ({ name, paths }));
  }
}

function normalise(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .normalize("NFC")
    .toLowerCase();
}
