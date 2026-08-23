const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const MAX_SECRET_BYTES = 4_096;
const MAX_TOKEN_BYTES = 32_768;
const MAX_USER_ID_LENGTH = 128;
const MAX_TTL_SECONDS = 86_400;

export type JwtClaims = Record<string, unknown>;

export async function mintJwt(
  payload: JwtClaims,
  secret: string,
  ttlSec = 3_600,
): Promise<string> {
  assertSecret(secret);
  assertPayload(payload);
  assertUserId(payload.userId);
  if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_TTL_SECONDS) {
    throw new Error('invalid JWT TTL');
  }

  const now = Math.floor(Date.now() / 1_000);
  const body = cloneObject(payload);
  body.iat = now;
  body.exp = now + ttlSec;
  const encodedHeader = encodeBase64Url(encoder.encode('{"alg":"HS256","typ":"JWT"}'));
  const encodedPayload = encodeBase64Url(encoder.encode(stringifyJson(body)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signingKey = await importHmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign(
    'HMAC',
    signingKey,
    encoder.encode(signingInput),
  );
  const token = `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
  if (encoder.encode(token).byteLength > MAX_TOKEN_BYTES) {
    throw new Error('JWT is too large');
  }
  return token;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  if (!isValidSecret(secret) || typeof token !== 'string' ||
      encoder.encode(token).byteLength > MAX_TOKEN_BYTES) return null;

  const segments = token.split('.');
  if (segments.length !== 3 || segments.some(segment => segment.length === 0)) return null;
  const headerBytes = decodeBase64Url(segments[0]!);
  const payloadBytes = decodeBase64Url(segments[1]!);
  const signature = decodeBase64Url(segments[2]!);
  if (headerBytes === null || payloadBytes === null || signature === null) return null;

  const header = parseJsonObject(headerBytes);
  if (header === null || header.alg !== 'HS256' || header.typ !== 'JWT') return null;

  try {
    const verificationKey = await importHmacKey(secret, ['verify']);
    const valid = await crypto.subtle.verify(
      'HMAC',
      verificationKey,
      signature,
      encoder.encode(`${segments[0]}.${segments[1]}`),
    );
    if (!valid) return null;
  } catch {
    return null;
  }

  const payload = parseJsonObject(payloadBytes);
  if (payload === null || !isValidClaims(payload)) return null;
  return payload;
}

async function importHmacKey(secret: string, usages: ('sign' | 'verify')[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

function assertSecret(secret: unknown): asserts secret is string {
  if (!isValidSecret(secret)) throw new Error('JWT secret is required');
}

function isValidSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length > 0 &&
    encoder.encode(secret).byteLength <= MAX_SECRET_BYTES;
}

function assertPayload(payload: unknown): asserts payload is JwtClaims {
  if (!isJsonObject(payload)) throw new Error('JWT payload must be a JSON object');
  try {
    cloneJsonValue(payload, new WeakSet<object>());
  } catch {
    throw new Error('JWT payload must contain only JSON values');
  }
}

function assertUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > MAX_USER_ID_LENGTH) {
    throw new Error('JWT userId is invalid');
  }
}

function isValidClaims(payload: Record<string, unknown>): boolean {
  if (!Object.hasOwn(payload, 'userId')) return false;
  try {
    assertUserId(payload.userId);
  } catch {
    return false;
  }

  const hasIat = Object.hasOwn(payload, 'iat');
  const hasExp = Object.hasOwn(payload, 'exp');
  if (hasIat && !isNumericDate(payload.iat)) return false;
  if (hasExp && !isNumericDate(payload.exp)) return false;

  const now = Math.floor(Date.now() / 1_000);
  if (hasIat && (payload.iat as number) > now) return false;
  if (hasExp && (payload.exp as number) <= now) return false;
  if (hasIat && hasExp && (payload.exp as number) <= (payload.iat as number)) return false;

  try {
    cloneJsonValue(payload, new WeakSet<object>());
  } catch {
    return false;
  }
  return true;
}

function isNumericDate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  return isJsonObject(value) ? value : null;
}

function stringifyJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('not JSON');
    return serialized;
  } catch {
    throw new Error('JWT payload must contain only JSON values');
  }
}

function cloneObject(value: Record<string, unknown>): Record<string, unknown> {
  return cloneJsonValue(value, new WeakSet<object>()) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return value;
  }
  if (typeof value !== 'object') throw new Error('non-JSON value');
  if (ancestors.has(value)) throw new Error('cyclic value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => cloneJsonValue(item, ancestors));
    if (!isJsonObject(value)) throw new Error('non-plain object');
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) clone[key] = cloneJsonValue(value[key], ancestors);
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const padded = value + '='.repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return encodeBase64Url(bytes) === value ? bytes : null;
}
