# Project Agent Instructions

These instructions are for coding agents working in this repository.

## Runtime and Package Manager

- Use Bun as the default runtime and package manager.
- Prefer Bun commands over npm/yarn/pnpm.
- Use `bun install --frozen-lockfile` when syncing dependencies in CI-like flows.

## Common Commands

- Install deps: `bun install`
- Run bot (dev): `bun src/index.ts`
- Build web client bundle: `bun build src/web/client/main.ts --target browser --format iife --outfile src/web/app.js`
- Typecheck: `bunx tsc -p tsconfig.json --noEmit`

## Coding and Validation Rules

- Keep changes small and testable.
- Run typecheck after TypeScript edits.
- When touching playback code, include enough logs to diagnose startup, buffering, and idle transitions.
- Do not commit secrets, cookie files, or machine-specific host/access details.

## Local Overrides

- If `AGENTS.local.md` exists, treat it as additional machine-specific instructions.
- `AGENTS.local.md` is intentionally git-ignored.
