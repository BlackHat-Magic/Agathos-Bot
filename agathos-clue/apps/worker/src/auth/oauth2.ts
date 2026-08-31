import { isValidUserId, mintJwt, verifyJwt } from './jwt';
import type { Env } from '../index';
import {
  boundedParam,
  exchangeCode,
  fetchDiscordUser,
  isBoundedString,
  isDiscordUserId,
  MAX_CLIENT_ID_LENGTH,
  MAX_CODE_LENGTH,
  MAX_DISCORD_TOKEN_LENGTH,
  MAX_REDIRECT_URI_LENGTH,
} from './discord';

const DISCORD_AUTHORIZE_ENDPOINT = 'https://discord.com/oauth2/authorize';
const STATE_COOKIE = 'clue-oauth-state';
const SESSION_COOKIE = 'clue-session';
const STATE_COOKIE_PATH = '/';
const LEGACY_STATE_COOKIE_PATH = '/auth';
const STATE_TTL_SECONDS = 300;
const ACCESS_TOKEN_TTL_SECONDS = 3_600;
// The HttpOnly cookie is a bounded refresh credential. The JSON token remains
// short-lived and is the only value used for WebSocket authentication.
const SESSION_TTL_SECONDS = 86_400;
const MAX_COOKIE_BYTES = 8_192;
const MAX_STATE_LENGTH = 256;
const MAX_SESSION_COOKIE_VALUE_BYTES = 4_096;

const encoder = new TextEncoder();
export async function handleOAuth(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/auth/begin') return begin(req, env);
  if (url.pathname === '/auth/callback') return callback(req, env);
  if (url.pathname === '/auth/session') return session(req, env);
  return text('not found', 404);
}

function begin(req: Request, env: Env): Response {
  if (req.method !== 'GET') return methodNotAllowed();
  if (!isBoundedString(env.DISCORD_CLIENT_ID, MAX_CLIENT_ID_LENGTH) ||
      !isBoundedString(env.DISCORD_REDIRECT_URI, MAX_REDIRECT_URI_LENGTH)) {
    return text('authentication is unavailable', 503);
  }

  const state = randomState();
  const authorizeUrl = new URL(DISCORD_AUTHORIZE_ENDPOINT);
  authorizeUrl.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', env.DISCORD_REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'identify');
  authorizeUrl.searchParams.set('state', state);
  const response = new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.href,
      'Cache-Control': 'no-store',
    },
  });
  response.headers.append('Set-Cookie', serializeCookie(
    STATE_COOKIE,
    state,
    STATE_TTL_SECONDS,
    STATE_COOKIE_PATH,
  ));
  response.headers.append('Set-Cookie', clearCookie(STATE_COOKIE, LEGACY_STATE_COOKIE_PATH));
  return response;
}

async function callback(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed();
  const url = new URL(req.url);
  const stateCookie = readCookie(req.headers.get('Cookie'), STATE_COOKIE);
  const queryState = boundedParam(url.searchParams.get('state'), MAX_STATE_LENGTH);
  const code = boundedParam(url.searchParams.get('code'), MAX_CODE_LENGTH);
  const clearState = clearCookie(STATE_COOKIE, STATE_COOKIE_PATH);

  if (stateCookie.value === null || queryState === null || !constantTimeEqual(stateCookie.value, queryState)) {
    // Do not clear the current state cookie: another tab may own it and still
    // need to complete its valid callback.
    console.warn('standalone OAuth state validation failed');
    return failure();
  }
  if (code === null) {
    console.warn('standalone OAuth callback did not contain a code');
    return failure(clearState);
  }
  if (!isBoundedString(env.DISCORD_CLIENT_ID, MAX_CLIENT_ID_LENGTH) ||
      !isBoundedString(env.DISCORD_REDIRECT_URI, MAX_REDIRECT_URI_LENGTH) ||
      !isBoundedString(env.DISCORD_CLIENT_SECRET, MAX_DISCORD_TOKEN_LENGTH) ||
      !isBoundedString(env.JWT_SECRET, 4_096)) {
    return failure(clearState, 503);
  }

  try {
    const token = await exchangeCode(code, env);
    const discordUser = await fetchDiscordUser(token.accessToken);
    if (!isDiscordUserId(discordUser.id)) return failure(clearState);

    const jwt = await mintJwt({ userId: discordUser.id }, env.JWT_SECRET, SESSION_TTL_SECONDS);
    const response = new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Cache-Control': 'no-store',
      },
    });
    response.headers.append('Set-Cookie', clearState);
    response.headers.append('Set-Cookie', clearCookie(STATE_COOKIE, LEGACY_STATE_COOKIE_PATH));
    response.headers.append('Set-Cookie', serializeCookie(
      SESSION_COOKIE,
      jwt,
      SESSION_TTL_SECONDS,
      '/',
    ));
    return response;
  } catch (error) {
    console.error(
      'standalone OAuth callback exchange failed',
      error instanceof Error ? error.message : 'unknown error',
    );
    return failure(clearState, 502);
  }
}

async function session(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed();
  const cookie = readCookie(req.headers.get('Cookie'), SESSION_COOKIE, MAX_SESSION_COOKIE_VALUE_BYTES);
  if (cookie.invalid) return unauthenticated(clearCookie(SESSION_COOKIE, '/'));
  const token = cookie.value;
  if (token === null) return unauthenticated();

  const claims = await verifyJwt(token, env.JWT_SECRET);
  if (claims === null || !isValidUserId(claims.userId)) {
    return unauthenticated(clearCookie(SESSION_COOKIE, '/'));
  }
  // Mint a fresh short-lived app token on each session check so reconnects do
  // not keep retrying an expired JWT. Keep the longer-lived HttpOnly cookie as
  // the refresh credential rather than replacing it with the access token.
  const refreshed = await mintJwt({ userId: claims.userId }, env.JWT_SECRET, ACCESS_TOKEN_TTL_SECONDS);
  return json({ authenticated: true, userId: claims.userId, token: refreshed });
}

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function readCookie(
  header: string | null,
  name: string,
  maxValueBytes = MAX_STATE_LENGTH * 16,
): { value: string | null; invalid: boolean } {
  if (header === null) return { value: null, invalid: false };
  if (encoder.encode(header).byteLength > MAX_COOKIE_BYTES) return { value: null, invalid: true };
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      if (part.trim() === name) return { value: null, invalid: true };
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length === 0 || encoder.encode(value).byteLength > maxValueBytes
      ? { value: null, invalid: true }
      : { value, invalid: false };
  }
  return { value: null, invalid: false };
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function serializeCookie(name: string, value: string, maxAge: number, path: string): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${path}; HttpOnly; SameSite=Lax; Secure`;
}

function clearCookie(name: string, path: string): string {
  return `${name}=; Max-Age=0; Path=${path}; HttpOnly; SameSite=Lax; Secure`;
}

function failure(clearState?: string, status = 400): Response {
  const response = text('authentication failed', status);
  if (clearState !== undefined) response.headers.append('Set-Cookie', clearState);
  response.headers.append('Set-Cookie', clearCookie(STATE_COOKIE, LEGACY_STATE_COOKIE_PATH));
  return response;
}

function unauthenticated(clearSession?: string): Response {
  const response = json({ authenticated: false }, 401);
  if (clearSession !== undefined) response.headers.append('Set-Cookie', clearSession);
  return response;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function text(value: string, status: number): Response {
  return new Response(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function methodNotAllowed(): Response {
  return text('method not allowed', 405);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
