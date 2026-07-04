export interface Env {
  ASSETS: Fetcher;
  GAME_ROOM: DurableObjectNamespace;
  LOBBY_DB: D1Database;
  DISCORD_CLIENT_ID: string;
  DISCORD_REDIRECT_URI: string;
  DISCORD_CLIENT_SECRET: string;  // set via `wrangler secret put`
  JWT_SECRET: string;             // set via `wrangler secret put`
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/health') return new Response('ok');
    // Fall back to static assets for everything else
    return env.ASSETS.fetch(req);
  },
};

export { GameRoom } from './GameRoom';