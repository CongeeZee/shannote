import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Time-sortable unique id (ULID format). */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let r = "";
  for (let i = 0; i < 16; i++) r += CROCKFORD[rand[i]! % 32];
  return time + r;
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

/** Local ISO timestamp with offset, e.g. 2026-10-26T14:30:00+11:00. */
export function localIso(d = new Date()): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

export function localDate(d = new Date()): string {
  return localIso(d).slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

/** Filesystem-safe slug for file names. */
export function slugify(s: string, max = 60): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "untitled"
  );
}

export class BrainError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "exists"
      | "invalid_path"
      | "conflict"
      | "no_match"
      | "ambiguous"
      | "invalid" = "invalid",
  ) {
    super(message);
  }
}
