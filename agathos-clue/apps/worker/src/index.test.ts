import { describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index';

function env(): Env {
  return {
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    GAME_ROOM: {} as DurableObjectNamespace,
    LOBBY_DB: {} as D1Database,
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_REDIRECT_URI: 'https://example.test/auth/callback',
    DISCORD_CLIENT_SECRET: 'test-discord-secret',
    JWT_SECRET: 'test-jwt-secret',
  };
}

describe('worker auth routes', () => {
  it('dispatches the canonical embedded exchange endpoint before generic auth routing', async () => {
    const response = await worker.fetch(
      new Request('https://example.test/auth/embedded-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
      }),
      env(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('authentication failed');
  });

  it('does not retain the incorrect embedded route', async () => {
    const response = await worker.fetch(
      new Request('https://example.test/auth/embedded', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'embedded-code' }),
      }),
      env(),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not found');
  });
});
