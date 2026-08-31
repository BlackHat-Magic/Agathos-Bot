import type { StandaloneSession } from './standalone';
import { isValidGameId } from '../transport/game-id';

const MAX_CLIENT_ID_LENGTH = 128;
const MAX_ACCESS_TOKEN_LENGTH = 1_024;
const MAX_INSTANCE_ID_LENGTH = 64;

/**
 * Discord assigns one shared `instanceId` to every participant of the same
 * Activity instance (one voice channel), so it is the natural multiplayer
 * room key: no manual game code entry is needed in embedded mode.
 */
export interface EmbeddedSession extends StandaloneSession {
  instanceId: string;
}

export interface EmbeddedSdk {
  readonly instanceId: string;
  ready(): Promise<void>;
  commands: {
    authorize(input: {
      client_id: string;
      response_type: 'code';
      state: string;
      prompt: 'none';
      scope: ['identify'];
    }): Promise<{ code: string }>;
    authenticate(input: { access_token: string }): Promise<unknown>;
  };
}

export type EmbeddedSdkFactory = (clientId: string) => Promise<EmbeddedSdk>;

export interface EmbeddedSessionOptions {
  clientId?: string;
  fetcher?: typeof fetch;
  sdkFactory?: EmbeddedSdkFactory;
}

export async function loadEmbeddedSession(
  options: EmbeddedSessionOptions = {},
): Promise<EmbeddedSession> {
  const clientId = options.clientId ?? import.meta.env.VITE_DISCORD_CLIENT_ID;
  if (!isBoundedString(clientId, MAX_CLIENT_ID_LENGTH)) {
    throw new Error('embedded authentication is unavailable');
  }

  const sdk = await (options.sdkFactory ?? createDiscordSdk)(clientId);
  if (!isBoundedString(sdk.instanceId, MAX_INSTANCE_ID_LENGTH) ||
      !isValidGameId(`clue-game:${sdk.instanceId}`)) {
    throw new Error('embedded activity instance is invalid');
  }
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });
  if (!isBoundedString(code, 4_096)) throw new Error('embedded authorization returned an invalid code');

  const response = await (options.fetcher ?? fetch)('/auth/embedded-exchange', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('embedded session request failed');

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('embedded session response was not valid JSON');
  }
  if (!isEmbeddedSessionResponse(value)) throw new Error('embedded session response was invalid');

  await sdk.commands.authenticate({ access_token: value.access_token });
  return {
    authenticated: true,
    userId: value.userId,
    token: value.token,
    instanceId: sdk.instanceId,
  };
}

async function createDiscordSdk(clientId: string): Promise<EmbeddedSdk> {
  const { DiscordSDK } = await import('@discord/embedded-app-sdk');
  return new DiscordSDK(clientId);
}

function isEmbeddedSessionResponse(value: unknown): value is {
  authenticated: true;
  userId: string;
  token: string;
  access_token: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return response.authenticated === true &&
    isBoundedString(response.userId, 128) && !/\s/.test(response.userId) &&
    isBoundedString(response.token, 32_768) &&
    isBoundedString(response.access_token, MAX_ACCESS_TOKEN_LENGTH);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
