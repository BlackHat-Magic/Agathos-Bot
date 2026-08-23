import type { Card, Game, Intent } from '@agathos/game';
import { isValidUserId, verifyJwt } from './auth/jwt';

const LIFECYCLE_INTENTS = new Set([
  'join', 'claimSuspect', 'start', 'setOrder', 'leave',
]);

export interface IntentEnvelope {
  intent: Intent;
}

export type PrivateRevealFrame =
  | { type: 'private'; reveal: { fromIndex: number; card: Card } }
  | { type: 'private'; reveal: { fromIndex: number } };

export interface AuthenticatedJwtProtocol {
  protocol: string;
  userId: string;
  claims: Record<string, unknown>;
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

/** Verify one offered bearer subprotocol without accepting legacy dev tokens. */
export async function authenticateJwtProtocol(
  protocol: string,
  secret: string,
): Promise<AuthenticatedJwtProtocol | null> {
  if (!protocol.startsWith('bearer.')) return null;
  const token = protocol.slice('bearer.'.length);
  if (token.length === 0) return null;
  const claims = await verifyJwt(token, secret);
  if (claims === null || !isValidUserId(claims.userId)) return null;
  return { protocol, userId: claims.userId, claims };
}

/** Select the first authenticated protocol while preserving its offered value. */
export async function negotiateJwtProtocol(
  protocolHeader: string | null,
  secret: string,
): Promise<AuthenticatedJwtProtocol | null> {
  if (protocolHeader === null) return null;
  for (const value of protocolHeader.split(',')) {
    const protocol = value.trim();
    const authenticated = await authenticateJwtProtocol(protocol, secret);
    if (authenticated !== null) return authenticated;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
