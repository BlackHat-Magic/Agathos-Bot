import { writable } from 'svelte/store';

/**
 * The short-lived app token is intentionally returned only from an explicit
 * same-origin session fetch and is used as the WebSocket bearer subprotocol.
 * This helper does not put it in markup or persistent storage.
 */
export interface StandaloneSession {
  authenticated: true;
  userId: string;
  token: string;
}

export const session = writable<StandaloneSession | null>(null);

export async function loadStandaloneSession(
  fetcher: typeof fetch = fetch,
  redirect: (path: string) => void = path => window.location.assign(path),
): Promise<StandaloneSession | null> {
  const response = await fetcher('/auth/session', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401) {
    beginStandaloneAuth(redirect);
    return null;
  }
  if (!response.ok) throw new Error('session request failed');

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('session response was not valid JSON');
  }
  if (!isStandaloneSession(value)) throw new Error('session response was invalid');
  return value;
}

/** Refresh only the app JWT; Discord access tokens never enter this path. */
export async function refreshStandaloneToken(fetcher: typeof fetch = fetch): Promise<string | null> {
  const response = await fetcher('/auth/session', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return null;
  let value: unknown;
  try { value = await response.json(); } catch { return null; }
  return isStandaloneSession(value) ? value.token : null;
}

/**
 * Svelte event attributes invoke handlers with the DOM event as the first
 * argument, so a non-function first argument (e.g. a MouseEvent) must fall
 * back to the default navigation instead of being called.
 */
export function beginStandaloneAuth(redirect?: unknown): void {
  const defaultRedirect = (path: string): void => window.location.assign(path);
  const navigate = typeof redirect === 'function'
    ? redirect as (path: string) => void
    : defaultRedirect;
  navigate('/auth/begin');
}

function isStandaloneSession(value: unknown): value is StandaloneSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return session.authenticated === true && typeof session.userId === 'string' &&
    session.userId.length > 0 && session.userId.length <= 128 &&
    !/\s/.test(session.userId) && typeof session.token === 'string' &&
    session.token.length > 0 && session.token.length <= 32_768;
}
