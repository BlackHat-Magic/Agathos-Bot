import { describe, it, expect } from 'bun:test';
import { applyIntent } from '../src/reducer';
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
  it('rolls from a corridor and ends after corridor movement', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0)]);
    g.turnIndex = 0;
    g.phase = 'playing';
    const roll = decideRobotIntent(g, 0, () => 0.5);
    expect(roll).toEqual({ kind: 'roll' });
    applyIntent(g, 0, roll, () => 0);

    const move = decideRobotIntent(g, 0, () => 0.5);
    expect(move).toEqual({ kind: 'moveTo', destination: '15,23' });
    applyIntent(g, 0, move);

    expect(g.players[0]!.piece.location.room).toBeNull();
    expect(decideRobotIntent(g, 0, () => 0.5)).toEqual({ kind: 'endTurn' });
  });

  it('rolls from an ordinary room and then chooses a destination', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0)]);
    g.turnIndex = 0; g.phase = 'playing';
    g.players[0]!.piece.location = spaceAt(g.board, 10, 18);

    const roll = decideRobotIntent(g, 0, () => 0.4);
    expect(roll).toEqual({ kind: 'roll' });
    applyIntent(g, 0, roll, () => 0);

    const move = decideRobotIntent(g, 0, () => 0.5);
    expect(move.kind).toBe('moveTo');
    applyIntent(g, 0, move);

    expect(g.players[0]!.piece.location.room).toBeNull();
  });

  it('suggests when in a room and not yet guessed this turn', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0), mkRobot('Professor Plum', 1)]);
    g.turnIndex = 0; g.phase = 'playing';
    // Place Scarlett in Hall
    g.players[0].piece.location = spaceAt(g.board, 10, 18);
    g.players[0].enteredRoomThisTurn = true;
    g.hasMovedThisTurn = true;
    const intent = decideRobotIntent(g, 0, () => 0.5);
    expect(intent.kind).toBe('suggest');
  });

  it('ends a one-player robot turn instead of suggesting', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0)]);
    g.turnIndex = 0;
    g.phase = 'playing';
    g.players[0]!.piece.location = spaceAt(g.board, 10, 18);
    g.players[0]!.enteredRoomThisTurn = true;
    g.hasMovedThisTurn = true;

    expect(decideRobotIntent(g, 0, () => 0.5)).toEqual({ kind: 'endTurn' });
  });

  it('ends the turn in a room without room-entry eligibility', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0)]);
    g.turnIndex = 0; g.phase = 'playing';
    g.players[0].piece.location = spaceAt(g.board, 10, 18);
    g.hasMovedThisTurn = true;

    expect(decideRobotIntent(g, 0, () => 0.5)).toEqual({ kind: 'endTurn' });
  });

  it('waits during the lobby even when it is the robot turn', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0)]);
    g.phase = 'lobby';
    g.turnIndex = 0;

    expect(decideRobotIntent(g, 0)).toEqual({ kind: 'wait' });
  });

  it('waits after the game has finished even when a reveal is pending', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0)]);
    g.phase = 'finished';
    g.turnIndex = 0;
    g.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 0,
    };

    expect(decideRobotIntent(g, 0)).toEqual({ kind: 'wait' });
  });

  it('suggests from a corner room after being moved by a suggestion', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0), mkRobot('Professor Plum', 1)]);
    g.turnIndex = 0;
    g.phase = 'playing';
    g.players[0]!.piece.location = spaceAt(g.board, 2, 1); // Conservatory
    g.players[0]!.movedBySuggestion = true;

    expect(decideRobotIntent(g, 0, () => 0.4).kind).toBe('suggest');
  });

  // NOTE: spec used `() => 0.5`; the implementation uses strict `< 0.5`,
  // matching clue.py:407 `random.choice([True, False])` (a 50%/50% split).
  // With `0.5 < 0.5 === false`, the passage branch would be skipped. To
  // exercise the passage branch deterministically, the RNG returns 0.4.
  it('takes secret passage probabilistically when in a corner room', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0)]);
    g.turnIndex = 0; g.phase = 'playing';
    g.players[0].piece.location = spaceAt(g.board, 2, 1);  // Conservatory
    const intent = decideRobotIntent(g, 0, () => 0.4);
    expect(intent.kind).toBe('useSecretPassage');
  });

  it('shows a matching card even after a failed accusation', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0), mkRobot('Professor Plum', 1)]);
    g.phase = 'playing';
    g.players[0]!.cards = [{ type: 'weapon', weapon: 'Rope' }];
    g.players[0]!.failedAccusation = true;
    g.pendingReveal = {
      suggesterIndex: 1,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 0,
    };

    const intent = decideRobotIntent(g, 0, () => 0);
    expect(intent).toEqual({ kind: 'showCard', card: { type: 'weapon', weapon: 'Rope' } });
    expect(applyIntent(g, 0, intent)).toEqual([
      { type: 'revealed', revealerIndex: 0, cardHint: 'private' },
    ]);
  });

  it('rejects malformed cards later in a robot hand while checking a reveal', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0), mkRobot('Professor Plum', 1)]);
    g.phase = 'playing';
    g.players[0]!.cards = [
      { type: 'weapon', weapon: 'Rope' },
      { type: 'room', room: 'Unknown Room' } as never,
    ];
    g.pendingReveal = {
      suggesterIndex: 1,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 0,
    };

    expect(() => decideRobotIntent(g, 0, () => 0)).toThrow('invalid card room: Unknown Room');
  });

  it('declines a pending reveal when it has no matching card', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0), mkRobot('Professor Plum', 1)]);
    g.phase = 'playing';
    g.players[0]!.cards = [{ type: 'weapon', weapon: 'Dagger' }];
    g.pendingReveal = {
      suggesterIndex: 1,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 0,
    };

    expect(decideRobotIntent(g, 0, () => 0)).toEqual({ kind: 'declineReveal' });
  });

  it('waits when another player is the pending revealer', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0), mkRobot('Professor Plum', 1)]);
    g.phase = 'finished';
    g.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };

    const intent = decideRobotIntent(g, 0);
    expect(intent).toEqual({ kind: 'wait' });
    expect(applyIntent(g, 0, intent)).toEqual([]);
  });

  it('waits when it is not the robot turn', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0), mkRobot('Professor Plum', 1)]);
    g.phase = 'lobby';
    g.turnIndex = 1;

    const intent = decideRobotIntent(g, 0);
    expect(intent).toEqual({ kind: 'wait' });
    expect(applyIntent(g, 0, intent)).toEqual([]);
  });

  it('resumes the robot turn after a human resolves its suggestion', () => {
    const g = createGame([
      mkRobot('Miss Scarlett', 0),
      { ...mkRobot('Professor Plum', 1), isRobot: false, cards: [{ type: 'weapon', weapon: 'Revolver' }] },
    ]);
    g.phase = 'playing';
    g.players[0]!.piece.location = spaceAt(g.board, 10, 18);
    g.players[0]!.enteredRoomThisTurn = true;
    g.hasMovedThisTurn = true;

    const suggestion = decideRobotIntent(g, 0, () => 0.5);
    expect(suggestion.kind).toBe('suggest');
    expect(applyIntent(g, 0, suggestion)).toHaveLength(2);

    expect(applyIntent(g, 1, { kind: 'showCard', card: { type: 'weapon', weapon: 'Revolver' } })).toEqual([
      { type: 'revealed', revealerIndex: 1, cardHint: 'private' },
    ]);
    expect(decideRobotIntent(g, 0, () => 0.5)).toEqual({ kind: 'endTurn' });
  });

  it('does not request a secret passage after dice movement enters a corner room', () => {
    const g = createGame([mkRobot('Miss Scarlett', 0), mkRobot('Professor Plum', 1)]);
    g.turnIndex = 0;
    g.phase = 'playing';
    g.lastDieRoll = 7;
    g.hasRolledThisTurn = true;
    expect(applyIntent(g, 0, { kind: 'moveTo', destination: 'Lounge' })).toEqual([
      { type: 'moved', playerIndex: 0, destination: 'Lounge' },
    ]);

    expect(decideRobotIntent(g, 0, () => 0.4)).toEqual({
      kind: 'suggest',
      suspect: 'Mrs. Peacock',
      weapon: 'Lead Pipe',
    });
  });
});
