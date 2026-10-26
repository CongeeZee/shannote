// Calendar maths depends on the local zone; pin it so results are the same everywhere.
process.env.TZ = "Australia/Sydney";

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandEvents, eventsBetween, parseIcs } from "../src/plan/calendar.js";
import { isoWeek, renderPrompt, weekRange } from "../src/plan/planning.js";
import { nextOccurrence } from "../src/plan/recur.js";
import { parseSchedule, sectionOf } from "../src/plan/schedule.js";
import { addDays, localDate } from "../src/util.js";
import { twoDevices, type TwoDevices } from "./helpers.js";

const ICS = join(__dirname, "fixtures/calendar/uni.ics");
const day = (d: string) => new Date(`${d}T00:00:00`).getTime();

describe("recurrence", () => {
  it.each([
    ["every day", "2026-10-26", "2026-10-27"],
    ["every 2 weeks", "2026-10-26", "2026-11-09"],
    ["every month", "2026-01-31", "2026-02-28"],
    ["every year", "2026-10-26", "2027-10-26"],
    ["every weekday", "2026-10-30", "2026-11-02"],
    ["every monday, thursday", "2026-10-26", "2026-10-29"],
    ["every week when done", "2026-10-26", "2026-11-02"],
  ])("%s from %s → %s", (rule, base, next) => {
    expect(nextOccurrence(rule, base)).toBe(next);
  });
  it("returns null for rules it doesn't understand", () => {
    expect(nextOccurrence("every blue moon", "2026-10-26")).toBeNull();
  });
});

describe("calendar (iCal)", () => {
  const raw = parseIcs(readFileSync(ICS, "utf8"));
  const week = expandEvents(raw, day("2026-10-26"), day("2026-11-02"));
  const on = (d: string) => week.filter((e) => e.start.startsWith(d));

  it("parses timed, UTC and all-day events, skips alarms and cancelled events", () => {
    const mon = on("2026-10-26");
    expect(mon.map((e) => [e.start.slice(11, 16), e.title])).toEqual([
      ["09:00", "Robot dog standup"],
      ["10:00", "Thesis sync with Jane"],
      ["16:00", "Call, with comma"], // 05:00Z = 16:00 AEDT
    ]);
    expect(mon[1]!.location).toBe("K17 Level 3");
    expect(mon[1]!.end.slice(11, 16)).toBe("11:00");
    const hol = week.find((e) => e.title === "Public holiday")!;
    expect(hol).toMatchObject({ allDay: true, start: "2026-10-27", end: "2026-10-27" });
  });

  it("expands weekly rules with BYDAY, EXDATE, overrides and UNTIL", () => {
    const lectures = week.filter((e) => e.title.startsWith("COMP3231"));
    // Tue 27 moved to 15:00; Thu 29 cancelled via EXDATE.
    expect(lectures.map((e) => [e.start.slice(0, 16), e.title])).toEqual([["2026-10-27T15:00", "COMP3231 Lecture (moved)"]]);
    const later = expandEvents(raw, day("2026-11-16"), day("2026-11-30")).filter((e) => e.title === "COMP3231 Lecture");
    expect(later.map((e) => e.start.slice(0, 10))).toEqual(["2026-11-17", "2026-11-19"]); // UNTIL 20 Nov
  });

  it("handles COUNT, DURATION and monthly nth-weekday rules", () => {
    expect(week.filter((e) => e.title === "Robot dog standup").map((e) => e.start.slice(0, 10))).toEqual([
      "2026-10-26", "2026-10-27", "2026-10-28",
    ]);
    expect(week.find((e) => e.title === "Robot dog standup")!.end.slice(11, 16)).toBe("09:15");
    const nov = expandEvents(raw, day("2026-11-01"), day("2026-12-01")).filter((e) => e.title === "Society meeting");
    expect(nov.map((e) => e.start.slice(0, 16))).toEqual(["2026-11-03T18:00"]); // first Tuesday
  });

  it("keeps wall-clock time across a daylight-saving change", () => {
    const dst = expandEvents(raw, day("2026-09-28"), day("2026-10-20")).filter((e) => e.title === "Weekly across DST");
    // Sydney DST starts 4 Oct 2026; the event stays at 08:00 local.
    expect(dst.map((e) => e.start)).toEqual([
      "2026-09-29T08:00:00+10:00", "2026-10-06T08:00:00+11:00", "2026-10-13T08:00:00+11:00",
    ]);
  });

  it("loads from configured sources and reports errors per source", async () => {
    const r = await eventsBetween("2026-10-26", "2026-10-26", [{ url: ICS, name: "Uni" }, { url: "/nope.ics", name: "Missing" }]);
    expect(r.configured).toBe(true);
    expect(r.events).toHaveLength(3);
    expect(r.events[0]!.calendar).toBe("Uni");
    expect(r.errors).toHaveLength(1);
    expect((await eventsBetween("2026-10-26", "2026-10-26", [])).configured).toBe(false);
  });
});

describe("schedule section", () => {
  it("parses time ranges, single times and all-day lines", () => {
    const md = "## Plan\nx\n## Schedule\n- 13:30 Gym\n- 9.00 – 10:00 Thesis sync with [[Jane Doe]]\n- All day: Holiday\n- not a time\n## Notes";
    expect(sectionOf(md, "Schedule")).toContain("Gym");
    expect(parseSchedule(sectionOf(md, "Schedule")!)).toEqual([
      { allDay: true, start: undefined, end: undefined, text: "Holiday" },
      { allDay: false, start: "09:00", end: "10:00", text: "Thesis sync with [[Jane Doe]]" },
      { allDay: false, start: "13:30", end: undefined, text: "Gym" },
    ]);
  });
});

describe("weeks", () => {
  it("computes ISO weeks and Monday–Sunday ranges", () => {
    expect(isoWeek("2026-10-26")).toBe("2026-W44");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(weekRange("2026-10-29")).toEqual({ start: "2026-10-26", end: "2026-11-01" });
  });
});

describe("planning with the Brain", () => {
  let t: TwoDevices;
  const today = localDate();
  beforeEach(() => {
    t = twoDevices();
    process.env.BRAIN_ICS = ICS;
  });
  afterEach(() => {
    delete process.env.BRAIN_ICS;
    t.cleanup();
  });

  it("completing a recurring task creates the next occurrence above it", async () => {
    const task = (await t.a.tasks()).find((x) => x.text === "Write ROS2 launch files")!;
    const r = await t.a.taskUpdate({ id: task.id, done: true });
    expect(r.next_occurrence).toBe("- [/] Write ROS2 launch files 🔁 every week 📅 2026-11-03");
    const lines = readFileSync(join(t.pathA, "projects/Robot Dog.md"), "utf8").split("\n");
    const i = lines.findIndex((l) => l.includes("📅 2026-11-03"));
    expect(lines[i + 1]).toMatch(/^- \[x\] Write ROS2 launch files .*📅 2026-10-27 ✅ /);
  });

  it("rolls unfinished daily-note tasks over to tomorrow", async () => {
    const d = "2026-10-26";
    const r = await t.a.rolloverTasks({ from: d });
    expect(r.moved).toEqual(["- [ ] Email [[Jane Doe]] 📅 2026-10-26"]);
    expect(readFileSync(join(t.pathA, `daily/${d}.md`), "utf8")).toContain("- [>] Email [[Jane Doe]]");
    const next = readFileSync(join(t.pathA, "daily/2026-10-27.md"), "utf8");
    expect(next).toContain("## Plan\n- [ ] Email [[Jane Doe]] 📅 2026-10-26 (from [[2026-10-26]])");
    // Forwarded originals no longer count as open.
    expect((await t.a.tasks({ path: `daily/${d}.md` }))).toHaveLength(0);
    expect((await t.a.rolloverTasks({ from: d })).moved).toEqual([]);
  });

  it("builds a morning context with calendar, tasks and handoffs", async () => {
    await t.a.endSession({ summary: "Scoped the robot dog work.", next_steps: ["Email Jane"] });
    const c = (await t.a.planContext("morning", { date: "2026-10-26" })) as Record<string, any>;
    expect(c.weekday).toBe("Monday");
    expect(c.calendar.configured).toBe(true);
    expect(c.calendar.events.map((e: { title: string }) => e.title)).toContain("Thesis sync with Jane");
    expect(c.recent_handoffs[0].next_steps).toEqual(["Email Jane"]);
    const prompt = renderPrompt("morning", c);
    expect(prompt).toContain("Morning brief for Eric");
    expect(prompt).toContain("<context>");
  });

  it("builds evening, weekly and meeting contexts", async () => {
    const ev = (await t.a.planContext("evening", { date: "2026-10-26" })) as Record<string, any>;
    expect(ev.still_open_in_daily_note.map((x: { text: string }) => x.text)).toEqual(["Email [[Jane Doe]]"]);
    expect(ev.tomorrow.events.map((e: { title: string }) => e.title)).toContain("Public holiday");

    const wk = (await t.a.planContext("weekly", { date: "2026-10-28" })) as Record<string, any>;
    expect(wk.week).toBe("2026-W44");
    expect(wk.review_path).toBe("daily/2026-W44-review.md");
    expect(wk.calendar.total_hours).toBeGreaterThan(0);
    expect(renderPrompt("weekly", wk)).toContain('title "Week 2026-W44 review"');

    const mt = (await t.a.planContext("meeting", { date: "2026-10-26", event: "thesis sync" })) as Record<string, any>;
    expect(mt.event.title).toBe("Thesis sync with Jane");
    expect(mt.meeting_path).toBe("meetings/2026-10-26 Thesis sync with Jane.md");
  });

  it("shows calendar and note schedule on the Today data", async () => {
    writeFileSync(join(t.pathA, "daily/2026-10-26.md"), "---\ntitle: 2026-10-26\n---\n# 2026-10-26\n\n## Schedule\n- 13:30 Gym\n");
    const d = await t.a.today("2026-10-26");
    expect(d.schedule.calendar.length).toBe(3);
    expect(d.schedule.fromNote).toEqual([{ allDay: false, start: "13:30", end: undefined, text: "Gym" }]);
    void addDays; void today;
  });
});
