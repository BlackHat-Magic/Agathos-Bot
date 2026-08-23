import { describe, expect, it } from 'vitest';
import type { GameView } from '@agathos/game';
import { shouldCloseAfterAccusation } from './accusation-reconciliation';

function view(overrides: Partial<GameView> = {}): GameView {
  return {
    phase: 'playing',
    boardWidth: 24,
    boardHeight: 25,
    players: [{
      name: 'Alice', suspect: 'Miss Scarlett', location: 'Kitchen', handCount: 0,
      failedAccusation: false, guessedHere: false, isRobot: false, movedBySuggestion: false,
    }],
    weaponLocations: [],
    turnIndex: 0,
    winnerIndex: null,
    pendingReveal: null,
    lastDieRoll: null,
    myIndex: 0,
    myHand: [],
    ...overrides,
  };
}

describe('accusation reconciliation', () => {
  it('closes when a wrong accusation is accepted without an event delta', () => {
    const current = view({
      players: [{ ...view().players[0]!, failedAccusation: true }],
    });

    expect(shouldCloseAfterAccusation(current, {
      phase: 'playing',
      failedAccusation: false,
    })).toBe(true);
  });

  it('closes when a correct accusation finishes the game without an event delta', () => {
    expect(shouldCloseAfterAccusation(view({ phase: 'finished' }), {
      phase: 'playing',
      failedAccusation: false,
    })).toBe(true);
  });

  it('does not close for stale pre-submit outcome flags', () => {
    expect(shouldCloseAfterAccusation(view({
      players: [{ ...view().players[0]!, failedAccusation: true }],
    }), {
      phase: 'playing',
      failedAccusation: true,
    })).toBe(false);

    expect(shouldCloseAfterAccusation(view(), {
      phase: 'finished',
      failedAccusation: false,
    })).toBe(false);
  });

  it('retains pending state for an ordinary playing reconnect', () => {
    expect(shouldCloseAfterAccusation(view(), {
      phase: 'playing',
      failedAccusation: false,
    })).toBe(false);
  });
});
