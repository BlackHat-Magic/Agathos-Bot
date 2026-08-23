import { describe, it, expect } from 'bun:test';
import {
  createGame,
  begin,
  cardMatchesSuggestion,
  evaluateAccusation,
  requireAccusationSolution,
  resolveSuggestion,
} from '../src/rules';
import { buildBoard, suspectStart } from '../src/board';
import type { Card, Player, Solution, Suspect, Weapon, Room } from '../src/types';

function mkPlayer(suspect: Suspect, idx: number, cards: Card[] = [], isRobot = true): Player {
  return {
    name: suspect, index: idx, suspect,
    piece: { suspect, location: suspectStart(suspect, buildBoard()) },
    cards, failedAccusation: false, guessedHere: false, movedBySuggestion: false,
    enteredRoomThisTurn: false,
    isRobot,
  };
}

describe('begin', () => {
  it('selects one suspect/weapon/room as solution and deals all others', () => {
    const p1 = mkPlayer('Miss Scarlett', 0, [], false);
    const p2 = mkPlayer('Professor Plum', 1);
    const p3 = mkPlayer('Mrs. Peacock', 2);
    const game = createGame([p1, p2, p3]);
    begin(game, () => 0);  // deterministic random injection
    expect(game.solution).not.toBeNull();
    expect(game.solution!.suspect.type).toBe('suspect');
    const totalDealt = game.players.reduce((n, p) => n + p.cards.length, 0);
    // 6 + 6 + 9 = 21 cards; minus 3 in solution = 18 dealt
    expect(totalDealt).toBe(18);
  });

  it('exposes category-specific solution cards to consumers', () => {
    const game = createGame([mkPlayer('Miss Scarlett', 0, [], false)]);
    begin(game, () => 0);

    const solution: Solution = game.solution!;
    const readSolution = (value: Solution): [Suspect, Weapon, Room] => [
      value.suspect.suspect,
      value.weapon.weapon,
      value.room.room,
    ];

    expect(readSolution(solution)).toEqual(['Miss Scarlett', 'Candlestick', 'Ballroom']);
  });

  it('rejects beginning a game without players', () => {
    const game = createGame([]);

    expect(() => begin(game, () => 0)).toThrow('cannot begin a game without players');
  });

  it('rejects beginning a robot-only game', () => {
    const game = createGame([
      mkPlayer('Miss Scarlett', 0),
      mkPlayer('Professor Plum', 1),
    ]);

    expect(() => begin(game, () => 0)).toThrow('at least one human player is required');
  });

  it('rejects an unrecognized suspect before dealing', () => {
    const player = mkPlayer('Miss Scarlett', 0, [], false);
    (player as unknown as { suspect: string }).suspect = 'Unknown Suspect';
    const game = createGame([player]);

    expect(() => begin(game, () => 0)).toThrow('invalid suspect: Unknown Suspect');
  });

  it('rejects duplicate suspects before dealing', () => {
    const game = createGame([
      mkPlayer('Miss Scarlett', 0, [], false),
      mkPlayer('Miss Scarlett', 1),
    ]);

    expect(() => begin(game, () => 0)).toThrow('duplicate suspect: Miss Scarlett');
  });

  it('alternates deal across 3 players as evenly as possible', () => {
    const players = [
      mkPlayer('Miss Scarlett', 0, [], false),
      mkPlayer('Professor Plum', 1),
      mkPlayer('Mrs. Peacock', 2),
    ];
    const game = createGame(players);
    begin(game, () => 0);
    // 18 cards / 3 players = 6 each
    for (const p of players) expect(p.cards.length).toBe(6);
  });

  it('resets cards and game state when beginning a reused game', () => {
    const players = [
      mkPlayer('Miss Scarlett', 0, [], false),
      mkPlayer('Professor Plum', 1),
      mkPlayer('Mrs. Peacock', 2),
    ];
    const game = createGame(players);
    begin(game, () => 0);
    const firstSolution = game.solution;

    for (const player of players) {
      player.cards.push({ type: 'weapon', weapon: 'Rope' });
      player.failedAccusation = true;
      player.guessedHere = true;
      player.movedBySuggestion = true;
      player.enteredRoomThisTurn = true;
    }
    players[0]!.piece.location = game.board[10]![18]!;
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Miss Scarlett',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };
    game.lastDieRoll = 12;
    game.hasRolledThisTurn = true;
    game.hasMovedThisTurn = true;
    game.winnerIndex = 1;
    game.finishedAt = 123;
    game.phase = 'finished';
    game.turnIndex = 2;

    begin(game, () => 0.99);

    expect(game.solution).not.toEqual(firstSolution);
    expect(players[0]!.piece.location).toBe(suspectStart('Miss Scarlett', game.board));
    expect(players.reduce((total, player) => total + player.cards.length, 0)).toBe(18);
    for (const player of players) {
      expect(player.failedAccusation).toBe(false);
      expect(player.guessedHere).toBe(false);
      expect(player.movedBySuggestion).toBe(false);
      expect(player.enteredRoomThisTurn).toBe(false);
    }
    expect(game.pendingReveal).toBeNull();
    expect(game.lastDieRoll).toBeNull();
    expect(game.hasRolledThisTurn).toBe(false);
    expect(game.hasMovedThisTurn).toBe(false);
    expect(game.winnerIndex).toBeNull();
    expect(game.finishedAt).toBeNull();
    expect(game.phase as string).toBe('playing');
    expect(game.turnIndex).toBe(0);
  });
});

describe('resolveSuggestion', () => {
  it('returns the first matching card from the next player clockwise', () => {
    const cards: Card[] = [
      { type: 'suspect', suspect: 'Miss Scarlett' },
    ];
    const suggester = mkPlayer('Colonel Mustard', 0);
    const next = mkPlayer('Mrs. White', 1, cards);
    const after = mkPlayer('Mr. Green', 2, [{ type: 'weapon', weapon: 'Rope' }]);
    const g = createGame([suggester, next, after]);
    const result = resolveSuggestion(g, 0, {
      suspect: 'Miss Scarlett', weapon: 'Candlestick', room: 'Hall'
    });
    expect(result.revealerIndex).toBe(1);
    expect(result.card).toEqual(cards[0]);
    expect(result.card).not.toBe(cards[0]);
  });

  it('does not expose a mutable hand card through the result', () => {
    const handCard: Card = { type: 'weapon', weapon: 'Rope' };
    const g = createGame([
      mkPlayer('Colonel Mustard', 0),
      mkPlayer('Mrs. White', 1, [handCard]),
    ]);

    const result = resolveSuggestion(g, 0, {
      suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Hall',
    });
    (result.card as { weapon: Weapon }).weapon = 'Dagger';

    expect(handCard).toEqual({ type: 'weapon', weapon: 'Rope' });
  });

  it('returns null when nobody has any matching card', () => {
    const a = mkPlayer('Colonel Mustard', 0);
    const b = mkPlayer('Mrs. White', 1);
    const c = mkPlayer('Mr. Green', 2);
    const g = createGame([a, b, c]);
    const result = resolveSuggestion(g, 0, {
      suspect: 'Miss Scarlett', weapon: 'Candlestick', room: 'Hall'
    });
    expect(result.revealerIndex).toBeNull();
    expect(result.card).toBeNull();
  });

  it('rejects malformed runtime hand cards', () => {
    const malformed: unknown = { type: 'room', room: 'Unknown Room' };
    const game = createGame([
      mkPlayer('Colonel Mustard', 0),
      mkPlayer('Mrs. White', 1, [malformed as Card]),
    ]);

    expect(() => resolveSuggestion(game, 0, {
      suspect: 'Miss Scarlett', weapon: 'Candlestick', room: 'Hall',
    })).toThrow('invalid hand card room: Unknown Room');
  });

  it('rejects malformed runtime suggestion values by field', () => {
    const game = createGame([mkPlayer('Colonel Mustard', 0), mkPlayer('Mrs. White', 1)]);
    const malformed: unknown = {
      suspect: 'Unknown Suspect', weapon: 'Candlestick', room: 'Hall',
    };

    expect(() => resolveSuggestion(game, 0, malformed as {
      suspect: Suspect; weapon: Weapon; room: Room;
    })).toThrow('invalid suspect: Unknown Suspect');
  });

  it('rejects invalid suggester indexes before searching hands', () => {
    const game = createGame([mkPlayer('Colonel Mustard', 0), mkPlayer('Mrs. White', 1)]);
    const guess = { suspect: 'Miss Scarlett' as Suspect, weapon: 'Rope' as Weapon, room: 'Hall' as Room };

    expect(() => resolveSuggestion(game, -1, guess)).toThrow('invalid suggester index: -1');
    expect(() => resolveSuggestion(game, 0.5, guess)).toThrow('invalid suggester index: 0.5');
    expect(() => resolveSuggestion(game, 2, guess)).toThrow('invalid suggester index: 2');
  });
});

describe('cardMatchesSuggestion', () => {
  it('rejects malformed runtime guesses with a validation error', () => {
    const malformed: unknown = null;

    expect(() => cardMatchesSuggestion({ type: 'room', room: 'Hall' }, malformed))
      .toThrow('invalid suggestion: expected an object');
  });
});

describe('evaluateAccusation', () => {
  it('returns a detached solution that cannot mutate game state', () => {
    const game = createGame([mkPlayer('Miss Scarlett', 0)]);
    game.solution = {
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };

    const solution = requireAccusationSolution(game);
    solution.suspect.suspect = 'Colonel Mustard';
    solution.weapon.weapon = 'Dagger';

    expect(game.solution).toEqual({
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    });
  });

  it('wins when matches solution', () => {
    const players = [mkPlayer('Miss Scarlett', 0), mkPlayer('Professor Plum', 1)];
    const g = createGame(players);
    g.solution = {
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    g.phase = 'playing';
    g.turnIndex = 0;
    expect(evaluateAccusation(g, 0, { suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library' })).toBe(true);
  });

  it('rejects an accusation while a reveal is pending before mutating state', () => {
    const g = createGame([mkPlayer('Miss Scarlett', 0), mkPlayer('Professor Plum', 1)]);
    g.solution = {
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    g.phase = 'playing';
    g.turnIndex = 0;
    g.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Miss Scarlett',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };

    expect(() => evaluateAccusation(g, 0, {
      suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library',
    })).toThrow('a card reveal is pending');
    expect(g.phase).toBe('playing');
    expect(g.turnIndex).toBe(0);
    expect(g.players[0]!.failedAccusation).toBe(false);
    expect(g.winnerIndex).toBeNull();
    expect(g.finishedAt).toBeNull();
  });

  it('rejects an accusation when the solution is missing', () => {
    const g = createGame([mkPlayer('Miss Scarlett', 0)]);
    g.phase = 'playing';
    g.turnIndex = 0;

    expect(() => evaluateAccusation(g, 0, {
      suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library',
    })).toThrow('cannot evaluate accusation without a game solution');
  });

  it('rejects malformed runtime solution cards', () => {
    const g = createGame([mkPlayer('Miss Scarlett', 0)]);
    g.phase = 'playing';
    g.turnIndex = 0;
    const malformedSolutions: unknown[] = [
      {
        suspect: { type: 'weapon', suspect: 'Miss Scarlett' },
        weapon: { type: 'weapon', weapon: 'Rope' },
        room: { type: 'room', room: 'Library' },
      },
      {
        suspect: { type: 'suspect', suspect: 'Unknown Suspect' },
        weapon: { type: 'weapon', weapon: 'Rope' },
        room: { type: 'room', room: 'Library' },
      },
    ];

    for (const malformed of malformedSolutions) {
      g.solution = malformed as typeof g.solution;
      expect(() => evaluateAccusation(g, 0, {
        suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library',
      })).toThrow('invalid game solution');
    }
  });

  it('marks the player failedAccusation on loss', () => {
    const players = [mkPlayer('Miss Scarlett', 0), mkPlayer('Professor Plum', 1)];
    const g = createGame(players);
    g.solution = {
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    g.phase = 'playing';
    g.turnIndex = 0;
    expect(evaluateAccusation(g, 0, { suspect: 'Professor Plum', weapon: 'Rope', room: 'Library' })).toBe(false);
    expect(players[0].failedAccusation).toBe(true);
  });

  it('rejects malformed runtime accusation values before evaluating them', () => {
    const g = createGame([mkPlayer('Miss Scarlett', 0)]);
    g.solution = {
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    g.phase = 'playing';
    g.turnIndex = 0;
    const malformed: unknown = {
      suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Unknown Room',
    };

    expect(() => evaluateAccusation(g, 0, malformed as {
      suspect: Suspect; weapon: Weapon; room: Room;
    })).toThrow('invalid room: Unknown Room');
    expect(g.players[0]!.failedAccusation).toBe(false);
  });

  it('ends game when all humans have failed (regardless of robots)', () => {
    const human1 = mkPlayer('Miss Scarlett', 0, [], false);
    const human2 = mkPlayer('Professor Plum', 1, [], false);
    const robot = mkPlayer('Mrs. Peacock', 2, [], true);
    const g = createGame([human1, human2, robot]);
    g.solution = {
      suspect: { type: 'suspect', suspect: 'Mr. Green' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    g.phase = 'playing';
    g.turnIndex = 0;
    // Human 1 fails — game continues (human 2 still in)
    const r1 = evaluateAccusation(g, 0, { suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library' });
    expect(r1).toBe(false);
    expect(human1.failedAccusation).toBe(true);
    expect(g.phase as string).toBe('playing');
    expect(g.finishedAt).toBeNull();
    // Human 2 fails — all humans failed, game ends (robot state doesn't matter)
    g.turnIndex = 1;
    const r2 = evaluateAccusation(g, 1, { suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library' });
    expect(r2).toBe(false);
    expect(human2.failedAccusation).toBe(true);
    expect(g.phase as string).toBe('finished');
    expect(g.finishedAt).not.toBeNull();
  });

  it('rejects accusation calls outside the reducer action boundary before mutation', () => {
    const g = createGame([mkPlayer('Miss Scarlett', 0), mkPlayer('Professor Plum', 1)]);
    g.solution = {
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    const guess = { suspect: 'Professor Plum' as Suspect, weapon: 'Rope' as Weapon, room: 'Library' as Room };
    const invalidCalls: Array<[number, string]> = [
      [-1, 'invalid player index: -1'],
      [1.5, 'invalid player index: 1.5'],
      [2, 'invalid player index: 2'],
    ];

    for (const [playerIndex, message] of invalidCalls) {
      expect(() => evaluateAccusation(g, playerIndex, guess)).toThrow(message);
    }
    g.phase = 'lobby';
    expect(() => evaluateAccusation(g, 0, guess)).toThrow('game is not in the playing phase');
    g.phase = 'finished';
    expect(() => evaluateAccusation(g, 0, guess)).toThrow('game is not in the playing phase');
    g.phase = 'playing';
    g.turnIndex = 1;
    expect(() => evaluateAccusation(g, 0, guess)).toThrow("it is not player 0's turn");
    g.turnIndex = 0;
    g.players[0]!.failedAccusation = true;
    expect(() => evaluateAccusation(g, 0, guess)).toThrow(
      'players with failed accusations may only end their turn',
    );

    expect(g.phase).toBe('playing');
    expect(g.turnIndex).toBe(0);
    expect(g.players[0]!.failedAccusation).toBe(true);
    expect(g.players[1]!.failedAccusation).toBe(false);
  });
});
