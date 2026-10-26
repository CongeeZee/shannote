/**
 * Planning rituals. The app gathers the facts (calendar, tasks, threads,
 * handoffs); Claude does the thinking and writes the result into the vault with
 * the normal tools. Each ritual = instructions + a context bundle.
 */
export type PlanKind = "morning" | "evening" | "weekly" | "meeting";
export const PLAN_KINDS: PlanKind[] = ["morning", "evening", "weekly", "meeting"];

const SCHEDULE_FORMAT =
  "one line per event, exactly like `- 09:00–10:00 Title` (or `- All day: Title`), so the web app can show it as a timeline";

export const INSTRUCTIONS: Record<PlanKind, string> = {
  morning: `Morning brief for Eric. Use the context below; only call tools for what's missing.

1. Calendar: if \`calendar.configured\` is false and you have a calendar tool (e.g. a Google Calendar connector), list today's events with it. Otherwise use \`calendar.events\`.
2. Call brain_daily to open (or create) today's daily note.
3. Replace its "Schedule" section (brain_edit replace_section) with today's events, ${SCHEDULE_FORMAT}. Add a short "prep:" line under a meeting only when a note in the vault is clearly relevant (search for the meeting's title or people), linking it with [[wikilinks]].
4. Replace its "Plan" section with:
   - **Top 3**: the three things that matter most today, chosen from overdue tasks, tasks due today, open threads and yesterday's handoffs. Prefer finishing over starting.
   - **Blocks**: a realistic time-blocked plan around the fixed events, leaving buffer. Reference existing tasks by their text and [[note]]; don't copy them as new checkboxes. Only add a new \`- [ ]\` task for something that isn't tracked anywhere yet.
5. Don't reschedule or complete tasks without asking. If today is overloaded, say what you'd drop and ask.
6. Reply with a 3–5 line summary: the top 3, the first fixed commitment, and anything overdue that needs a decision.`,

  evening: `Evening review for Eric. Use the context below.

1. Compare today's Plan with what happened: tasks completed today, tasks still open in today's daily note, and what changed in the vault today.
2. If Eric is here, ask at most one short question (e.g. "anything to add about today?") before writing. If this is an unattended run, don't ask.
3. Unfinished tasks in today's daily note: if Eric is here, confirm, then call brain_rollover_tasks to carry them to tomorrow. Unattended: roll them over.
4. Replace the daily note's "Review" section with:
   - **Done**: what got finished (brief).
   - **Carried over**: what moved to tomorrow, and why if known.
   - **Notes**: anything worth remembering tomorrow (one or two lines).
5. Call brain_end_session with a one-line summary and tomorrow's first step as a next step.`,

  weekly: `Weekly review for Eric covering the week in the context. Be concrete and short.

1. Read the context: tasks completed this week, overdue tasks, daily-note reviews, calendar time, threads (note stalled ones: not touched in 7+ days), and notes changed.
2. Create the note at \`review_path\` with brain_create (title "Week {{week}} review") containing:
   - **Wins**: 3–5 bullets.
   - **Time**: where the calendar time went (group events into a few buckets, rough hours).
   - **Stalled**: threads/projects that didn't move, with a suggested next action or "drop?".
   - **Overdue**: count, and the 3 that most need a decision.
   - **Next week**: the 3 priorities you'd suggest, given all of the above.
   - **Question for Eric**: one question worth thinking about.
3. If Eric is here, walk through "Next week" with him before finishing.
4. Update any threads whose status clearly changed (brain_thread_update), then brain_end_session.`,

  meeting: `Meeting prep for Eric.

1. Identify the meeting from \`event\` (or ask Eric which one if it's ambiguous).
2. Check \`related_notes\` and \`previous_meetings\`; read the most relevant ones (brain_read) for open questions, decisions and action items involving the attendees or project.
3. Create the meeting note at \`meeting_path\` with brain_create (template "meeting"), or open it if it exists. Fill:
   - frontmatter: event_start, attendees if known
   - **Agenda**: 3–5 items, starting with open action items from last time
   - links to the person/project notes involved
4. Reply with a short brief Eric can read in 30 seconds: purpose, open items, what he needs to bring or decide.`,
};

/** ISO week label, e.g. "2026-W44". */
export function isoWeek(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // Thursday decides the week's year
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Monday and Sunday of the ISO week containing `date`. */
export function weekRange(date: string): { start: string; end: string } {
  const d = new Date(`${date}T12:00:00`);
  const back = (d.getDay() + 6) % 7;
  const mon = new Date(d);
  mon.setDate(d.getDate() - back);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const f = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return { start: f(mon), end: f(sun) };
}

export function renderPrompt(kind: PlanKind, context: unknown): string {
  const ctx = context as { week?: string };
  const text = INSTRUCTIONS[kind].replace("{{week}}", ctx.week ?? "");
  return `${text}\n\n<context>\n${JSON.stringify(context, null, 2)}\n</context>`;
}
