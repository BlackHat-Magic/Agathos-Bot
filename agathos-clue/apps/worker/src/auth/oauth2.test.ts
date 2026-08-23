import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index';
import { handleOAuth } from './oauth2';
import { verifyJwt } from './jwt';

const JWT_SECRET = 'test-jwt-secret';
const CLIENT_SECRET = 'test-discord-secret';
const ACCESS_TOKEN = 'discord-access-token-that-must-not-escape';

function env(): Env {
  return {
    ASSETS: {} as Fetcher,
    GAME_ROOM: {} as DurableObjectNamespace,
    LOBBY_DB: {} as D1Database,
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_REDIRECT_URI: 'https://example.test/auth/callback',
    DISCORD_CLIENT_SECRET: CLIENT_SECRET,
    JWT_SECRET,
  };
}

function stateCookie(response: Response): string {
  const cookie = setCookies(response).find(value => value.startsWith('clue-oauth-state='));
  if (cookie === undefined) throw new Error('state cookie was not set');
  return cookie.slice('clue-oauth-state='.length).split(';', 1)[0]!;
}

function sessionCookie(response: Response): string {
  const cookie = setCookies(response).find(value => value.startsWith('clue-session='));
  if (cookie === undefined) throw new Error('session cookie was not set');
  return cookie.slice('clue-session='.length).split(';', 1)[0]!;
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = response.headers.get('Set-Cookie');
  return value === null ? [] : value.split(/, (?=[^;,]+=)/);
}

function callbackRequest(state: string, code = 'authorization-code'): Request {
  return new Request(
    `https://example.test/auth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    { headers: { Cookie: `clue-oauth-state=${state}` } },
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('standalone Discord OAuth', () => {
  it('redirects to Discord with the configured flow and a secure state cookie', async () => {
    const response = await handleOAuth(
      new Request('https://example.test/auth/begin'),
      env(),
    );
    const location = new URL(response.headers.get('Location')!);

    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(location.searchParams.get('client_id')).toBe('client-id');
    expect(location.searchParams.get('redirect_uri')).toBe('https://example.test/auth/callback');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('scope')).toBe('identify');
    expect(stateCookie(response)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookies(response)[0]).toMatch(/HttpOnly/);
    expect(setCookies(response)[0]).toMatch(/SameSite=Lax/);
    expect(setCookies(response)[0]).toMatch(/Secure/);
    expect(setCookies(response)[0]).toMatch(/Max-Age=300/);
  });

  it.each([
    ['missing state', 'https://example.test/auth/callback?code=code', 'clue-oauth-state=state'],
    ['mismatched state', 'https://example.test/auth/callback?state=other&code=code', 'clue-oauth-state=state'],
    ['missing code', 'https://example.test/auth/callback?state=state', 'clue-oauth-state=state'],
  ])('rejects %s and clears the state cookie', async (_name, url, cookie) => {
    const response = await handleOAuth(new Request(url, { headers: { Cookie: cookie } }), env());
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('authentication failed');
    expect(setCookies(response).some(value => value.startsWith('clue-oauth-state=; Max-Age=0'))).toBe(true);
  });

  it('does not leak an upstream token error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'secret upstream detail' }, 400),
    );
    const response = await handleOAuth(callbackRequest('state'), env());
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('authentication failed');
    expect(setCookies(response).some(value => value.startsWith('clue-oauth-state=; Max-Age=0'))).toBe(true);
  });

  it('rejects malformed token and user responses without leaking details', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<private token response>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const malformedToken = await handleOAuth(callbackRequest('state'), env());
    expect(malformedToken.status).toBe(502);
    expect(await malformedToken.text()).toBe('authentication failed');

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 604_800 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'not-a-discord-id' }));
    const malformedUser = await handleOAuth(callbackRequest('state'), env());
    expect(malformedUser.status).toBe(502);
    expect(await malformedUser.text()).toBe('authentication failed');
  });

  it.each(['bearer', 'BEARER', 'bEaReR', 'Basic'])('rejects token responses with token type %s', async tokenType => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ access_token: ACCESS_TOKEN, token_type: tokenType, expires_in: 604_800 }),
    );

    const response = await handleOAuth(callbackRequest('state'), env());

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('authentication failed');
    expect(setCookies(response)).toContainEqual(expect.stringContaining('clue-oauth-state=; Max-Age=0'));
  });

  it('rejects unsafe access tokens before calling Discord userinfo', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ access_token: `${ACCESS_TOKEN}\r\nInjected: value`, token_type: 'Bearer', expires_in: 604_800 }),
    );

    const response = await handleOAuth(callbackRequest('state'), env());

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('authentication failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exchanges the code server-side and creates a JWT containing only the bounded user ID', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 604_800 }))
      .mockResolvedValueOnce(jsonResponse({ id: '123456789012345678' }));
    const response = await handleOAuth(callbackRequest('state'), env());
    const cookies = setCookies(response);
    const jwt = decodeURIComponent(sessionCookie(response));
    const claims = await verifyJwt(jwt, JWT_SECRET);
    const tokenRequest = fetchMock.mock.calls[0]![1] as RequestInit;
    const tokenBody = String(tokenRequest.body);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
    expect(claims).not.toBeNull();
    expect(claims).toMatchObject({ userId: '123456789012345678' });
    expect(Object.keys(claims!).sort()).toEqual(['exp', 'iat', 'userId']);
    expect(cookies.join('\n')).not.toContain(ACCESS_TOKEN);
    expect(response.headers.get('Location')).not.toContain(ACCESS_TOKEN);
    expect(tokenBody).toContain(`client_secret=${encodeURIComponent(CLIENT_SECRET)}`);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain(CLIENT_SECRET);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain(ACCESS_TOKEN);
    expect(cookies).toContainEqual(expect.stringContaining('clue-oauth-state=; Max-Age=0'));
    expect(cookies.find(value => value.startsWith('clue-session='))).toMatch(/HttpOnly/);
    expect(cookies.find(value => value.startsWith('clue-session='))).toMatch(/SameSite=Lax/);
    expect(cookies.find(value => value.startsWith('clue-session='))).toMatch(/Secure/);
  });

  it('returns the verified session token only through the session JSON contract', async () => {
    const oauth = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 604_800 }))
      .mockResolvedValueOnce(jsonResponse({ id: '123456789012345678' }));
    const login = await handleOAuth(callbackRequest('state'), env());
    const cookie = sessionCookie(login);
    const response = await handleOAuth(
      new Request('https://example.test/auth/session', { headers: { Cookie: `clue-session=${cookie}` } }),
      env(),
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ authenticated: true, userId: '123456789012345678', token: decodeURIComponent(cookie) });
    expect(oauth).toHaveBeenCalledTimes(2);
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it.each([
    ['invalid', 'clue-session=invalid'],
    ['empty', 'clue-session='],
    ['oversized', `clue-session=${'x'.repeat(8_193)}`],
  ])('rejects and clears an %s session cookie', async (_name, cookie) => {
    const response = await handleOAuth(
      new Request('https://example.test/auth/session', { headers: { Cookie: cookie } }),
      env(),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(setCookies(response)).toContainEqual(expect.stringContaining('clue-session=; Max-Age=0'));
    expect(setCookies(response)).toContainEqual(expect.stringContaining('Secure'));
  });
});
