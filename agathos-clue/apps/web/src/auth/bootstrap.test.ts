import { describe, expect, it, vi } from 'vitest';
import { bootstrapAuth, isEmbeddedContext } from './bootstrap';

describe('auth bootstrap', () => {
  it('selects standalone auth outside an embedded context', async () => {
    const redirect = vi.fn();
    const fetcher = vi.fn(async () => Response.json({
      authenticated: true,
      userId: '123',
      token: 'app-jwt',
    }));
    const sdkFactory = vi.fn(async () => { throw new Error('SDK must not load'); });

    await expect(bootstrapAuth({
      embedded: false,
      fetcher,
      redirect,
      sdkFactory,
    })).resolves.toEqual({ authenticated: true, userId: '123', token: 'app-jwt' });
    expect(sdkFactory).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('selects the embedded adapter when requested', async () => {
    const fetcher = vi.fn(async () => Response.json({
      authenticated: true,
      userId: '123',
      token: 'app-jwt',
      access_token: 'discord-access-token',
    }));
    const sdkFactory = vi.fn(async () => ({
      ready: vi.fn(async () => undefined),
      commands: {
        authorize: vi.fn(async () => ({ code: 'code' })),
        authenticate: vi.fn(async () => undefined),
      },
    }));

    await expect(bootstrapAuth({
      embedded: true,
      clientId: 'client-id',
      fetcher,
      sdkFactory,
    })).resolves.toEqual({ authenticated: true, userId: '123', token: 'app-jwt' });
    expect(sdkFactory).toHaveBeenCalledWith('client-id');
  });

  it('detects an iframe without loading the SDK for a top-level page', () => {
    const topLevel = {} as Window;
    Object.defineProperty(topLevel, 'self', { value: topLevel });
    Object.defineProperty(topLevel, 'top', { value: topLevel });
    const iframe = {} as Window;
    Object.defineProperty(iframe, 'self', { value: iframe });
    Object.defineProperty(iframe, 'top', { value: topLevel });

    expect(isEmbeddedContext(topLevel)).toBe(false);
    expect(isEmbeddedContext(iframe)).toBe(true);
  });
});
