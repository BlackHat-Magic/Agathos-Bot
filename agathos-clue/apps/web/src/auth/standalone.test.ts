import { describe, expect, it, vi } from 'vitest';
import { beginStandaloneAuth, loadStandaloneSession } from './standalone';

describe('standalone auth helper', () => {
  it('loads a same-origin session with credentials', async () => {
    const redirect = vi.fn();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
      expect(init?.headers).toEqual({ Accept: 'application/json' });
      return Response.json({ authenticated: true, userId: '123', token: 'jwt' });
    });

    await expect(loadStandaloneSession(fetcher, redirect)).resolves.toEqual({
      authenticated: true,
      userId: '123',
      token: 'jwt',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects to standalone auth when the worker reports no session', async () => {
    const redirect = vi.fn();
    await expect(loadStandaloneSession(async () => new Response(null, { status: 401 }), redirect)).resolves.toBeNull();
    expect(redirect).toHaveBeenCalledWith('/auth/begin');
  });

  it('rejects malformed session payloads and starts login without storing a token', async () => {
    await expect(loadStandaloneSession(async () => Response.json({ authenticated: true, userId: '123' })))
      .rejects.toThrow('session response was invalid');

    const redirect = vi.fn();
    beginStandaloneAuth(redirect);
    expect(redirect).toHaveBeenCalledWith('/auth/begin');
  });

  it('falls back to default navigation when invoked with a DOM event like Svelte does', () => {
    const assign = vi.fn();
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { assign } },
    });
    try {
      expect(() => beginStandaloneAuth({ clientY: 12 })).not.toThrow();
      expect(assign).toHaveBeenCalledWith('/auth/begin');
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});
