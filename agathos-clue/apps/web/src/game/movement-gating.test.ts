import { describe, expect, it } from 'vitest';
import type { GameView } from '@agathos/game';
import { canClickMove } from './movement-gating';

function view(overrides: Partial<GameView> = {}): GameView {
  return {
    phase: 'playing',
    boardWidth: 24,
    boardHeight: 25,
    players: [{
      name: 'Alice', suspect: 'Miss Scarlett', location: '16,24', handCount: 0,
      failedAccusation: false, isRobot: false, movedBySuggestion: false,
    }],
    weaponLocations: [],
    turnIndex: 0,
    winnerIndex: null,
    pendingReveal: null,
    lastDieRoll: 7,
    hasRolledThisTurn: true,
    hasMovedThisTurn: false,
    canSuggest: false,
    canUseSecretPassage: false,
    myIndex: 0,
    myHand: [],
    ...overrides,
  };
}

describe('movement click gating', () => {
  it('accepts only a destination in the non-empty authoritative hints', () => {
    const current = view({ reachableSpacesHints: ['17,18', 'Lounge'] });

    expect(canClickMove(current, '17,18')).toBe(true);
    expect(canClickMove(current, '12,8')).toBe(false);
  });

  it('rejects clicks when hints are absent or empty', () => {
    expect(canClickMove(view(), '17,18')).toBe(false);
    expect(canClickMove(view({ reachableSpacesHints: [] }), '17,18')).toBe(false);
  });
});
