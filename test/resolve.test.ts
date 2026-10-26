import { describe, expect, it } from "vitest";
import { LinkResolver } from "../src/vault/resolve.js";

const r = new LinkResolver([
  "notes/Hybrid Search.md",
  "archive/old/Hybrid Search.md",
  "projects/Robot Dog.md",
  "Uni/COMP3231/notes/01-intro.md",
  "Uni/COMP3142/notes/01-intro.md",
  "people/Jane Doe.md",
]);

describe("LinkResolver", () => {
  it("resolves by name, case-insensitively, preferring the shallowest path", () => {
    expect(r.resolve("hybrid search")).toBe("notes/Hybrid Search.md");
  });

  it("resolves explicit paths and path suffixes", () => {
    expect(r.resolve("archive/old/Hybrid Search")).toBe("archive/old/Hybrid Search.md");
    expect(r.resolve("old/Hybrid Search.md")).toBe("archive/old/Hybrid Search.md");
    expect(r.resolve("COMP3142/notes/01-intro")).toBe("Uni/COMP3142/notes/01-intro.md");
  });

  it("prefers a note in the linking note's own folder", () => {
    expect(r.resolve("01-intro", "Uni/COMP3142/notes/02-next.md")).toBe(
      "Uni/COMP3142/notes/01-intro.md",
    );
  });

  it("returns null for missing notes and the source for same-note links", () => {
    expect(r.resolve("Missing Note")).toBeNull();
    expect(r.resolve("", "people/Jane Doe.md")).toBe("people/Jane Doe.md");
  });

  it("reports ambiguous names", () => {
    expect(r.duplicates().map((d) => d.name).sort()).toEqual(["01-intro", "hybrid search"]);
  });
});
