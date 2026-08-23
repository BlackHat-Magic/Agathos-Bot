import { describe, expect, it } from 'bun:test';
import { buildBoard, spaceAt, suspectStart } from '../src/board';
import { applyIntent } from '../src/reducer';
import { decideRobotIntent } from '../src/robot';
import { begin, createGame } from '../src/rules';
import type { Card, Game, Intent, Player, Suspect } from '../src/types';

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
    enteredRoomThisTurn: false,
    isRobot,
  };
}

function playingGame(players: Player[]): ReturnType<typeof createGame> {
  const game = createGame(players);
  game.phase = 'playing';
  return game;
}

function putInHall(game: ReturnType<typeof createGame>, playerIndex = 0): void {
  game.players[playerIndex]!.piece.location = spaceAt(game.board, 10, 18);
  game.players[playerIndex]!.enteredRoomThisTurn = true;
}

describe('applyIntent', () => {
  it('treats the internal wait intent as an unconditional no-op', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    game.phase = 'finished';
    game.turnIndex = 1;
    game.pendingReveal = {
      suggesterIndex: 1,
      suspect: 'Miss Scarlett',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 0,
    };

    expect(applyIntent(game, 0, { kind: 'wait' })).toEqual([]);
    expect(game.pendingReveal).not.toBeNull();
  });

  it('rejects unknown runtime intent kinds instead of returning no events', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    const bogus: unknown = { kind: 'bogus' };

    expect(() => applyIntent(game, 0, bogus as Intent)).toThrow('unknown intent kind: bogus');
  });

  it('delegates lifecycle intents before player lookup in the lobby and rejects them during play', () => {
    const lifecycleIntents: Intent[] = [
      { kind: 'join', userId: 'user', name: 'Player' },
      { kind: 'claimSuspect', suspect: 'Miss Scarlett' },
      { kind: 'start' },
      { kind: 'setOrder', order: ['Miss Scarlett'] },
      { kind: 'leave' },
    ];

    const lobby = createGame([]);
    for (const intent of lifecycleIntents) {
      expect(applyIntent(lobby, -1, intent)).toEqual([]);
    }

    const game = playingGame([player('Miss Scarlett', 0)]);
    for (const intent of lifecycleIntents) {
      expect(() => applyIntent(game, -1, intent)).toThrow(
        `${intent.kind} intent is only valid in the lobby`,
      );
    }
  });

  it('rolls two dice, stores the positive result, and emits an event', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    const events = applyIntent(game, 0, { kind: 'roll' }, () => 0.5);

    expect(game.lastDieRoll).toBe(8);
    expect(game.hasRolledThisTurn).toBe(true);
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

  it('allows failed accusers to end their turn but rejects other gameplay intents', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]);
    game.players[0]!.failedAccusation = true;
    game.solution = {
      suspect: { type: 'suspect', suspect: 'Mrs. Peacock' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };

    const forbiddenIntents = [
      { kind: 'roll' as const },
      { kind: 'moveTo' as const, destination: '17,18' as const },
      { kind: 'useSecretPassage' as const },
      { kind: 'suggest' as const, suspect: 'Professor Plum' as const, weapon: 'Rope' as const },
      { kind: 'accuse' as const, suspect: 'Miss Scarlett' as const, weapon: 'Rope' as const, room: 'Library' as const },
    ];

    for (const intent of forbiddenIntents) {
      expect(() => applyIntent(game, 0, intent)).toThrow(
        'players with failed accusations may only end their turn',
      );
    }

    expect(applyIntent(game, 0, { kind: 'endTurn' })).toEqual([
      { type: 'turnEnded', playerIndex: 0 },
    ]);
    expect(game.turnIndex).toBe(1);
  });

  it('still lets a failed accuser reveal a matching card when required', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1, [{ type: 'suspect', suspect: 'Miss Scarlett' }]),
    ]);
    game.players[1]!.failedAccusation = true;
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Miss Scarlett',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };

    expect(applyIntent(game, 1, {
      kind: 'showCard',
      card: { type: 'suspect', suspect: 'Miss Scarlett' },
    })).toEqual([{ type: 'revealed', revealerIndex: 1, cardHint: 'private' }]);
    expect(game.pendingReveal).toBeNull();
  });

  it('rejects a second roll until the current roll is moved or ended', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    applyIntent(game, 0, { kind: 'roll' }, () => 0.5);

    expect(() => applyIntent(game, 0, { kind: 'roll' }, () => 0)).toThrow(
      'player must move or end their turn before rolling again',
    );
    expect(game.lastDieRoll).toBe(8);
  });

  it('rejects a second roll after moving', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.players[0]!.piece.location = spaceAt(game.board, 16, 24);
    applyIntent(game, 0, { kind: 'roll' }, () => 0.5);
    applyIntent(game, 0, { kind: 'moveTo', destination: '17,18' });

    expect(game.lastDieRoll).toBeNull();
    expect(game.hasRolledThisTurn).toBe(true);
    expect(game.hasMovedThisTurn).toBe(true);
    expect(() => applyIntent(game, 0, { kind: 'roll' }, () => 0)).toThrow(
      'player must move or end their turn before rolling again',
    );
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
    game.hasRolledThisTurn = true;

    const events = applyIntent(game, 0, { kind: 'moveTo', destination: '17,18' });

    expect(game.players[0]!.piece.location).toBe(spaceAt(game.board, 17, 18));
    expect(game.lastDieRoll).toBeNull();
    expect(events).toEqual([{ type: 'moved', playerIndex: 0, destination: '17,18' }]);
  });

  it('resolves a room destination by room name', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.players[0]!.piece.location = spaceAt(game.board, 16, 24);
    game.lastDieRoll = 7;
    game.hasRolledThisTurn = true;

    applyIntent(game, 0, { kind: 'moveTo', destination: 'Lounge' });

    expect(game.players[0]!.piece.location.room).toBe('Lounge');
    expect(game.players[0]!.enteredRoomThisTurn).toBe(true);
    expect(game.hasMovedThisTurn).toBe(true);
  });

  it('normalizes a separately built starting board before beginning and moving', () => {
    const p = player('Miss Scarlett', 17);
    const sourceLocation = p.piece.location;
    const game = createGame([p]);

    expect(sourceLocation).not.toBe(game.players[0]!.piece.location);
    expect(game.players[0]!.piece.location).toBe(spaceAt(game.board, 16, 24));

    begin(game, () => 0);
    applyIntent(game, 0, { kind: 'roll' }, () => 0.5);
    applyIntent(game, 0, { kind: 'moveTo', destination: '17,18' });

    expect(game.players[0]!.piece.location).toBe(spaceAt(game.board, 17, 18));
  });

  it('normalizes player indexes and uses array offsets for turns and reveals', () => {
    const game = createGame([
      player('Miss Scarlett', 17),
      player('Professor Plum', 4),
      player('Mrs. Peacock', 99),
    ]);
    begin(game, () => 0);
    for (const p of game.players) p.cards = [];

    expect(game.players.map(p => p.index)).toEqual([0, 1, 2]);
    expect(game.turnIndex).toBe(0);

    putInHall(game);
    expect(applyIntent(game, 0, {
      kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope',
    })).toEqual([
      { type: 'suggested', playerIndex: 0, suspect: 'Professor Plum', weapon: 'Rope', room: 'Hall' },
      { type: 'revealRequested', revealerIndex: 1 },
    ]);
    expect(game.pendingReveal!.revealerIndex).toBe(1);
    applyIntent(game, 1, { kind: 'declineReveal' });
    expect(game.pendingReveal!.revealerIndex).toBe(2);
    applyIntent(game, 2, { kind: 'declineReveal' });
    expect(game.pendingReveal).toBeNull();

    applyIntent(game, 0, { kind: 'endTurn' });
    expect(game.turnIndex).toBe(1);
  });

  it('allows a corridor-to-room entry to enable a suggestion', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]);
    applyIntent(game, 0, { kind: 'roll' }, () => 0.5);
    applyIntent(game, 0, { kind: 'moveTo', destination: 'Lounge' });

    expect(game.players[0]!.enteredRoomThisTurn).toBe(true);
    expect(() => applyIntent(game, 0, {
      kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope',
    })).not.toThrow();
  });

  it('rejects a suggestion in a one-player game without creating a pending reveal', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    putInHall(game);

    expect(() => applyIntent(game, 0, {
      kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope',
    })).toThrow('suggestions require at least two players');
    expect(game.pendingReveal).toBeNull();
  });

  it('rejects malformed runtime suggestion values before mutating the turn state', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]);
    putInHall(game);
    const malformed: unknown = {
      kind: 'suggest', suspect: 'Unknown Suspect', weapon: 'Rope',
    };

    expect(() => applyIntent(game, 0, malformed as Intent)).toThrow(
      'invalid suspect: Unknown Suspect',
    );
    expect(game.players[0]!.guessedHere).toBe(false);
    expect(game.pendingReveal).toBeNull();
  });

  it('does not allow a player who ended in a room to suggest next turn without re-entering', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]);
    applyIntent(game, 0, { kind: 'roll' }, () => 0.5);
    applyIntent(game, 0, { kind: 'moveTo', destination: 'Lounge' });
    applyIntent(game, 0, { kind: 'endTurn' });
    applyIntent(game, 1, { kind: 'endTurn' });

    expect(game.players[0]!.piece.location.room).toBe('Lounge');
    expect(game.players[0]!.enteredRoomThisTurn).toBe(false);
    expect(() => applyIntent(game, 0, {
      kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope',
    })).toThrow('player must enter a room before suggesting');
  });

  it('allows a suspect moved by suggestion to suggest on their next turn', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]);
    putInHall(game);
    applyIntent(game, 0, { kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope' });
    applyIntent(game, 1, { kind: 'declineReveal' });
    applyIntent(game, 0, { kind: 'endTurn' });

    expect(game.turnIndex).toBe(1);
    expect(game.players[1]!.enteredRoomThisTurn).toBe(false);
    expect(game.players[1]!.movedBySuggestion).toBe(true);
    expect(() => applyIntent(game, 1, {
      kind: 'suggest', suspect: 'Miss Scarlett', weapon: 'Dagger',
    })).not.toThrow();
  });

  it('rejects a repeated suggestion in the same turn', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]);
    putInHall(game);
    applyIntent(game, 0, { kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope' });
    applyIntent(game, 1, { kind: 'declineReveal' });

    expect(() => applyIntent(game, 0, {
      kind: 'suggest', suspect: 'Professor Plum', weapon: 'Dagger',
    })).toThrow('player cannot move or suggest after making a suggestion');
  });

  it('locks movement and repeat suggestions after a reveal resolves, but allows accusation and ending', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]);
    putInHall(game);
    applyIntent(game, 0, { kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope' });
    applyIntent(game, 1, { kind: 'declineReveal' });

    const forbiddenIntents = [
      { kind: 'roll' as const },
      { kind: 'moveTo' as const, destination: '17,18' as const },
      { kind: 'useSecretPassage' as const },
      { kind: 'suggest' as const, suspect: 'Professor Plum' as const, weapon: 'Dagger' as const },
    ];
    for (const intent of forbiddenIntents) {
      expect(() => applyIntent(game, 0, intent)).toThrow(
        'player cannot move or suggest after making a suggestion',
      );
    }

    game.solution = {
      suspect: { type: 'suspect', suspect: 'Mrs. Peacock' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    expect(applyIntent(game, 0, {
      kind: 'accuse', suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library',
    })).toEqual([{ type: 'accused', playerIndex: 0, correct: false }]);
    expect(applyIntent(game, 0, { kind: 'endTurn' })).toEqual([
      { type: 'turnEnded', playerIndex: 0 },
    ]);
  });

  it('rejects malformed coordinates and illegal moves without mutating position', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    const start = game.players[0]!.piece.location;
    game.lastDieRoll = 1;
    game.hasRolledThisTurn = true;

    expect(() => applyIntent(game, 0, { kind: 'moveTo', destination: 'abc,def' })).toThrow();
    expect(() => applyIntent(game, 0, { kind: 'moveTo', destination: '7,5' })).toThrow();
    expect(game.players[0]!.piece.location).toBe(start);
  });

  it('suggests, moves the named suspect, and creates a pending reveal', () => {
    const players = [player('Miss Scarlett', 0), player('Professor Plum', 1), player('Mrs. Peacock', 2)];
    const game = playingGame(players);
    putInHall(game);
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

  it('accepts a robot suggestion for a suspect absent from a partial game', () => {
    const players = [
      player('Miss Scarlett', 0, [], true),
      player('Professor Plum', 1),
    ];
    const game = playingGame(players);
    putInHall(game);
    const otherPlayerStart = game.players[1]!.piece.location;

    const intent = decideRobotIntent(game, 0, () => 0.5);
    expect(intent).toEqual({ kind: 'suggest', suspect: 'Colonel Mustard', weapon: 'Revolver' });

    expect(() => applyIntent(game, 0, intent)).not.toThrow();
    expect(game.players[1]!.piece.location).toBe(otherPlayerStart);
    expect(game.players[1]!.movedBySuggestion).toBe(false);
    expect(game.pendingReveal).toMatchObject({
      suggesterIndex: 0,
      suspect: 'Colonel Mustard',
      weapon: 'Revolver',
      room: 'Hall',
      revealerIndex: 1,
    });
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
    putInHall(game);
    applyIntent(game, 0, { kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope' });

    expect(() => applyIntent(game, 1, { kind: 'showCard', card: { type: 'weapon', weapon: 'Rope' } })).toThrow();
    expect(() => applyIntent(game, 1, { kind: 'showCard', card: { type: 'weapon', weapon: 'Dagger' } })).toThrow();
    expect(() => applyIntent(game, 2, { kind: 'showCard', card: cards[0]! })).toThrow();

    const events = applyIntent(game, 1, { kind: 'showCard', card: { type: 'suspect', suspect: 'Professor Plum' } });
    expect(events).toEqual([{ type: 'revealed', revealerIndex: 1, cardHint: 'private' }]);
    expect(game.pendingReveal).toBeNull();
  });

  it('validates the entire revealer hand before accepting a matching card', () => {
    const malformedCard: unknown = { type: 'weapon', weapon: 'Unknown Weapon' };
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1, [
        { type: 'suspect', suspect: 'Professor Plum' },
        malformedCard as Card,
      ]),
    ]);
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };
    const pendingReveal = game.pendingReveal;
    const cards = game.players[1]!.cards;

    expect(() => applyIntent(game, 1, {
      kind: 'showCard', card: { type: 'suspect', suspect: 'Professor Plum' },
    })).toThrow('invalid owned card weapon: Unknown Weapon');
    expect(game.pendingReveal).toBe(pendingReveal);
    expect(game.players[1]!.cards).toBe(cards);
  });

  it('validates the entire revealer hand before allowing a decline', () => {
    const malformedCard: unknown = { type: 'weapon', weapon: 'Unknown Weapon' };
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1, [
        { type: 'suspect', suspect: 'Professor Plum' },
        malformedCard as Card,
      ]),
    ]);
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };
    const pendingReveal = game.pendingReveal;

    expect(() => applyIntent(game, 1, { kind: 'declineReveal' })).toThrow(
      'invalid owned card weapon: Unknown Weapon',
    );
    expect(game.pendingReveal).toBe(pendingReveal);
  });

  it('rejects corrupt pending reveal metadata before gameplay or reveal actions', () => {
    const base = {
      suggesterIndex: 0,
      suspect: 'Professor Plum' as const,
      weapon: 'Rope' as const,
      room: 'Hall' as const,
      revealerIndex: 1,
    };
    const cases: Array<[unknown, string]> = [
      [undefined, 'invalid pending reveal metadata: expected an object'],
      [false, 'invalid pending reveal metadata: expected an object'],
      [0, 'invalid pending reveal metadata: expected an object'],
      ['', 'invalid pending reveal metadata: expected an object'],
      [{ ...base, secret: 'runtime metadata' }, 'invalid pending reveal metadata key: secret'],
      [{ ...base, revealerIndex: 0 }, 'invalid pending reveal: suggester and revealer must be distinct'],
    ];

    for (const [pendingReveal, message] of cases) {
      for (const intent of [{ kind: 'roll' as const }, { kind: 'declineReveal' as const }]) {
        const game = playingGame([
          player('Miss Scarlett', 0),
          player('Professor Plum', 1),
        ]);
        game.pendingReveal = pendingReveal as Game['pendingReveal'];

        expect(() => applyIntent(game, 0, intent)).toThrow(message);
        expect(game.hasRolledThisTurn).toBe(false);
        expect(game.pendingReveal).toBe(pendingReveal as Game['pendingReveal']);
      }
    }
  });

  it('rejects malformed runtime reveal cards with field-specific errors', () => {
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
    const malformed: unknown = {
      kind: 'showCard',
      card: { type: 'weapon', weapon: 'Unknown Weapon' },
    };

    expect(() => applyIntent(game, 1, malformed as Intent)).toThrow(
      'invalid reveal card weapon: Unknown Weapon',
    );
    expect(game.pendingReveal!.revealerIndex).toBe(1);
  });

  it('keeps sequential reveal opportunities for players without matching cards', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
      player('Mrs. Peacock', 2, [{ type: 'room', room: 'Hall' }]),
    ]);
    putInHall(game);
    applyIntent(game, 0, { kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope' });

    expect(applyIntent(game, 1, { kind: 'declineReveal' })).toEqual([
      { type: 'declinedReveal', revealerIndex: 1 },
      { type: 'revealRequested', revealerIndex: 2 },
    ]);
    expect(applyIntent(game, 2, {
      kind: 'showCard', card: { type: 'room', room: 'Hall' },
    })).toEqual([{ type: 'revealed', revealerIndex: 2, cardHint: 'private' }]);
    expect(game.pendingReveal).toBeNull();
  });

  it('declines around the table and clears after cycling to the suggester', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
      player('Mrs. Peacock', 2),
    ]);
    putInHall(game);
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

  it('rejects declining when the revealer owns a matching card without changing the pending reveal', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1, [{ type: 'weapon', weapon: 'Rope' }]),
      player('Mrs. Peacock', 2),
    ]);
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };
    const pendingReveal = game.pendingReveal;

    expect(() => applyIntent(game, 1, { kind: 'declineReveal' })).toThrow(
      'revealer must show a matching card instead of declining',
    );
    expect(game.pendingReveal).toBe(pendingReveal);
  });

  it('uses secret passages between opposite corner rooms only', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.players[0]!.piece.location = game.board[2]![1]!;
    expect(applyIntent(game, 0, { kind: 'useSecretPassage' })).toEqual([
      { type: 'usedSecretPassage', playerIndex: 0, to: 'Lounge' },
    ]);
    expect(game.players[0]!.piece.location.room).toBe('Lounge');
    expect(game.players[0]!.enteredRoomThisTurn).toBe(true);
    expect(game.hasMovedThisTurn).toBe(true);
    expect(() => applyIntent(game, 0, { kind: 'roll' })).toThrow(
      'player must move or end their turn before rolling again',
    );

    game.players[0]!.piece.location = spaceAt(game.board, 7, 5);
    expect(() => applyIntent(game, 0, { kind: 'useSecretPassage' })).toThrow();
  });

  it('allows a suggestion after a legal room-to-room secret passage', () => {
    const game = playingGame([
      player('Miss Scarlett', 0),
      player('Professor Plum', 1),
    ]);
    game.players[0]!.piece.location = spaceAt(game.board, 2, 1);

    applyIntent(game, 0, { kind: 'useSecretPassage' });

    expect(game.players[0]!.piece.location.room).toBe('Lounge');
    expect(game.players[0]!.enteredRoomThisTurn).toBe(true);
    expect(() => applyIntent(game, 0, {
      kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope',
    })).not.toThrow();
  });

  it('rejects a secret passage after the player has rolled', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.players[0]!.piece.location = game.board[2]![1]!;
    game.lastDieRoll = 6;
    game.hasRolledThisTurn = true;

    expect(() => applyIntent(game, 0, { kind: 'useSecretPassage' })).toThrow(
      'secret passages can only be used before rolling',
    );
    expect(game.lastDieRoll).toBe(6);
  });

  it('rejects a secret passage after moving', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    game.players[0]!.piece.location = spaceAt(game.board, 16, 24);
    applyIntent(game, 0, { kind: 'roll' }, () => 0.5);
    applyIntent(game, 0, { kind: 'moveTo', destination: 'Lounge' });

    expect(() => applyIntent(game, 0, { kind: 'useSecretPassage' })).toThrow(
      'secret passages can only be used before moving',
    );
  });

  it('allows rolling again after ending the turn', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    applyIntent(game, 0, { kind: 'roll' }, () => 0.5);
    applyIntent(game, 0, { kind: 'endTurn' });

    expect(game.lastDieRoll).toBeNull();
    expect(game.hasRolledThisTurn).toBe(false);
    expect(game.hasMovedThisTurn).toBe(false);

    applyIntent(game, 1, { kind: 'roll' }, () => 0);
    expect(game.lastDieRoll).toBe(2);
    expect(game.hasRolledThisTurn).toBe(true);
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

  it('rejects malformed runtime accusation values before marking a failed accusation', () => {
    const game = playingGame([player('Miss Scarlett', 0), player('Professor Plum', 1)]);
    game.solution = {
      suspect: { type: 'suspect', suspect: 'Mrs. Peacock' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    const malformed: unknown = {
      kind: 'accuse', suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Unknown Room',
    };

    expect(() => applyIntent(game, 0, malformed as Intent)).toThrow(
      'invalid room: Unknown Room',
    );
    expect(game.players[0]!.failedAccusation).toBe(false);
  });

  it('rejects accusations with missing or malformed solutions', () => {
    const game = playingGame([player('Miss Scarlett', 0)]);
    const accuse = {
      kind: 'accuse' as const,
      suspect: 'Miss Scarlett' as const,
      weapon: 'Rope' as const,
      room: 'Library' as const,
    };

    expect(() => applyIntent(game, 0, accuse)).toThrow(
      'cannot evaluate accusation without a game solution',
    );

    const malformed: unknown = {
      suspect: { type: 'weapon', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    game.solution = malformed as typeof game.solution;

    expect(() => applyIntent(game, 0, accuse)).toThrow('invalid game solution');
  });

  it('ends a turn, resets per-turn flags, and advances past failed players', () => {
    const players = [player('Miss Scarlett', 0), player('Professor Plum', 1), player('Mrs. Peacock', 2)];
    const game = playingGame(players);
    game.players[0]!.guessedHere = true;
    game.players[0]!.movedBySuggestion = true;
    game.players[0]!.enteredRoomThisTurn = true;
    game.lastDieRoll = 8;
    game.hasRolledThisTurn = true;
    game.hasMovedThisTurn = true;
    game.players[1]!.failedAccusation = true;

    const events = applyIntent(game, 0, { kind: 'endTurn' });

    expect(events).toEqual([{ type: 'turnEnded', playerIndex: 0 }]);
    expect(game.lastDieRoll).toBeNull();
    expect(game.hasRolledThisTurn).toBe(false);
    expect(game.hasMovedThisTurn).toBe(false);
    expect(game.players[0]!.guessedHere).toBe(false);
    expect(game.players[0]!.movedBySuggestion).toBe(false);
    expect(game.players[0]!.enteredRoomThisTurn).toBe(false);
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
