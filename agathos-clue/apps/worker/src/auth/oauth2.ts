import { isValidUserId, mintJwt, verifyJwt } from './jwt';
import type { Env } from '../index';

const DISCORD_AUTHORIZE_ENDPOINT = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_ENDPOINT = 'https://discord.com/api/oauth2/token';
const DISCORD_ME_ENDPOINT = 'https://discord.com/api/users/@me';
const STATE_COOKIE = 'clue-oauth-state';
const SESSION_COOKIE = 'clue-session';
const STATE_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 3_600;
const MAX_COOKIE_BYTES = 8_192;
const MAX_UPSTREAM_BODY_BYTES = 16_384;
const MAX_CLIENT_ID_LENGTH = 128;
const MAX_REDIRECT_URI_LENGTH = 2_048;
const MAX_CODE_LENGTH = 4_096;
const MAX_REQUEST_BODY_BYTES = 16_384;
const MAX_STATE_LENGTH = 256;
const MAX_DISCORD_TOKEN_LENGTH = 1_024;
const MAX_DISCORD_USER_ID_LENGTH = 32;
const MAX_SESSION_COOKIE_VALUE_BYTES = 4_096;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export async function handleOAuth(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/auth/begin') return begin(req, env);
  if (url.pathname === '/auth/callback') return callback(req, env);
  if (url.pathname === '/auth/embedded') return embedded(req, env);
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
    '/auth',
  ));
  return response;
}

async function callback(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed();
  const url = new URL(req.url);
  const stateCookie = readCookie(req.headers.get('Cookie'), STATE_COOKIE);
  const queryState = boundedParam(url.searchParams.get('state'), MAX_STATE_LENGTH);
  const code = boundedParam(url.searchParams.get('code'), MAX_CODE_LENGTH);
  const clearState = clearCookie(STATE_COOKIE, '/auth');

  if (stateCookie.value === null || queryState === null || !constantTimeEqual(stateCookie.value, queryState)) {
    return failure(clearState);
  }
  if (code === null) return failure(clearState);
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
    response.headers.append('Set-Cookie', serializeCookie(
      SESSION_COOKIE,
      jwt,
      SESSION_TTL_SECONDS,
      '/',
    ));
    return response;
  } catch {
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
  return json({ authenticated: true, userId: claims.userId, token });
}

async function embedded(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isJsonContentType(req.headers.get('Content-Type'))) return authenticationFailure(400);
  if (!isBoundedString(env.DISCORD_CLIENT_ID, MAX_CLIENT_ID_LENGTH) ||
      !isBoundedString(env.DISCORD_CLIENT_SECRET, MAX_DISCORD_TOKEN_LENGTH) ||
      !isBoundedString(env.JWT_SECRET, 4_096)) {
    return authenticationFailure(503);
  }

  let value: Record<string, unknown>;
  try {
    value = await readJsonRequest(req);
  } catch {
    return authenticationFailure(400);
  }
  const code = boundedParam(value.code, MAX_CODE_LENGTH);
  if (code === null) return authenticationFailure(400);

  try {
    const token = await exchangeCode(code, env, false);
    const discordUser = await fetchDiscordUser(token.accessToken);
    if (!isDiscordUserId(discordUser.id)) return authenticationFailure(502);

    const jwt = await mintJwt({ userId: discordUser.id }, env.JWT_SECRET, SESSION_TTL_SECONDS);
    return json({
      authenticated: true,
      userId: discordUser.id,
      token: jwt,
      access_token: token.accessToken,
    });
  } catch {
    return authenticationFailure(502);
  }
}

async function exchangeCode(
  code: string,
  env: Env,
  includeRedirectUri = true,
): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
  });
  if (includeRedirectUri) body.set('redirect_uri', env.DISCORD_REDIRECT_URI);
  const response = await fetch(DISCORD_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const value = await readJsonObject(response);
  if (!response.ok || !isBoundedString(value.access_token, MAX_DISCORD_TOKEN_LENGTH) ||
      !isSafeAccessToken(value.access_token) ||
      !isBearerTokenType(value.token_type) ||
      !isSafeExpiresIn(value.expires_in)) {
    throw new Error('invalid Discord token response');
  }
  return { accessToken: value.access_token };
}

async function fetchDiscordUser(accessToken: string): Promise<{ id: string }> {
  const response = await fetch(DISCORD_ME_ENDPOINT, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const value = await readJsonObject(response);
  if (!response.ok || !isDiscordUserId(value.id)) throw new Error('invalid Discord user response');
  return { id: value.id };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  if (!isJsonContentType(response.headers.get('Content-Type'))) throw new Error('invalid upstream content type');
  const contentLength = response.headers.get('Content-Length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_UPSTREAM_BODY_BYTES)) {
    throw new Error('upstream response is too large');
  }

  const bytes = await readBoundedBody(response);
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error('invalid upstream JSON');
  }
  if (!isPlainObject(value)) throw new Error('upstream JSON must be an object');
  return value;
}

async function readJsonRequest(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BODY_BYTES)) {
    throw new Error('request body is too large');
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BODY_BYTES) throw new Error('request body is too large');
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error('request body is not valid JSON');
  }
  if (!isPlainObject(value)) throw new Error('request JSON must be an object');
  return value;
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_UPSTREAM_BODY_BYTES) throw new Error('upstream response is too large');
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_UPSTREAM_BODY_BYTES) {
        await reader.cancel();
        throw new Error('upstream response is too large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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

function boundedParam(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
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

function isDiscordUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_DISCORD_USER_ID_LENGTH &&
    /^\d+$/.test(value) && isValidUserId(value);
}

function isSafeExpiresIn(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 31_536_000;
}

function isSafeAccessToken(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value);
}

function isBearerTokenType(value: unknown): value is string {
  return value === 'Bearer';
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && value.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}

function serializeCookie(name: string, value: string, maxAge: number, path: string): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${path}; HttpOnly; SameSite=Lax; Secure`;
}

function clearCookie(name: string, path: string): string {
  return `${name}=; Max-Age=0; Path=${path}; HttpOnly; SameSite=Lax; Secure`;
}

function failure(clearState: string, status = 400): Response {
  const response = text('authentication failed', status);
  response.headers.append('Set-Cookie', clearState);
  return response;
}

function authenticationFailure(status: number): Response {
  return text('authentication failed', status);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
