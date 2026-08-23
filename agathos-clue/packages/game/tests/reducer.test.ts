import { describe, expect, it } from 'bun:test';
import { buildBoard, spaceAt, suspectStart } from '../src/board';
import { applyIntent } from '../src/reducer';
import { createGame } from '../src/rules';
import type { Card, Player, Suspect } from '../src/types';

function player(suspect: Suspect, index: number, cards: Card[] = [], isRobot = false): Player {
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
    isRobot,
  };
}

function playingGame(players: Player[]): ReturnType<typeof createGame> {
  const game = createGame(players);
  game.phase = 'playing';
  return game;
}

describe('applyIntent', () => {
  it('rolls two dice, stores the positive result, and emits an event', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    const events = applyIntent(game, 0, { kind: 'roll' }, () => 0.5);

    expect(game.lastDieRoll).toBe(8);
    expect(events).toEqual([{ type: 'rolled', playerIndex: 0, result: 8 }]);
  });

  it('rejects gameplay intents from the wrong player turn', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    game.turnIndex = 1;

    expect(() => applyIntent(game, 0, { kind: 'roll' })).toThrow("it is not player 0's turn");
  });

  it('rejects gameplay intents after the game has finished', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.phase = 'finished';

    expect(() => applyIntent(game, 0, { kind: 'roll' })).toThrow('game is not in the playing phase');
  });

  it('rejects gameplay intents while a reveal is pending', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]);
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };

    expect(() => applyIntent(game, 0, { kind: 'endTurn' })).toThrow('a card reveal is pending');
  });

  it('moves to a reachable cell and emits an event', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    const start = spaceAt(game.board, 16, 24);
    game.players[0]!.piece.location = start;
    game.lastDieRoll = 7;

    const events = applyIntent(game, 0, { kind: 'moveTo', destination: '17,18' });

    expect(game.players[0]!.piece.location).toBe(spaceAt(game.board, 17, 18));
    expect(game.lastDieRoll).toBeNull();
    expect(events).toEqual([{ type: 'moved', playerIndex: 0, destination: '17,18' }]);
  });

  it('resolves a room destination by room name', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.players[0]!.piece.location = spaceAt(game.board, 16, 24);
    game.lastDieRoll = 7;

    applyIntent(game, 0, { kind: 'moveTo', destination: 'Lounge' });

    expect(game.players[0]!.piece.location.room).toBe('Lounge');
  });

  it('rejects malformed coordinates and illegal moves without mutating position', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    const start = game.players[0]!.piece.location;
    game.lastDieRoll = 1;

    expect(() => applyIntent(game, 0, { kind: 'moveTo', destination: 'abc,def' })).toThrow();
    expect(() => applyIntent(game, 0, { kind: 'moveTo', destination: '7,5' })).toThrow();
    expect(game.players[0]!.piece.location).toBe(start);
  });

  it('suggests, moves the named suspect, and creates a pending reveal', () => {
    const players = [player('Miss Scarlett', 0), player('Professor Plum', 1), player('Mrs. Peacock', 2)];
    const game = playingGame(players);
    game.players[0]!.piece.location = spaceAt(game.board, 10, 18);
    const rope = { weapon: 'Rope' as const, location: spaceAt(game.board, 16, 24) };
    game.weapons.push(rope);

    const events = applyIntent(game, 0, { kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope' });

    expect(game.players[1]!.piece.location).toBe(game.players[0]!.piece.location);
    expect(rope.location).toBe(game.players[0]!.piece.location);
    expect(game.players[1]!.movedBySuggestion).toBe(true);
    expect(game.players[0]!.guessedHere).toBe(true);
    expect(game.pendingReveal).toMatchObject({
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    });
    expect(events).toEqual([
      { type: 'suggested', playerIndex: 0, suspect: 'Professor Plum', weapon: 'Rope', room: 'Hall' },
      { type: 'revealRequested', revealerIndex: 1 },
    ]);
  });

  it('accepts only a matching card owned by the pending revealer', () => {
    const cards: Card[] = [
      { type: 'suspect', suspect: 'Professor Plum' },
      { type: 'weapon', weapon: 'Dagger' },
    ];
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1, cards),
      player('Mrs. Peacock', 2),
    ]);
    game.players[0]!.piece.location = spaceAt(game.board, 10, 18);
    applyIntent(game, 0, { kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope' });

    expect(() => applyIntent(game, 1, { kind: 'showCard', card: { type: 'weapon', weapon: 'Rope' } })).toThrow();
    expect(() => applyIntent(game, 1, { kind: 'showCard', card: { type: 'weapon', weapon: 'Dagger' } })).toThrow();
    expect(() => applyIntent(game, 2, { kind: 'showCard', card: cards[0]! })).toThrow();

    const events = applyIntent(game, 1, { kind: 'showCard', card: { type: 'suspect', suspect: 'Professor Plum' } });
    expect(events).toEqual([{ type: 'revealed', revealerIndex: 1, cardHint: 'private' }]);
    expect(game.pendingReveal).toBeNull();
  });

  it('declines around the table and clears after cycling to the suggester', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
      player('Mrs. Peacock', 2),
    ]);
    game.players[0]!.piece.location = spaceAt(game.board, 10, 18);
    applyIntent(game, 0, { kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope' });

    expect(() => applyIntent(game, 2, { kind: 'declineReveal' })).toThrow('player is not the current revealer');
    expect(applyIntent(game, 1, { kind: 'declineReveal' })).toEqual([
      { type: 'declinedReveal', revealerIndex: 1 },
      { type: 'revealRequested', revealerIndex: 2 },
    ]);
    expect(applyIntent(game, 2, { kind: 'declineReveal' })).toEqual([
      { type: 'declinedReveal', revealerIndex: 2 },
    ]);
    expect(game.pendingReveal).toBeNull();
  });

  it('uses secret passages between opposite corner rooms only', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.players[0]!.piece.location = game.board[2]![1]!;
    expect(applyIntent(game, 0, { kind: 'useSecretPassage' })).toEqual([
      { type: 'usedSecretPassage', playerIndex: 0, to: 'Lounge' },
    ]);
    expect(game.players[0]!.piece.location.room).toBe('Lounge');

    game.players[0]!.piece.location = spaceAt(game.board, 7, 5);
    expect(() => applyIntent(game, 0, { kind: 'useSecretPassage' })).toThrow();
  });

  it('rejects a secret passage after the player has rolled', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.players[0]!.piece.location = game.board[2]![1]!;
    game.lastDieRoll = 6;

    expect(() => applyIntent(game, 0, { kind: 'useSecretPassage' })).toThrow(
      'secret passages can only be used before rolling',
    );
    expect(game.lastDieRoll).toBe(6);
  });

  it('marks wrong accusations failed, finishes when all humans fail, and emits gameWon on success', () => {
    const players = [player('Miss Scarlett', 0), player('Professor Plum', 1)];
    const game = playingGame(players);
    game.solution = {
      suspect: { type: 'suspect', suspect: 'Mrs. Peacock' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };

    expect(applyIntent(game, 0, { kind: 'accuse', suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library' })).toEqual([
      { type: 'accused', playerIndex: 0, correct: false },
    ]);
    expect(players[0]!.failedAccusation).toBe(true);
    expect(game.phase).toBe('playing');

    game.turnIndex = 1;
    expect(applyIntent(game, 1, { kind: 'accuse', suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library' })).toEqual([
      { type: 'accused', playerIndex: 1, correct: false },
    ]);
    expect(game.phase).toBe('finished');

    const winner = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    winner.solution = {
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    expect(applyIntent(winner, 0, { kind: 'accuse', suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library' })).toEqual([
      { type: 'accused', playerIndex: 0, correct: true },
      { type: 'gameWon', playerIndex: 0 },
    ]);
    expect(winner.winnerIndex).toBe(0);
  });

  it('ends a turn, resets per-turn flags, and advances past failed players', () => {
    const players = [player('Miss Scarlett', 0), player('Professor Plum', 1), player('Mrs. Peacock', 2)];
    const game = playingGame(players);
    game.players[0]!.guessedHere = true;
    game.players[0]!.movedBySuggestion = true;
    game.lastDieRoll = 8;
    game.players[1]!.failedAccusation = true;

    const events = applyIntent(game, 0, { kind: 'endTurn' });

    expect(events).toEqual([{ type: 'turnEnded', playerIndex: 0 }]);
    expect(game.lastDieRoll).toBeNull();
    expect(game.players[0]!.guessedHere).toBe(false);
    expect(game.players[0]!.movedBySuggestion).toBe(false);
    expect(game.turnIndex).toBe(2);
  });

  it('wraps from the final player to the first active player', () => {
    const players = [player('Miss Scarlett', 0), player('Professor Plum', 1), player('Mrs. Peacock', 2)];
    const game = playingGame(players);
    game.turnIndex = 2;
    game.players[1]!.failedAccusation = true;

    applyIntent(game, 2, { kind: 'endTurn' });

    expect(game.turnIndex).toBe(0);
  });
});
