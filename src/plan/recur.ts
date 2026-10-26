/**
 * Next occurrence for Obsidian Tasks style recurrence rules ("🔁 every week").
 * Supported: every day/week/month/year, every N days/weeks/months/years,
 * every weekday, every <weekday>[, <weekday>…], with optional "when done".
 */
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parse(date: string): Date {
  return new Date(`${date}T12:00:00`);
}
function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * @param rule   e.g. "every 2 weeks", "every weekday", "every monday, thursday"
 * @param base   the date to advance from (due date, or today for "when done")
 * @returns the next date, or null if the rule isn't understood
 */
export function nextOccurrence(rule: string, base: string): string | null {
  const r = rule.toLowerCase().replace(/\s+when done\s*$/, "").trim();
  const d = parse(base);

  if (r === "every weekday") {
    do d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6);
    return fmt(d);
  }

  const days = r.match(/^every ((?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s*(?:,|and)\s*(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))*)$/);
  if (days) {
    const wanted = new Set(days[1]!.split(/\s*(?:,|and)\s*/).map((x) => DAYS.indexOf(x)));
    for (let i = 0; i < 7; i++) {
      d.setDate(d.getDate() + 1);
      if (wanted.has(d.getDay())) return fmt(d);
    }
    return null;
  }

  const m = r.match(/^every (?:(\d+) )?(day|week|month|year)s?$/);
  if (!m) return null;
  const n = Number(m[1] ?? 1);
  switch (m[2]) {
    case "day":
      d.setDate(d.getDate() + n);
      break;
    case "week":
      d.setDate(d.getDate() + 7 * n);
      break;
    case "month": {
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + n);
      // Clamp the 31st to the month's last day.
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
      break;
    }
    case "year":
      d.setFullYear(d.getFullYear() + n);
      break;
  }
  return fmt(d);
}

export function isWhenDone(rule: string): boolean {
  return /\bwhen done\s*$/i.test(rule);
}
