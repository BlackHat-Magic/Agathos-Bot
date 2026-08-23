import type { Env } from '../index';
import { isValidUserId } from './jwt';

const DISCORD_TOKEN_ENDPOINT = 'https://discord.com/api/oauth2/token';
const DISCORD_ME_ENDPOINT = 'https://discord.com/api/users/@me';
export const MAX_UPSTREAM_BODY_BYTES = 16_384;
export const MAX_CLIENT_ID_LENGTH = 128;
export const MAX_REDIRECT_URI_LENGTH = 2_048;
export const MAX_CODE_LENGTH = 4_096;
export const MAX_REQUEST_BODY_BYTES = 16_384;
export const MAX_DISCORD_TOKEN_LENGTH = 1_024;
export const MAX_DISCORD_USER_ID_LENGTH = 32;

export const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export async function exchangeCode(
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

export async function fetchDiscordUser(accessToken: string): Promise<{ id: string }> {
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

export async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
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

export async function readJsonRequest(request: Request): Promise<Record<string, unknown>> {
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

export function boundedParam(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

export function isDiscordUserId(value: unknown): value is string {
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

export function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export function isJsonContentType(value: string | null): boolean {
  return value !== null && value.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
