import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index';
import { verifyJwt } from './jwt';
import { handleEmbedded } from './embedded';

const JWT_SECRET = 'test-jwt-secret';
const ACCESS_TOKEN = 'discord-access-token-that-must-not-escape';

function env(): Env {
  return {
    ASSETS: {} as Fetcher,
    GAME_ROOM: {} as DurableObjectNamespace,
    LOBBY_DB: {} as D1Database,
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_REDIRECT_URI: 'https://example.test/auth/callback',
    DISCORD_CLIENT_SECRET: 'test-discord-secret',
    JWT_SECRET,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('embedded Discord exchange', () => {
  it('exchanges an authorization code for an identity-only app session and Discord SDK token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 604_800 }))
      .mockResolvedValueOnce(jsonResponse({ id: '123456789012345678' }));
    const response = await handleEmbedded(
      new Request('https://example.test/auth/embedded-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'embedded-code' }),
      }),
      env(),
    );
    const body = await response.json() as Record<string, unknown>;
    const claims = await verifyJwt(String(body.token), JWT_SECRET);
    const tokenRequest = fetchMock.mock.calls[0]![1] as RequestInit;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      authenticated: true,
      userId: '123456789012345678',
      access_token: ACCESS_TOKEN,
    });
    expect(claims).toMatchObject({ userId: '123456789012345678' });
    expect(Object.keys(claims!).sort()).toEqual(['exp', 'iat', 'userId']);
    expect(String(tokenRequest.body)).not.toContain('redirect_uri');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each([
    ['wrong method', new Request('https://example.test/auth/embedded-exchange')],
    ['wrong content type', new Request('https://example.test/auth/embedded-exchange', {
      method: 'POST',
      body: JSON.stringify({ code: 'code' }),
    })],
    ['invalid JSON', new Request('https://example.test/auth/embedded-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })],
    ['missing code', new Request('https://example.test/auth/embedded-exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })],
  ])('rejects embedded requests with %s without calling Discord', async (_name, request) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await handleEmbedded(request, env());

    expect(response.status).toBe(_name === 'wrong method' ? 405 : 400);
    expect(await response.text()).toBe(_name === 'wrong method' ? 'method not allowed' : 'authentication failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hides embedded exchange failures and never returns the upstream error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'private Discord error' }, 400),
    );

    const response = await handleEmbedded(
      new Request('https://example.test/auth/embedded-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'embedded-code' }),
      }),
      env(),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('authentication failed');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });
});
