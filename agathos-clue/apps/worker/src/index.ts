import { handleLobby } from './Lobby';
import { handleOAuth } from './auth/oauth2';

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
    if (url.pathname.startsWith('/auth/')) return handleOAuth(req, env);
    if (url.pathname.startsWith('/api/')) return handleLobby(req, env);
    if (url.pathname === '/ws') {
      const gameId = url.searchParams.get('gameId');
      if (gameId === null || gameId === '') {
        return new Response('gameId is required', { status: 400 });
      }
      const id = env.GAME_ROOM.idFromName(gameId);
      return env.GAME_ROOM.get(id).fetch(req);
    }
    // Fall back to static assets for everything else
    return env.ASSETS.fetch(req);
  },
};

export { GameRoom } from './GameRoom';
export { handleLobby } from './Lobby';
