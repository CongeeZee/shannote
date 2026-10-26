/** Instructions for the Shannote upkeep rituals (Phase 5). */
export const CURATE_INSTRUCTIONS = {
  triage: `Inbox triage for Eric. The context lists every inbox entry with likely destinations found by search.

1. For each entry decide one action:
   - **move** to an existing note (pick from its suggestions, or search) — optionally under a heading
   - **task**: it's a to-do → today's daily note Plan by default, or a project note; add a due date only if the entry implies one
   - **new note**: it's a substantial idea with no home → brain_create (folder that fits), then resolve as archive
   - **discard**: noise, duplicates, or done already
2. Show Eric the plan as a compact table (entry → action → destination) and **wait for his approval**. He may edit it.
3. Apply each approved row with brain_inbox action "resolve" (and brain_create first for new notes). Don't rewrite his words beyond fixing obvious typos.
4. Finish with the remaining count (goal: zero) and anything you weren't sure about.`,

  links: `Link suggestions for Eric's recently changed notes.

1. The context lists, per note, plain-text mentions of other notes' titles and similar notes that aren't linked.
2. Pick the suggestions that would genuinely help him navigate later. Skip weak or coincidental matches (common words, generic titles).
3. Show the shortlist grouped by note and ask which to apply (default: all shortlisted).
4. Apply with brain_links action "add": pass line + text for mentions (turns the mention into a link), or just the target for similar notes (adds it to related:/Related).
5. Report what was linked.`,
};

export function renderCurate(kind: keyof typeof CURATE_INSTRUCTIONS, context: unknown): string {
  return `${CURATE_INSTRUCTIONS[kind]}\n\n<context>\n${JSON.stringify(context, null, 2)}\n</context>`;
}
