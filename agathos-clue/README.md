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

### OAuth configuration

The values below are placeholders only. Do not use them, or any credentials
from local development, in production.

For local development, edit `apps/worker/wrangler.jsonc` with a valid
non-production Discord application client ID and register this exact callback
URL in that Discord application's OAuth2 redirect settings:

```jsonc
"vars": {
  "DISCORD_CLIENT_ID": "<non-production Discord client ID>",
  "DISCORD_REDIRECT_URI": "http://localhost:8787/auth/callback"
}
```

The local Worker also needs its secrets configured from
`agathos-clue/apps/worker`:

```sh
wrangler secret put DISCORD_CLIENT_SECRET
wrangler secret put JWT_SECRET
```

Use separate production Discord credentials and secrets. Set valid production
`DISCORD_CLIENT_ID` and `DISCORD_REDIRECT_URI` variables, and register the
same callback URL with Discord. The production callback must use HTTPS, for
example `https://<production-worker-domain>/auth/callback`; the application
must also be served over HTTPS so the Secure `clue-session` cookie is sent.
Never commit either secret or replace the examples above with real values.

## Requirements

- [Bun](https://bun.sh/) 1.x
