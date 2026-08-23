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

## Standalone authentication

The Worker owns Discord OAuth at `/auth/begin` and `/auth/callback`, then
stores the session JWT in the Secure, HttpOnly `clue-session` cookie. The SPA
calls `/auth/session` with same-origin credentials; an authenticated response
is `{ authenticated: true, userId, token }`. The helper does not render or
persist that token. Task 20 can offer the returned token as the
`bearer.<token>` WebSocket subprotocol.

## Requirements

- [Bun](https://bun.sh/) 1.x
