/**
 * Reads the "## Schedule" section of a daily note, written by Claude's morning
 * brief or by hand, e.g.
 *   - 09:00–10:00 Thesis meeting with [[Jane Doe]]
 *   - 13:30 Gym
 *   - All day: Public holiday
 */
export interface ScheduleItem {
  start?: string; // HH:MM
  end?: string;
  allDay: boolean;
  text: string;
}

const LINE_RE = /^\s*[-*]\s+(?:\[.\]\s+)?(?:(\d{1,2}[:.]\d{2})(?:\s*(?:–|-|—|to)\s*(\d{1,2}[:.]\d{2}))?|(all[- ]day):?)\s*[:–—-]?\s*(.+)$/i;

function hhmm(t: string): string {
  const [h, m] = t.replace(".", ":").split(":");
  return `${h!.padStart(2, "0")}:${m}`;
}

export function parseSchedule(sectionText: string): ScheduleItem[] {
  const items: ScheduleItem[] = [];
  for (const line of sectionText.split("\n")) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    items.push({
      start: m[1] ? hhmm(m[1]) : undefined,
      end: m[2] ? hhmm(m[2]) : undefined,
      allDay: !!m[3],
      text: m[4]!.trim(),
    });
  }
  return items.sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : (a.start ?? "").localeCompare(b.start ?? "")));
}

/** Extracts a section's text (without the heading) from markdown. */
export function sectionOf(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "i").test(l.trim()));
  if (start === -1) return null;
  const level = lines[start]!.match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i]!.match(/^(#{1,6})\s/);
    if (h && h[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}
