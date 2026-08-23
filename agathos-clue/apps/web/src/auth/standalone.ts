/**
 * The token is intentionally returned only from an explicit same-origin
 * session fetch. Task 20 can offer it as the `bearer.<token>` WebSocket
 * subprotocol; this helper does not put it in markup or persistent storage.
 */
export interface StandaloneSession {
  authenticated: true;
  userId: string;
  token: string;
}

export async function loadStandaloneSession(
  fetcher: typeof fetch = fetch,
): Promise<StandaloneSession | null> {
  const response = await fetcher('/auth/session', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401) return null;
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

export function beginStandaloneAuth(
  redirect: (path: string) => void = path => window.location.assign(path),
): void {
  redirect('/auth/begin');
}

function isStandaloneSession(value: unknown): value is StandaloneSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return session.authenticated === true && typeof session.userId === 'string' &&
    session.userId.length > 0 && session.userId.length <= 128 &&
    !/\s/.test(session.userId) && typeof session.token === 'string' &&
    session.token.length > 0 && session.token.length <= 32_768;
}
