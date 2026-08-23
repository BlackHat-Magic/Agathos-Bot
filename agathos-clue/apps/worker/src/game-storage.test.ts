import { describe, expect, it } from 'vitest';
import {
  buildBoard,
  createGame,
  spaceAt,
} from '@agathos/game';
import type { Player } from '@agathos/game';
import { hydrateGame, serializeGame } from './game-storage';

function player(suspect: Player['suspect'], index: number): Player {
  const board = buildBoard();
  return {
    name: suspect,
    index,
    suspect,
    piece: { suspect, location: spaceAt(board, 16, 24) },
    cards: [],
    failedAccusation: false,
    guessedHere: false,
    movedBySuggestion: false,
    enteredRoomThisTurn: false,
    isRobot: false,
    userId: `user-${index}`,
  };
}

describe('game persistence codec', () => {
  it('serializes a game without its cyclic board graph', () => {
    const game = createGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    game.players[0]!.piece.location = spaceAt(game.board, 10, 18);
    game.players[0]!.cards = [{ type: 'room', room: 'Hall' }];
    game.solution = {
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    game.phase = 'playing';
    game.weapons = [{ weapon: 'Rope', location: spaceAt(game.board, 7, 5) }];
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };

    const persisted = serializeGame(game);

    expect(() => JSON.stringify(persisted)).not.toThrow();
    expect(persisted).not.toHaveProperty('board');
    expect(persisted.players[0]!.location).toBe('Hall');
    expect(persisted.weapons[0]!.location).toBe('7,5');
  });

  it('hydrates every location against the restored canonical board', () => {
    const game = createGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    game.players[0]!.piece.location = spaceAt(game.board, 10, 18);
    game.players[1]!.piece.location = spaceAt(game.board, 7, 5);
    game.weapons = [{ weapon: 'Rope', location: spaceAt(game.board, 10, 18) }];

    const restored = hydrateGame(serializeGame(game));
    const boardSpaces = restored.board.flat();

    expect(restored.players[0]!.piece.location).toBe(
      boardSpaces.find(space => space?.room === 'Hall'),
    );
    expect(restored.players[1]!.piece.location).toBe(spaceAt(restored.board, 7, 5));
    expect(restored.weapons[0]!.location).toBe(
      boardSpaces.find(space => space?.room === 'Hall'),
    );
    expect(restored.players[0]!.piece.location === game.players[0]!.piece.location).toBe(false);
    expect(restored.solution).toEqual(game.solution);
    expect(restored.pendingReveal).toEqual(game.pendingReveal);
  });

  it('rejects invalid top-level state before hydrating it', () => {
    const persisted = serializeGame(createGame([player('Miss Scarlett', 0)]));

    expect(() => hydrateGame(null)).toThrow('invalid persisted game: expected an object');
    expect(() => hydrateGame({ ...persisted, version: 2 })).toThrow(
      'invalid persisted game version: 2',
    );
    expect(() => hydrateGame({ ...persisted, phase: 'unknown' })).toThrow(
      'invalid persisted phase: unknown',
    );
    expect(() => hydrateGame({ ...persisted, extra: true })).toThrow(
      'unexpected or missing fields',
    );
  });

  it('rejects malformed players, cards, and locations', () => {
    const persisted = serializeGame(createGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]));

    expect(() => hydrateGame({
      ...persisted,
      players: [{ ...persisted.players[0]!, index: 1 }, persisted.players[1]],
    })).toThrow('invalid persisted player index at index 0: 1');
    expect(() => hydrateGame({
      ...persisted,
      players: [persisted.players[0], { ...persisted.players[1]!, suspect: 'Miss Scarlett' }],
    })).toThrow('duplicate persisted player suspect: Miss Scarlett');
    expect(() => hydrateGame({
      ...persisted,
      players: [{ ...persisted.players[0]!, failedAccusation: 'false' }, persisted.players[1]],
    })).toThrow('invalid persisted player 0 failedAccusation');
    expect(() => hydrateGame({
      ...persisted,
      players: [{ ...persisted.players[0]!, cards: [{ type: 'weapon', weapon: 'Not a weapon' }] }, persisted.players[1]],
    })).toThrow('invalid persisted player 0 card 0 weapon: Not a weapon');
    expect(() => hydrateGame({
      ...persisted,
      players: [{
        ...persisted.players[0]!,
        cards: [{ type: 'weapon', weapon: 'Rope', extra: true }],
      }, persisted.players[1]],
    })).toThrow('invalid persisted player 0 card 0: unexpected or missing fields');
    expect(() => hydrateGame({
      ...persisted,
      players: [{ ...persisted.players[0]!, location: '99,99' }, persisted.players[1]],
    })).toThrow('invalid persisted location: 99,99');
  });

  it('rejects invalid turn state, pending reveals, and weapons', () => {
    const persisted = serializeGame(createGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]));

    expect(() => hydrateGame({ ...persisted, turnIndex: 2 })).toThrow(
      'invalid persisted turn index: 2',
    );
    expect(() => hydrateGame({ ...persisted, lastDieRoll: 13 })).toThrow(
      'invalid persisted die roll: 13',
    );
    expect(() => hydrateGame({
      ...persisted,
      weapons: [{ weapon: 'Rope', location: '99,99' }],
    })).toThrow('invalid persisted location: 99,99');
    expect(() => hydrateGame({
      ...persisted,
      weapons: [
        { weapon: 'Rope', location: 'Hall' },
        { weapon: 'Rope', location: 'Kitchen' },
      ],
    })).toThrow('duplicate persisted weapon: Rope');

    const playing = {
      ...persisted,
      phase: 'playing' as const,
      solution: {
        suspect: { type: 'suspect' as const, suspect: 'Miss Scarlett' as const },
        weapon: { type: 'weapon' as const, weapon: 'Rope' as const },
        room: { type: 'room' as const, room: 'Hall' as const },
      },
      pendingReveal: {
        suggesterIndex: 0,
        suspect: 'Professor Plum' as const,
        weapon: 'Rope' as const,
        room: 'Hall' as const,
        revealerIndex: 0,
      },
    };
    expect(() => hydrateGame({
      ...playing,
      solution: {
        ...playing.solution!,
        room: { ...playing.solution!.room, extra: true },
      },
    })).toThrow('invalid persisted solution room: unexpected or missing fields');
    expect(() => hydrateGame(playing)).toThrow(
      'invalid pending reveal: suggester and revealer must be distinct',
    );
  });
});
