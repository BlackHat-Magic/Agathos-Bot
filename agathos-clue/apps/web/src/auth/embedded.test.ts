import { describe, expect, it, vi } from 'vitest';
import { loadEmbeddedSession, type EmbeddedSdk } from './embedded';

function sdk(instanceId = 'activity-instance-1'): EmbeddedSdk {
  return {
    instanceId,
    ready: vi.fn(async () => undefined),
    commands: {
      authorize: vi.fn(async input => {
        expect(input).toMatchObject({
          client_id: 'client-id',
          response_type: 'code',
          state: '',
          prompt: 'none',
          scope: ['identify'],
        });
        return { code: 'embedded-code' };
      }),
      authenticate: vi.fn(async input => {
        expect(input).toEqual({ access_token: 'discord-access-token' });
        return { access_token: 'discord-access-token' };
      }),
    },
  };
}

describe('embedded auth adapter', () => {
  it('lazily initializes Discord, exchanges the code, authenticates the SDK, and returns only the app session', async () => {
    const discord = sdk();
    const factory = vi.fn(async (clientId: string) => {
      expect(clientId).toBe('client-id');
      return discord;
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('/auth/embedded-exchange');
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      });
      expect(init?.body).toBe(JSON.stringify({ code: 'embedded-code' }));
      return Response.json({
        authenticated: true,
        userId: '123',
        token: 'app-jwt',
        access_token: 'discord-access-token',
      });
    });

    await expect(loadEmbeddedSession({ clientId: 'client-id', fetcher, sdkFactory: factory }))
      .resolves.toEqual({
        authenticated: true,
        userId: '123',
        token: 'app-jwt',
        instanceId: 'activity-instance-1',
      });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(discord.ready).toHaveBeenCalledTimes(1);
    expect(discord.commands.authorize).toHaveBeenCalledTimes(1);
    expect(discord.commands.authenticate).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing or malformed activity instance id before authorizing', async () => {
    await expect(loadEmbeddedSession({
      clientId: 'client-id',
      sdkFactory: async () => sdk(''),
      fetcher,
    })).rejects.toThrow('embedded activity instance is invalid');
    await expect(loadEmbeddedSession({
      clientId: 'client-id',
      sdkFactory: async () => sdk('bad instance id'),
      fetcher,
    })).rejects.toThrow('embedded activity instance is invalid');

    function fetcher(): Promise<Response> {
      throw new Error('exchange must not run for an invalid instance');
    }
  });

  it('rejects malformed exchange responses before authenticating the SDK', async () => {
    const discord = sdk();
    await expect(loadEmbeddedSession({
      clientId: 'client-id',
      sdkFactory: async () => discord,
      fetcher: async () => Response.json({ authenticated: true, userId: '123', token: 'app-jwt' }),
    })).rejects.toThrow('embedded session response was invalid');
    expect(discord.commands.authenticate).not.toHaveBeenCalled();
  });

  it('surfaces an unsuccessful Worker response without exposing its body', async () => {
    await expect(loadEmbeddedSession({
      clientId: 'client-id',
      sdkFactory: async () => sdk(),
      fetcher: async () => new Response('private failure', { status: 502 }),
    })).rejects.toThrow('embedded session request failed');
  });
});
