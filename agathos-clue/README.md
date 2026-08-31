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
- `bun --cwd apps/worker run verify:migration` — Verify fresh and legacy D1 migrations
- `bun --cwd apps/worker run migrate:local` / `migrate:remote` — Apply D1 migrations explicitly before deployment

## Standalone authentication

The Worker owns Discord OAuth at `/auth/begin` and `/auth/callback`, then
stores a bounded refresh credential in the Secure, HttpOnly `clue-session`
cookie. The SPA calls `/auth/session` with same-origin credentials; an
authenticated response is `{ authenticated: true, userId, token }`, where the
short-lived token is used immediately as the `bearer.<token>` WebSocket
subprotocol. The helper does not render or persist that token.

When the SPA runs as a Discord Activity, it detects the embedded iframe, lazily
loads `@discord/embedded-app-sdk`, authorizes the `identify` scope, and posts the
short-lived authorization code to `/auth/embedded-exchange`. The Worker exchanges that
code server-side, returns the app session and a transient Discord access token,
and the browser passes that access token directly to the SDK's `authenticate`
command. The access token is not stored in the app session or persistent browser
storage.

The embedded build needs the public client ID exposed as a Vite variable:

```sh
VITE_DISCORD_CLIENT_ID=<Discord application client ID> bun run build
```

Keep `DISCORD_CLIENT_SECRET` and `JWT_SECRET` as Worker secrets. The client ID is
public; the secret values must never be placed in `VITE_` variables.

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

Apply the local D1 migrations before starting the Worker:

```sh
bun --cwd apps/worker run migrate:local
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
