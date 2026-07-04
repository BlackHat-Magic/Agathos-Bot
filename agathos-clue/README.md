# agathos-clue

Networked Clue/Cluedo Discord Activity.

## Structure

- `apps/web` — Vite + Svelte frontend
- `apps/worker` — Cloudflare Worker (Durable Objects + D1)
- `packages/game` — Ported Clue rules engine

## Scripts

- `bun run dev:web` — Run the web app in dev mode
- `bun run dev:worker` — Run the worker in dev mode
- `bun run build` — Build web and worker
- `bun run test` — Run tests across the workspace
- `bun run typecheck` — Typecheck across the workspace

## Requirements

- [Bun](https://bun.sh/) 1.x