/**
 * Default note templates, written to `_brain/templates/` by `brain init`.
 * Placeholders: {{id}}, {{title}}, {{date}}, {{datetime}}, {{device}}.
 * Users can edit the copies in their vault; the app reads those, not these.
 */
export const TEMPLATES: Record<string, string> = {
  "daily.md": `---
id: {{id}}
title: {{date}}
type: daily
tags: [daily]
created: {{datetime}}
---

# {{date}}

## Plan

## Schedule

## Tasks

## Notes

## Review
`,
  "meeting.md": `---
id: {{id}}
title: {{title}}
type: meeting
tags: [meeting]
created: {{datetime}}
event_id:
event_start:
attendees: []
---

# {{title}}

## Agenda

## Notes

## Decisions

## Actions
`,
  "person.md": `---
id: {{id}}
title: {{title}}
type: person
tags: [person]
created: {{datetime}}
aliases: []
---

# {{title}}

## Context

## Interactions
`,
  "project.md": `---
id: {{id}}
title: {{title}}
type: project
tags: [project]
status: active
created: {{datetime}}
---

# {{title}}

## Goal

## Status

## Next steps

## Log
`,
};

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key: string) => vars[key] ?? m);
}
