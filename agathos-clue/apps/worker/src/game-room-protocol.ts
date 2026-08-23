import type { Game, Intent } from '@agathos/game';

const LIFECYCLE_INTENTS = new Set([
  'join', 'claimSuspect', 'start', 'setOrder', 'leave',
]);

export interface IntentEnvelope {
  intent: Intent;
}

export interface AuthenticatedDevProtocol {
  protocol: string;
  userId: string;
}

/** Parse a client envelope without trusting any client-supplied player index. */
export function parseIntentEnvelope(data: string | ArrayBuffer): IntentEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      typeof data === 'string' ? data : new TextDecoder().decode(data),
    );
  } catch {
    throw new Error('malformed JSON message');
  }

  if (!isRecord(decoded) || !isRecord(decoded.intent) ||
    typeof decoded.intent.kind !== 'string') {
    throw new Error('invalid intent envelope');
  }
  return { intent: decoded.intent as Intent };
}

/**
 * Temporary Task 13 verifier. Task 18 replaces this with real JWT validation.
 * The direct `dev-token-` form is retained for the scaffold's legacy clients.
 */
export function authenticateDevProtocol(protocolHeader: string | null): string | null {
  if (protocolHeader === null) return null;
  for (const protocol of protocolHeader.split(',').map(value => value.trim())) {
    const match = /^(?:bearer\.dev-token-|dev-token-|bearer\s+dev-token-)(\S+)$/i.exec(protocol);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Select the first authenticated protocol while preserving its offered value. */
export function negotiateDevProtocol(protocolHeader: string | null): AuthenticatedDevProtocol | null {
  if (protocolHeader === null) return null;
  for (const value of protocolHeader.split(',')) {
    const protocol = value.trim();
    const userId = authenticateDevProtocol(protocol);
    if (userId !== null) return { protocol, userId };
  }
  return null;
}

/** Resolve a connection identity against the current authoritative player list. */
export function resolveViewerIndex(game: Game, userId: string): number | null {
  const index = game.players.findIndex(player => player.userId === userId);
  return index === -1 ? null : index;
}

/**
 * Reject authority failures before invoking the reducer. The reducer repeats
 * these checks so this boundary is defense in depth, not a replacement for it.
 */
export function assertIntentAuthority(
  game: Game,
  viewerIndex: number | null,
  intent: Intent,
): void {
  if (intent.kind === 'wait') return;
  if (LIFECYCLE_INTENTS.has(intent.kind)) {
    throw new Error('lobby intent handling is not available yet');
  }
  if (viewerIndex === null) throw new Error('connection is not joined');

  if (intent.kind === 'showCard' || intent.kind === 'declineReveal') {
    if (game.pendingReveal?.revealerIndex !== viewerIndex) {
      throw new Error('player is not the current revealer');
    }
    return;
  }
  if (game.turnIndex !== viewerIndex) {
    throw new Error(`it is not player ${viewerIndex}'s turn`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
