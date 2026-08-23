import { describe, expect, it } from 'vitest';
import type { GameView } from '@agathos/game';
import { finishedGameMessage } from './result-message';

const players: GameView['players'] = [
  {
    name: 'Alice', suspect: 'Miss Scarlett', location: '16,24', handCount: 0,
    failedAccusation: false, guessedHere: false, isRobot: false, movedBySuggestion: false,
  },
  {
    name: 'Bob', suspect: 'Professor Plum', location: '0,19', handCount: 0,
    failedAccusation: false, guessedHere: false, isRobot: false, movedBySuggestion: false,
  },
];

describe('finished game messaging', () => {
  it('identifies the viewer or another detective when there is a winner', () => {
    expect(finishedGameMessage({ winnerIndex: 0, myIndex: 0, players })).toBe('You solved the case.');
    expect(finishedGameMessage({ winnerIndex: 1, myIndex: 0, players })).toBe('Bob solved the case.');
  });

  it('does not claim a detective solved a no-winner game', () => {
    expect(finishedGameMessage({ winnerIndex: null, myIndex: 0, players })).toBe(
      'No detective solved the case.',
    );
  });
});
