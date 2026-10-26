#!/usr/bin/env node
// Entry point for the `brain` CLI. Commands are implemented per docs/SPEC.md §9.

const COMMANDS = ["init", "serve", "index", "sync", "doctor", "status"] as const;

const cmd = process.argv[2];

if (!cmd || !COMMANDS.includes(cmd as (typeof COMMANDS)[number])) {
  console.log(`usage: brain <${COMMANDS.join("|")}>`);
  process.exit(cmd ? 1 : 0);
}

console.error(`brain ${cmd}: not implemented yet (see docs/SPEC.md §9)`);
process.exit(1);
