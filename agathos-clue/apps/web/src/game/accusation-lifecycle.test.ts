import { describe, expect, it } from 'vitest';
import { enqueueAccusation } from './accusation-lifecycle';
import { shouldCloseAfterAccusation } from './components/accusation-reconciliation';
import type { GameView } from '@agathos/game';

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

describe('accusation lifecycle', () => {
  it('clears an old error before an accepted retry and reconciles state-only acceptance', () => {
    let visibleError: string | null = 'previous failure';
    let errorAtSend: string | null = null;
    let accusationPending = false;

    const enqueued = enqueueAccusation(
      () => { visibleError = null; },
      () => {
        errorAtSend = visibleError;
        return true;
      },
    );
    if (enqueued) accusationPending = true;

    expect(errorAtSend).toBeNull();
    expect(enqueued).toBe(true);
    expect(accusationPending).toBe(true);
    expect(shouldCloseAfterAccusation(
      view({ players: [{ ...view().players[0]!, failedAccusation: true }] }),
      { phase: 'playing', failedAccusation: false },
    )).toBe(true);
  });

  it('restores retryable controls when the retry enqueue fails with a new error', () => {
    let visibleError: string | null = 'previous failure';
    let accusationPending = false;

    const enqueued = enqueueAccusation(
      () => { visibleError = null; },
      () => {
        visibleError = 'new failure';
        return false;
      },
    );
    if (enqueued) accusationPending = true;

    expect(enqueued).toBe(false);
    expect(accusationPending).toBe(false);
    expect(visibleError).toBe('new failure');
  });
});
