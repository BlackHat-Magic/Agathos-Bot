import { describe, it, expect } from 'bun:test';
import { createGame } from '../src/rules';
import { decideRobotIntent } from '../src/robot';
import { spaceAt, buildBoard } from '../src/board';
import type { Player, Game, Intent } from '../src/types';

function mkRobot(suspect: any, idx: number): Player {
  return {
    name: suspect, index: idx, suspect,
    piece: { suspect, location: spaceAt(buildBoard(), 16, 24) },
    cards: [], failedAccusation: false, guessedHere: false,
    movedBySuggestion: false, enteredRoomThisTurn: false, isRobot: true,
  };
}

describe('decideRobotIntent', () => {
  it('rolls when not in a room', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0)]);
    g.turnIndex = 0;
    g.phase = 'playing';
    const intent = decideRobotIntent(g, 0, () => 0.5);
    expect(intent.kind === 'roll' || intent.kind === 'endTurn').toBe(true);
  });

  it('suggests when in a room and not yet guessed this turn', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0)]);
    g.turnIndex = 0; g.phase = 'playing';
    // Place Scarlett in Hall
    g.players[0].piece.location = spaceAt(g.board, 10, 18);
    g.players[0].enteredRoomThisTurn = true;
    const intent = decideRobotIntent(g, 0, () => 0.5);
    expect(intent.kind).toBe('suggest');
  });

  // NOTE: spec used `() => 0.5`; the implementation uses strict `< 0.5`,
  // matching clue.py:407 `random.choice([True, False])` (a 50%/50% split).
  // With `0.5 < 0.5 === false`, the passage branch would be skipped. To
  // exercise the passage branch deterministically, the RNG returns 0.4.
  it('takes secret passage probabilistically when in a corner room', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0)]);
    g.turnIndex = 0; g.phase = 'playing';
    g.players[0].piece.location = buildBoard()[2][1];  // Conservatory
    const intent = decideRobotIntent(g, 0, () => 0.4);
    expect(intent.kind).toBe('useSecretPassage');
  });
});
