import { describe, expect, it } from 'vitest';
import { finishedGameMessage } from './result-message';

const players = [{ name: 'Alice' }, { name: 'Bob' }];

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
