import { describe, expect, it } from 'vitest';
import { buildBoard, createGame, spaceAt } from '@agathos/game';
import type { Card, Event, Game, Player } from '@agathos/game';
import { hydrateGame, serializeGame } from '../game-storage';
import { runRobotScheduler } from './scheduler';

function player(
  suspect: Player['suspect'],
  index: number,
  isRobot: boolean,
  cards: Card[] = [],
): Player {
  const board = buildBoard();
  return {
    name: suspect,
    index,
    suspect,
    piece: { suspect, location: spaceAt(board, 16, 24) },
    cards,
    failedAccusation: false,
    guessedHere: false,
    movedBySuggestion: false,
    enteredRoomThisTurn: false,
    isRobot,
  };
}

function playingGame(players: Player[]): Game {
  const game = createGame(players);
  game.phase = 'playing';
  game.solution = {
    suspect: { type: 'suspect', suspect: 'Mrs. Peacock' },
    weapon: { type: 'weapon', weapon: 'Dagger' },
    room: { type: 'room', room: 'Study' },
  };
  return game;
}

describe('runRobotScheduler', () => {
  it('runs a robot turn until the next human turn', async () => {
    const game = playingGame([
      player('Miss Scarlett', 0, true),
      player('Professor Plum', 1, false),
    ]);
    const events: Event[][] = [];
    let persistCount = 0;

    await runRobotScheduler({
      getGame: () => game,
      snapshot: serializeGame,
      restore: snapshot => Object.assign(game, hydrateGame(snapshot)),
      persist: async () => { persistCount += 1; },
      broadcast: nextEvents => events.push(nextEvents),
      rng: () => 0,
    });

    expect(game.turnIndex).toBe(1);
    expect(persistCount).toBe(3);
    expect(events.map(nextEvents => nextEvents[0]?.type)).toEqual([
      'rolled', 'moved', 'turnEnded',
    ]);
  });

  it('runs a pending robot revealer even when it is not the turn index', async () => {
    const game = playingGame([
      player('Miss Scarlett', 0, false),
      player('Professor Plum', 1, true, [{ type: 'weapon', weapon: 'Rope' }]),
    ]);
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };
    const events: Event[][] = [];

    await runRobotScheduler({
      getGame: () => game,
      snapshot: serializeGame,
      restore: snapshot => Object.assign(game, hydrateGame(snapshot)),
      persist: async () => {},
      broadcast: nextEvents => events.push(nextEvents),
      rng: () => 0,
    });

    expect(game.pendingReveal).toBeNull();
    expect(events).toEqual([[{ type: 'revealed', revealerIndex: 1, cardHint: 'private' }]]);
  });

  it('stops without mutation when the next actor is human or the game is finished', async () => {
    const game = playingGame([
      player('Miss Scarlett', 0, false),
      player('Professor Plum', 1, true),
    ]);
    let persistCount = 0;
    let broadcastCount = 0;
    const options = {
      getGame: () => game,
      snapshot: serializeGame,
      restore: (snapshot: ReturnType<typeof serializeGame>) => Object.assign(game, hydrateGame(snapshot)),
      persist: async () => { persistCount += 1; },
      broadcast: () => { broadcastCount += 1; },
    };

    await runRobotScheduler(options);
    game.phase = 'finished';
    await runRobotScheduler(options);

    expect(persistCount).toBe(0);
    expect(broadcastCount).toBe(0);
  });

  it('restores the last state when autonomous persistence fails', async () => {
    const game = playingGame([
      player('Miss Scarlett', 0, true),
      player('Professor Plum', 1, false),
    ]);
    const before = serializeGame(game);
    let restored: Game | undefined;

    await expect(runRobotScheduler({
      getGame: () => restored ?? game,
      snapshot: serializeGame,
      restore: snapshot => { restored = hydrateGame(snapshot); },
      persist: async () => { throw new Error('storage unavailable'); },
      broadcast: () => {},
      rng: () => 0.5,
    })).rejects.toThrow('storage unavailable');

    expect(restored).toBeDefined();
    expect(serializeGame(restored!)).toEqual(before);
  });
});
