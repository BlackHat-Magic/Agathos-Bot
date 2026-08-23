import { describe, expect, it } from 'bun:test';
import { buildBoard, spaceAt, suspectStart } from '../src/board';
import { reachable } from '../src/pathfind';
import { createGame } from '../src/rules';
import { toView } from '../src/view';
import type { Card, Game, Player, Suspect } from '../src/types';

function player(
  suspect: Suspect,
  index: number,
  cards: Card[] = [],
  userId?: string,
): Player {
  const board = buildBoard();
  return {
    name: suspect,
    index,
    suspect,
    piece: { suspect, location: suspectStart(suspect, board) },
    cards,
    failedAccusation: false,
    guessedHere: false,
    movedBySuggestion: false,
    enteredRoomThisTurn: false,
    isRobot: false,
    ...(userId === undefined ? {} : { userId }),
  };
}

function playingGame(players: Player[]): Game {
  const game = createGame(players);
  game.phase = 'playing';
  game.weapons = [{ weapon: 'Rope', location: spaceAt(game.board, 16, 24) }];
  return game;
}

const solution = {
  suspect: { type: 'suspect' as const, suspect: 'Mrs. Peacock' as const },
  weapon: { type: 'weapon' as const, weapon: 'Dagger' as const },
  room: { type: 'room' as const, room: 'Library' as const },
};

describe('toView', () => {
  it('hides other hands while exposing the viewer hand', () => {
    const game = playingGame([
      player('Miss Scarlett', 0, [{ type: 'suspect', suspect: 'Professor Plum' }], 'user-0'),
      player('Professor Plum', 1, [{ type: 'weapon', weapon: 'Lead Pipe' }], 'user-1'),
    ]);
    game.players[0]!.guessedHere = true;

    const view = toView(game, 0);

    expect(view.myHand).toEqual([{ type: 'suspect', suspect: 'Professor Plum' }]);
     expect(view.players[0]).toMatchObject({ handCount: 1, guessedHere: true });
     expect(view.players[1]).toMatchObject({ handCount: 1 });
     expect(view.players[0]).not.toHaveProperty('userId');
     expect(view.players[1]).not.toHaveProperty('userId');
    expect('cards' in view.players[0]!).toBe(false);
    expect('cards' in view.players[1]!).toBe(false);
    expect(JSON.stringify(view)).not.toContain('Lead Pipe');
  });

  it('gives player 1 their hand while omitting player 0 cards', () => {
    const game = playingGame([
      player('Miss Scarlett', 0, [{ type: 'room', room: 'Library' }], 'user-0'),
      player('Professor Plum', 1, [{ type: 'weapon', weapon: 'Lead Pipe' }], 'user-1'),
    ]);

    const view = toView(game, 1);

    expect(view.myIndex).toBe(1);
    expect(view.myHand).toEqual([{ type: 'weapon', weapon: 'Lead Pipe' }]);
     expect(view.players[0]).toMatchObject({ handCount: 1 });
     expect(view.players[0]).not.toHaveProperty('userId');
    expect('cards' in view.players[0]!).toBe(false);
    expect(JSON.stringify(view)).not.toContain('"room":"Library"');
  });

  it('exposes matching reveal opportunities only to the current revealer', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1, [
        { type: 'suspect', suspect: 'Miss Scarlett' },
        { type: 'weapon', weapon: 'Dagger' },
        { type: 'room', room: 'Hall' },
      ]),
    ]);
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Miss Scarlett',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };

    expect(toView(game, 0).myRevealOpportunities).toBeUndefined();
    expect(toView(game, 1).myRevealOpportunities).toEqual([
      { type: 'suspect', suspect: 'Miss Scarlett' },
      { type: 'room', room: 'Hall' },
    ]);
  });

  it('hides the solution during play and reveals it after finishing', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    game.solution = solution;

    expect(toView(game, 0).solution).toBeUndefined();

    game.phase = 'finished';
    expect(toView(game, 0).solution).toEqual(solution);
  });

  it('projects the winner index in every phase, including an all-human loss', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    game.winnerIndex = 1;

    expect(toView(game, 0).winnerIndex).toBe(1);

    game.phase = 'finished';
    game.solution = solution;
    game.winnerIndex = null;
    expect(toView(game, 0).winnerIndex).toBeNull();
  });

  it('rejects a finished game without a solution', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.phase = 'finished';

    expect(() => toView(game, 0)).toThrow(
      'cannot project finished game without a valid game solution',
    );
  });

  it('serializes without the cyclic board graph', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    const serialized = JSON.stringify(toView(game, 0));

    expect(serialized).not.toContain('accesses');
    expect(serialized).not.toContain('"board":');
    expect(serialized).toContain('16,24');
  });

  it('projects canonical reachable destinations only for an eligible current player', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    const start = spaceAt(game.board, 16, 24);
    game.players[0]!.piece.location = start;
    game.lastDieRoll = 7;
    game.hasRolledThisTurn = true;

    const view = toView(game, 0);
    expect(view.reachableSpacesHints).toEqual(
      reachable(start, 7).spaces.map(space => space.room ?? `${space.pos![0]},${space.pos![1]}`),
    );
    expect(view.reachableSpacesHints).toContain('Lounge');
    expect(toView(game, 1).reachableSpacesHints).toBeUndefined();
  });

  it('omits movement hints when reducer movement preconditions are not met', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    game.players[0]!.piece.location = spaceAt(game.board, 16, 24);
    game.lastDieRoll = 7;
    game.hasRolledThisTurn = true;
    game.solution = solution;

    const cases: Array<Partial<Game>> = [
      { turnIndex: 1 },
      { phase: 'finished' },
      { hasRolledThisTurn: false },
      { lastDieRoll: null },
      { hasMovedThisTurn: true },
      { pendingReveal: {
        suggesterIndex: 1, suspect: 'Professor Plum', weapon: 'Rope', room: 'Hall', revealerIndex: 0,
      } },
    ];
    for (const state of cases) {
      const original = {
        phase: game.phase,
        turnIndex: game.turnIndex,
        hasMovedThisTurn: game.hasMovedThisTurn,
        pendingReveal: game.pendingReveal,
      };
      Object.assign(game, state);
      expect(toView(game, 0).reachableSpacesHints).toBeUndefined();
      Object.assign(game, original);
    }

    game.players[0]!.failedAccusation = true;
    expect(toView(game, 0).reachableSpacesHints).toBeUndefined();
    game.players[0]!.failedAccusation = false;
    game.players[0]!.guessedHere = true;
    expect(toView(game, 0).reachableSpacesHints).toBeUndefined();
  });

  it('rejects an invalid viewer index', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);

    expect(() => toView(game, -1)).toThrow('invalid viewer index: -1');
    expect(() => toView(game, 1)).toThrow('invalid viewer index: 1');
    expect(() => toView(game, 0.5)).toThrow('invalid viewer index: 0.5');
  });

  it('detaches pending reveal metadata', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Miss Scarlett',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };

    const view = toView(game, 0);
    view.pendingReveal!.revealerIndex = 0;

    expect(game.pendingReveal!.revealerIndex).toBe(1);
  });

  it('rejects extra pending reveal metadata instead of projecting it', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    const pendingReveal: unknown = {
      suggesterIndex: 0,
      suspect: 'Miss Scarlett',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
      secret: 'runtime metadata',
    };
    game.pendingReveal = pendingReveal as Game['pendingReveal'];

    expect(() => toView(game, 0)).toThrow('invalid pending reveal metadata key: secret');
  });

  it('rejects malformed pending reveal metadata before projection', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    const base = {
      suggesterIndex: 0,
      suspect: 'Miss Scarlett' as const,
      weapon: 'Rope' as const,
      room: 'Hall' as const,
      revealerIndex: 1,
    };
    const cases: Array<[unknown, string]> = [
      [{ ...base, suggesterIndex: 2 }, 'invalid pending reveal suggester index: 2'],
      [{ ...base, revealerIndex: 0.5 }, 'invalid pending reveal revealer index: 0.5'],
      [{ ...base, revealerIndex: 0 }, 'invalid pending reveal: suggester and revealer must be distinct'],
      [{ ...base, suspect: 'Unknown Suspect' }, 'invalid pending reveal suspect: Unknown Suspect'],
      [{ ...base, weapon: 'Unknown Weapon' }, 'invalid pending reveal weapon: Unknown Weapon'],
      [{ ...base, room: 'Unknown Room' }, 'invalid pending reveal room: Unknown Room'],
    ];

    for (const [pendingReveal, message] of cases) {
      game.pendingReveal = pendingReveal as Game['pendingReveal'];
      expect(() => toView(game, 0)).toThrow(message);
    }
  });

  it('rejects pending reveal metadata whose fields are inherited', () => {
    const inherited: unknown = Object.create({
      suggesterIndex: 0,
      suspect: 'Miss Scarlett',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    });
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    game.pendingReveal = inherited as Game['pendingReveal'];

    expect(() => toView(game, 0)).toThrow(
      'invalid pending reveal metadata: expected a plain object',
    );
  });

  it('rejects invalid winner indexes before projection', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);

    for (const winnerIndex of [-1, 2, 0.5, undefined]) {
      game.winnerIndex = winnerIndex as Game['winnerIndex'];
      expect(() => toView(game, 0)).toThrow(`invalid winner index: ${String(winnerIndex)}`);
    }
  });

  it('detaches the viewer hand and does not expose other card data', () => {
    const ownCard: Card = { type: 'room', room: 'Library' };
    const otherCard: Card = { type: 'weapon', weapon: 'Lead Pipe' };
    const game = playingGame([
      player('Miss Scarlett', 0, [ownCard]),
      player('Professor Plum', 1, [otherCard]),
    ]);

    const view = toView(game, 0);
    view.myHand[0] = { type: 'room', room: 'Kitchen' };

    expect(game.players[0]!.cards).toEqual([ownCard]);
    expect(JSON.stringify(view)).not.toContain('Lead Pipe');
    expect(JSON.stringify(view)).not.toContain('cards');
  });

  it('canonicalizes runtime card metadata in hands, reveal opportunities, and solutions', () => {
    const taintedHand: unknown = {
      type: 'room', room: 'Library', secret: 'hand-only metadata',
    };
    const taintedReveal: unknown = {
      type: 'weapon', weapon: 'Rope', secret: 'reveal-only metadata',
    };
    const taintedSolution: unknown = {
      suspect: { type: 'suspect', suspect: 'Mrs. Peacock', secret: 'solution metadata' },
      weapon: { type: 'weapon', weapon: 'Dagger' },
      room: { type: 'room', room: 'Library' },
    };
    const game = playingGame([
      player('Miss Scarlett', 0, [taintedHand as Card]),
      player('Professor Plum', 1, [taintedReveal as Card]),
    ]);
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Miss Scarlett',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };
    game.solution = taintedSolution as Game['solution'];
    game.phase = 'finished';

    const view = toView(game, 0);

    expect(view.myHand).toEqual([{ type: 'room', room: 'Library' }]);
    expect(toView(game, 1).myRevealOpportunities).toEqual([
      { type: 'weapon', weapon: 'Rope' },
    ]);
    expect(view.solution).toEqual(solution);
    expect(JSON.stringify(view)).not.toContain('metadata');
  });

  it('rejects corrupt projected card values clearly', () => {
    const malformed: unknown = { type: 'room', room: 'Unknown Room' };
    const game = playingGame([
      player('Miss Scarlett', 0, [malformed as Card]),
    ]);

    expect(() => toView(game, 0)).toThrow('invalid card room: Unknown Room');
  });

  it('rejects a finished solution whose slots contain the wrong card categories', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    const malformed: unknown = {
      suspect: { type: 'weapon', weapon: 'Rope' },
      weapon: { type: 'weapon', weapon: 'Dagger' },
      room: { type: 'room', room: 'Library' },
    };
    game.solution = malformed as Game['solution'];
    game.phase = 'finished';

    expect(() => toView(game, 0)).toThrow('invalid game solution');
  });

  it('reveals the finished solution only in the finished phase', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.solution = solution;

    const playingView = toView(game, 0);
    game.phase = 'finished';
    const finishedView = toView(game, 0);

    expect(playingView.solution).toBeUndefined();
    expect(finishedView.solution).toEqual(solution);
    expect(finishedView.solution).not.toBe(game.solution);
  });

  it('detaches the finished solution from game state', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.solution = solution;
    game.phase = 'finished';

    const view = toView(game, 0);
    view.solution!.suspect = { type: 'suspect', suspect: 'Colonel Mustard' };

    expect(game.solution).toEqual(solution);
  });
});
