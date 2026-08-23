import { describe, expect, it } from 'vitest';
import { buildBoard, createGame, spaceAt } from '@agathos/game';
import type { Intent, Player } from '@agathos/game';
import {
  assertIntentAuthority,
  authenticateDevProtocol,
  parseIntentEnvelope,
  resolveViewerIndex,
} from './game-room-protocol';

function player(suspect: Player['suspect'], index: number, userId: string): Player {
  const board = buildBoard();
  return {
    name: suspect,
    index,
    suspect,
    piece: { suspect, location: spaceAt(board, 16, 24) },
    cards: [],
    failedAccusation: false,
    guessedHere: false,
    movedBySuggestion: false,
    enteredRoomThisTurn: false,
    isRobot: false,
    userId,
  };
}

describe('GameRoom protocol helpers', () => {
  it('accepts the dev protocol and legacy direct forms', () => {
    expect(authenticateDevProtocol('bearer.dev-token-alice')).toBe('alice');
    expect(authenticateDevProtocol('dev-token-bob')).toBe('bob');
    expect(authenticateDevProtocol('Bearer dev-token-carol')).toBe('carol');
    expect(authenticateDevProtocol('bearer.dev-token-')).toBeNull();
    expect(authenticateDevProtocol(null)).toBeNull();
  });

  it('rejects malformed JSON and envelopes', () => {
    expect(() => parseIntentEnvelope('{')).toThrow('malformed JSON message');
    expect(() => parseIntentEnvelope(JSON.stringify({ intent: null }))).toThrow(
      'invalid intent envelope',
    );
    expect(parseIntentEnvelope(JSON.stringify({ intent: { kind: 'wait' } }))).toEqual({
      intent: { kind: 'wait' },
    });
  });

  it('resolves authority from user IDs and permits revealers outside turnIndex', () => {
    const game = createGame([
      player('Miss Scarlett', 0, 'alice'),
      player('Professor Plum', 1, 'bob'),
    ]);
    game.phase = 'playing';
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };

    expect(resolveViewerIndex(game, 'bob')).toBe(1);
    expect(resolveViewerIndex(game, 'nobody')).toBeNull();
    expect(() => assertIntentAuthority(game, 1, { kind: 'declineReveal' })).not.toThrow();
    expect(() => assertIntentAuthority(game, 1, { kind: 'roll' })).toThrow(
      "it is not player 1's turn",
    );
    expect(() => assertIntentAuthority(game, null, { kind: 'wait' })).not.toThrow();
    expect(() => assertIntentAuthority(game, null, { kind: 'roll' })).toThrow(
      'connection is not joined',
    );
  });

  it('keeps lobby lifecycle intents delegated to Task 14', () => {
    const game = createGame([player('Miss Scarlett', 0, 'alice')]);
    expect(() => assertIntentAuthority(game, 0, { kind: 'join', userId: 'alice', name: 'Alice' }))
      .toThrow('lobby intent handling is not available yet');
  });
});
