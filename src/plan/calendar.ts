/**
 * Read-only calendar from private iCal (.ics) URLs, e.g. Google Calendar's
 * "Secret address in iCal format". No OAuth: the URL is the credential, so it
 * lives in machine config (~/.config/shannote/config.json), never the vault.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot, loadConfig } from "../config.js";
import { localIso, sha1 } from "../util.js";

export interface CalendarEvent {
  uid: string;
  title: string;
  /** Local ISO datetime, or YYYY-MM-DD for all-day events. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  calendar?: string;
}

interface Wall {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

interface TimeValue {
  wall: Wall;
  /** "UTC", an IANA zone, or undefined for floating/local time. */
  zone?: string;
  allDay: boolean;
}

interface RawEvent {
  uid: string;
  summary: string;
  location?: string;
  status?: string;
  start: TimeValue;
  end?: TimeValue;
  durationMs?: number;
  rrule?: Record<string, string>;
  exdates: TimeValue[];
  recurrenceId?: TimeValue;
}

// ---------------------------------------------------------------- time helpers

function tzOffsetMs(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - utcMs;
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Converts a wall-clock time in a zone to an epoch instant. */
function toInstant(t: TimeValue): number {
  const w = t.wall;
  if (t.allDay) return new Date(w.y, w.mo - 1, w.d).getTime();
  if (t.zone === "UTC") return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  if (t.zone && validZone(t.zone)) {
    const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    let inst = guess - tzOffsetMs(t.zone, guess);
    inst = guess - tzOffsetMs(t.zone, inst); // second pass handles DST edges
    return inst;
  }
  return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime(); // floating
}

function parseTime(value: string, params: Record<string, string>): TimeValue | null {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const wall: Wall = { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  const allDay = !m[4] || params.VALUE === "DATE";
  const zone = m[7] ? "UTC" : params.TZID?.replace(/^"|"$/g, "");
  return { wall, zone, allDay };
}

function parseDuration(v: string): number | undefined {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return undefined;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
}

// ---------------------------------------------------------------- parsing

export function parseIcs(text: string): RawEvent[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events: RawEvent[] = [];
  let cur: Partial<RawEvent> & { exdates: TimeValue[] } | null = null;
  let depth = 0; // skip nested components like VALARM
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = { exdates: [] };
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (line.startsWith("END:") && depth > 0) {
      depth--;
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur.start && cur.uid !== undefined) events.push({ summary: "", ...cur } as RawEvent);
      cur = null;
      continue;
    }
    if (depth > 0) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const [name, ...paramParts] = line.slice(0, colon).split(";");
    const value = line.slice(colon + 1);
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    switch (name!.toUpperCase()) {
      case "UID":
        cur.uid = value.trim();
        break;
      case "SUMMARY":
        cur.summary = unescapeText(value);
        break;
      case "LOCATION":
        cur.location = unescapeText(value) || undefined;
        break;
      case "STATUS":
        cur.status = value.trim().toUpperCase();
        break;
      case "DTSTART":
        cur.start = parseTime(value, params) ?? undefined;
        break;
      case "DTEND":
        cur.end = parseTime(value, params) ?? undefined;
        break;
      case "DURATION":
        cur.durationMs = parseDuration(value.trim());
        break;
      case "RRULE":
        cur.rrule = Object.fromEntries(value.split(";").map((kv) => kv.split("=") as [string, string]).map(([k, v]) => [k.toUpperCase(), v]));
        break;
      case "EXDATE":
        for (const v of value.split(",")) {
          const t = parseTime(v, params);
          if (t) cur.exdates.push(t);
        }
        break;
      case "RECURRENCE-ID":
        cur.recurrenceId = parseTime(value, params) ?? undefined;
        break;
    }
  }
  return events;
}

// ---------------------------------------------------------------- recurrence

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function dayNumber(y: number, mo: number, d: number): number {
  return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
}

function fromDayNumber(n: number): { y: number; mo: number; d: number; dow: number } {
  const dt = new Date(n * 86400000);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
}

/** Yields occurrence start dates (as wall-clock days) for an RRULE, in order. */
function* occurrenceDays(start: Wall, rule: Record<string, string>, lastDay: number): Generator<{ y: number; mo: number; d: number }> {
  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1));
  const startDay = dayNumber(start.y, start.mo, start.d);
  const startDow = fromDayNumber(startDay).dow;
  const byday = rule.BYDAY?.split(",").map((s) => {
    const m = s.match(/^([+-]?\d+)?([A-Z]{2})$/)!;
    return { n: m?.[1] ? Number(m[1]) : 0, dow: DAY_CODES.indexOf(m?.[2] ?? "") };
  });
  const bymonthday = rule.BYMONTHDAY?.split(",").map(Number);
  // Weeks start on Monday (RFC 5545 default WKST=MO).
  const weekStart = (n: number) => n - ((fromDayNumber(n).dow + 6) % 7);

  for (let n = startDay, guard = 0; n <= lastDay && guard < 40000; n++, guard++) {
    const day = fromDayNumber(n);
    let match = false;
    switch (freq) {
      case "DAILY":
        match = (n - startDay) % interval === 0 && (!byday || byday.some((b) => b.dow === day.dow));
        break;
      case "WEEKLY": {
        const weeks = Math.round((weekStart(n) - weekStart(startDay)) / 7);
        const days = byday ? byday.map((b) => b.dow) : [startDow];
        match = weeks % interval === 0 && days.includes(day.dow);
        break;
      }
      case "MONTHLY": {
        const months = (day.y - start.y) * 12 + (day.mo - start.mo);
        if (months % interval !== 0) break;
        if (byday && byday.length) {
          const dim = new Date(Date.UTC(day.y, day.mo, 0)).getUTCDate();
          match = byday.some((b) => {
            if (b.dow !== day.dow) return false;
            if (!b.n) return true;
            const nth = b.n > 0 ? Math.ceil(day.d / 7) : -Math.ceil((dim - day.d + 1) / 7);
            return nth === b.n;
          });
        } else match = (bymonthday ?? [start.d]).includes(day.d);
        break;
      }
      case "YEARLY":
        match = (day.y - start.y) % interval === 0 && day.mo === start.mo && day.d === start.d;
        break;
    }
    if (match) yield day;
  }
}

// ---------------------------------------------------------------- expansion

function toLocal(inst: number, allDay: boolean): string {
  return allDay ? localIso(new Date(inst)).slice(0, 10) : localIso(new Date(inst));
}

/** Expands events (including recurring ones) that overlap [fromMs, toMs). */
export function expandEvents(raw: RawEvent[], fromMs: number, toMs: number, calendar?: string): CalendarEvent[] {
  const overrides = new Map<string, RawEvent>();
  for (const e of raw) if (e.recurrenceId) overrides.set(`${e.uid}|${toInstant(e.recurrenceId)}`, e);
  const out: CalendarEvent[] = [];

  const emit = (e: RawEvent, startInst: number) => {
    if (e.status === "CANCELLED") return;
    const dur =
      e.end != null
        ? toInstant(e.end) - toInstant(e.start)
        : e.durationMs ?? (e.start.allDay ? 86400000 : 0);
    const endInst = startInst + dur;
    if (endInst <= fromMs && !(dur === 0 && startInst >= fromMs)) return;
    if (startInst >= toMs) return;
    out.push({
      uid: e.uid,
      title: e.summary || "(no title)",
      start: toLocal(startInst, e.start.allDay),
      end: toLocal(e.start.allDay ? endInst - 1 : endInst, e.start.allDay),
      allDay: e.start.allDay,
      location: e.location,
      calendar,
    });
  };

  for (const e of raw) {
    if (e.recurrenceId) continue; // emitted in place of the occurrence it replaces
    if (!e.rrule) {
      emit(e, toInstant(e.start));
      continue;
    }
    const until = e.rrule.UNTIL ? parseTime(e.rrule.UNTIL, {}) : null;
    const untilInst = until ? (until.allDay ? toInstant(until) + 86400000 - 1 : toInstant(until)) : Infinity;
    const count = e.rrule.COUNT ? Number(e.rrule.COUNT) : Infinity;
    const lastDay = Math.floor(Math.min(toMs, untilInst === Infinity ? toMs : untilInst) / 86400000) + 1;
    const ex = new Set(e.exdates.map((x) => toInstant({ ...x, zone: x.zone ?? e.start.zone })));
    let n = 0;
    for (const day of occurrenceDays(e.start.wall, e.rrule, lastDay)) {
      const inst = toInstant({ ...e.start, wall: { ...e.start.wall, y: day.y, mo: day.mo, d: day.d } });
      if (inst > untilInst) break;
      if (++n > count) break;
      if (ex.has(inst)) continue;
      const override = overrides.get(`${e.uid}|${inst}`);
      if (override) emit(override, toInstant(override.start));
      else emit(e, inst);
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------- sources

export interface CalendarSource {
  url: string;
  name?: string;
}

export function calendarSources(): CalendarSource[] {
  const env = process.env.BRAIN_ICS;
  if (env) return env.split(/\s*,\s*/).filter(Boolean).map((url) => ({ url }));
  const cfg = loadConfig() as { calendars?: Array<CalendarSource | string> };
  return (cfg.calendars ?? []).map((c) => (typeof c === "string" ? { url: c } : c));
}

const CACHE_TTL_MS = 15 * 60_000;

/** Fetches an .ics URL (or reads a local file), with a 15-minute cache and stale fallback. */
export async function loadIcs(src: CalendarSource, opts: { force?: boolean } = {}): Promise<{ text: string; stale: boolean; error?: string }> {
  const url = src.url.replace(/^webcal:\/\//i, "https://");
  if (!/^https?:\/\//i.test(url)) {
    const path = url.replace(/^file:\/\//, "");
    return { text: readFileSync(path, "utf8"), stale: false };
  }
  const dir = join(cacheRoot(), "calendar");
  const file = join(dir, `${sha1(url).slice(0, 16)}.ics`);
  if (!opts.force && existsSync(file) && Date.now() - statSync(file).mtimeMs < CACHE_TTL_MS)
    return { text: readFileSync(file, "utf8"), stale: false };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("not an iCal file");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
    return { text, stale: false };
  } catch (e) {
    if (existsSync(file)) return { text: readFileSync(file, "utf8"), stale: true, error: (e as Error).message };
    throw new Error(`Couldn't load calendar ${src.name ?? ""}: ${(e as Error).message}`.replace("  ", " "));
  }
}

/** Events from all configured calendars between two local dates (inclusive). */
export async function eventsBetween(
  fromDate: string,
  toDate: string,
  sources = calendarSources(),
): Promise<{ events: CalendarEvent[]; configured: boolean; errors: string[] }> {
  if (!sources.length) return { events: [], configured: false, errors: [] };
  const from = new Date(`${fromDate}T00:00:00`).getTime();
  const to = new Date(`${toDate}T00:00:00`).getTime() + 86400000;
  const events: CalendarEvent[] = [];
  const errors: string[] = [];
  for (const src of sources) {
    try {
      const r = await loadIcs(src);
      if (r.error) errors.push(`${src.name ?? "calendar"}: using cached copy (${r.error})`);
      events.push(...expandEvents(parseIcs(r.text), from, to, src.name));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return { events, configured: true, errors };
}
