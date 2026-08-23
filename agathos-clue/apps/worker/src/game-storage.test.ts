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
    expect(restored.players[0]!.piece.location).not.toBe(game.players[0]!.piece.location);
    expect(restored.solution).toEqual(game.solution);
    expect(restored.pendingReveal).toEqual(game.pendingReveal);
  });
});
