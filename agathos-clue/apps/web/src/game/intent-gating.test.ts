import { describe, expect, it } from 'vitest';
import type { GameView } from '@agathos/game';
import { actionsFor } from './intent-gating';

function view(overrides: Partial<GameView> = {}): GameView {
  return {
    phase: 'playing',
    boardWidth: 24,
    boardHeight: 25,
    players: [{
      name: 'Alice', suspect: 'Miss Scarlett', location: 'Kitchen', handCount: 0,
      failedAccusation: false, guessedHere: false, isRobot: false, movedBySuggestion: false,
    }, {
      name: 'Bob', suspect: 'Professor Plum', location: 'Study', handCount: 0,
      failedAccusation: false, guessedHere: false, isRobot: false, movedBySuggestion: false,
    }],
    weaponLocations: [],
    turnIndex: 0,
    winnerIndex: null,
    pendingReveal: null,
    lastDieRoll: null,
    hasRolledThisTurn: false,
    hasMovedThisTurn: false,
    canSuggest: true,
    canUseSecretPassage: true,
    myIndex: 0,
    myHand: [],
    ...overrides,
  };
}

describe('game intent gating', () => {
  it('allows only start-of-turn actions before a roll', () => {
    expect(actionsFor(view())).toMatchObject({
      myTurn: true, canRoll: true, canUseSecretPassage: true,
      canSuggest: true, canAccuse: true, canEndTurn: true, canMove: false,
    });
  });

  it('allows movement only after a roll and never for another player turn', () => {
    expect(actionsFor(view({ hasRolledThisTurn: true, lastDieRoll: 7 }))).toMatchObject({
      canRoll: false, canUseSecretPassage: false, canMove: true,
    });
    expect(actionsFor(view({ turnIndex: 1 }))).toMatchObject({
      myTurn: false, canRoll: false, canUseSecretPassage: false,
      canSuggest: false, canAccuse: false, canEndTurn: false, canMove: false,
    });
  });

  it('preserves failed-accusation state while allowing only end turn', () => {
    const current = view({
      players: [
        { ...view().players[0]!, failedAccusation: true },
        view().players[1]!,
      ],
    });
    expect(actionsFor(current)).toMatchObject({
      failedAccusation: true, canRoll: false, canUseSecretPassage: false,
      canSuggest: false, canAccuse: false, canEndTurn: true,
    });
  });

  it('does not advertise movement intents after making a suggestion', () => {
    const current = view({
      players: [
        { ...view().players[0]!, guessedHere: true },
        view().players[1]!,
      ],
      hasRolledThisTurn: true,
      lastDieRoll: 7,
    });

    expect(actionsFor(current)).toMatchObject({
      canRoll: false,
      canUseSecretPassage: false,
      canSuggest: false,
      canMove: false,
      canEndTurn: true,
    });
  });
});
