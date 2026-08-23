import { describe, expect, it } from 'vitest';
import { mintJwt, verifyJwt } from '../src/auth/jwt';

const SECRET = 'test-secret';

describe('JWT HS256 authentication', () => {
  it('round-trips arbitrary JSON claims and unicode', async () => {
    const token = await mintJwt({
      userId: 'alice',
      displayName: 'Zoë 🕵️',
      metadata: { greeting: 'こんにちは', flags: [true, null, 3] },
    }, SECRET, 60);

    const claims = await verifyJwt(token, SECRET);

    expect(claims).toMatchObject({
      userId: 'alice',
      displayName: 'Zoë 🕵️',
      metadata: { greeting: 'こんにちは', flags: [true, null, 3] },
    });
    expect(typeof claims?.iat).toBe('number');
    expect(typeof claims?.exp).toBe('number');
  });

  it('rejects a wrong secret, signature tampering, and payload tampering', async () => {
    const token = await mintJwt({ userId: 'alice', access: 'read' }, SECRET, 60);
    const [header, payload, signature] = token.split('.');

    expect(await verifyJwt(token, 'wrong-secret')).toBeNull();
    expect(await verifyJwt(`${header}.${payload}.${flip(signature!)}`, SECRET)).toBeNull();
    expect(await verifyJwt(`${header}.${flip(payload!)}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects malformed segment counts and base64url', async () => {
    const token = await mintJwt({ userId: 'alice' }, SECRET, 60);
    const [header, payload, signature] = token.split('.');

    for (const malformed of [
      `${header}.${payload}`,
      `${header}.${payload}.${signature}.extra`,
      `.${payload}.${signature}`,
      `${header}..${signature}`,
      `${header}.${payload}.not+base64`,
      `${header}.${payload}.a`,
      `${header}=.${payload}.${signature}`,
    ]) {
      expect(await verifyJwt(malformed, SECRET)).toBeNull();
    }
  });

  it('rejects malformed JSON and non-object header or payload', async () => {
    expect(await verifyRaw('{', '{"userId":"alice"}')).toBeNull();
    expect(await verifyRaw('{"alg":"HS256","typ":"JWT"}', '[')).toBeNull();
    expect(await verifyRaw('null', '{"userId":"alice"}')).toBeNull();
    expect(await verifyRaw('{"alg":"HS256","typ":"JWT"}', 'null')).toBeNull();
  });

  it('rejects algorithm confusion and malformed headers even with valid signatures', async () => {
    expect(await verifyRaw('{"alg":"none","typ":"JWT"}', '{"userId":"alice"}')).toBeNull();
    expect(await verifyRaw('{"alg":"HS384","typ":"JWT"}', '{"userId":"alice"}')).toBeNull();
    expect(await verifyRaw('{"alg":"HS256","typ":"JWS"}', '{"userId":"alice"}')).toBeNull();
    expect(await verifyRaw('{"alg":null,"typ":"JWT"}', '{"userId":"alice"}')).toBeNull();
  });

  it('requires a non-empty bounded string userId', async () => {
    expect(await verifyClaims({ exp: future(), iat: past() })).toBeNull();
    expect(await verifyClaims({ userId: '' })).toBeNull();
    expect(await verifyClaims({ userId: 'alice smith', exp: future(), iat: past() })).toBeNull();
    expect(await verifyClaims({ userId: ' alice', exp: future(), iat: past() })).toBeNull();
    expect(await verifyClaims({ userId: 42 })).toBeNull();
    expect(await verifyClaims({ userId: 'x'.repeat(129) })).toBeNull();
    expect((await verifyClaims({ userId: '用户', exp: future(), iat: past() }))?.userId)
      .toBe('用户');
    expect((await verifyClaims({ userId: 'x'.repeat(128), exp: future(), iat: past() }))?.userId)
      .toBe('x'.repeat(128));
  });

  it('enforces expiry, iat/exp relationships, and numeric claims', async () => {
    const issuedAt = now() - 1;
    expect(await verifyClaims({ userId: 'alice', iat: past() })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', exp: future() })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', exp: now() })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', exp: past() })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', exp: future(), iat: future() })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', exp: 20, iat: 20 })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', exp: issuedAt + 86_401, iat: issuedAt })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', exp: future(), iat: future() - 1 })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', exp: 'tomorrow' })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', exp: null })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', iat: 1.5 })).toBeNull();
    expect(await verifyClaims({ userId: 'alice', iat: -1 })).toBeNull();
    expect((await verifyClaims({ userId: 'alice', exp: future(), iat: past() }))?.userId)
      .toBe('alice');
    const boundary = now() - 1;
    expect((await verifyClaims({ userId: 'alice', iat: boundary, exp: boundary + 86_400 }))?.userId)
      .toBe('alice');
  });

  it('validates TTL boundaries while minting', async () => {
    await expect(mintJwt({ userId: 'alice' }, SECRET, 1)).resolves.toMatch(/\./);
    await expect(mintJwt({ userId: 'alice' }, SECRET, 86_400)).resolves.toMatch(/\./);
    await expect(mintJwt({ userId: 'alice' }, SECRET, 0)).rejects.toThrow('invalid JWT TTL');
    await expect(mintJwt({ userId: 'alice' }, SECRET, -1)).rejects.toThrow('invalid JWT TTL');
    await expect(mintJwt({ userId: 'alice' }, SECRET, 86_401)).rejects.toThrow('invalid JWT TTL');
    await expect(mintJwt({ userId: 'alice' }, SECRET, 1.5)).rejects.toThrow('invalid JWT TTL');
  });

  it('rejects missing or invalid secrets and unsafe payload values', async () => {
    await expect(mintJwt({ userId: 'alice' }, '', 60)).rejects.toThrow('JWT secret is required');
    await expect(mintJwt({ userId: 'alice' }, 'x'.repeat(4_097), 60))
      .rejects.toThrow('JWT secret is required');
    expect(await verifyJwt('not.a.jwt', '')).toBeNull();
    await expect(mintJwt(null as unknown as Record<string, unknown>, SECRET, 60))
      .rejects.toThrow('JWT payload must be a JSON object');
    await expect(mintJwt({ userId: 'alice', value: Number.NaN }, SECRET, 60))
      .rejects.toThrow('JWT payload must contain only JSON values');
  });
});

async function verifyClaims(claims: Record<string, unknown>) {
  return verifyRaw('{"alg":"HS256","typ":"JWT"}', JSON.stringify(claims));
}

async function verifyRaw(header: string, payload: string) {
  const token = await signRaw(header, payload, SECRET);
  return verifyJwt(token, SECRET);
}

async function signRaw(header: string, payload: string, secret: string): Promise<string> {
  const encodedHeader = encode(new TextEncoder().encode(header));
  const encodedPayload = encode(new TextEncoder().encode(payload));
  const input = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${encode(new Uint8Array(signature))}`;
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function flip(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
}

function now(): number {
  return Math.floor(Date.now() / 1_000);
}

function future(): number {
  return now() + 60;
}

function past(): number {
  return now() - 60;
}
