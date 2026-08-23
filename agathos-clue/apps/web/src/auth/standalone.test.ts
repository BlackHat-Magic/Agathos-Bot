import { describe, expect, it, vi } from 'vitest';
import { beginStandaloneAuth, loadStandaloneSession } from './standalone';

describe('standalone auth helper', () => {
  it('loads a same-origin session with credentials', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
      expect(init?.headers).toEqual({ Accept: 'application/json' });
      return Response.json({ authenticated: true, userId: '123', token: 'jwt' });
    });

    await expect(loadStandaloneSession(fetcher)).resolves.toEqual({
      authenticated: true,
      userId: '123',
      token: 'jwt',
    });
  });

  it('returns null when the worker reports no session', async () => {
    await expect(loadStandaloneSession(async () => new Response(null, { status: 401 }))).resolves.toBeNull();
  });

  it('rejects malformed session payloads and starts login without storing a token', async () => {
    await expect(loadStandaloneSession(async () => Response.json({ authenticated: true, userId: '123' })))
      .rejects.toThrow('session response was invalid');

    const redirect = vi.fn();
    beginStandaloneAuth(redirect);
    expect(redirect).toHaveBeenCalledWith('/auth/begin');
  });
});
