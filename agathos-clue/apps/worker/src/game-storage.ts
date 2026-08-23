import {
  buildBoard,
  createGame,
  isRoom,
  isSuspect,
  isWeapon,
  spaceAt,
} from '@agathos/game';
import type {
  Card,
  CellId,
  Game,
  Player,
  Room,
  Solution,
  Suspect,
  Weapon,
} from '@agathos/game';
import { assertCard, cloneSolution } from '@agathos/game';

export interface PersistedPlayer {
  name: string;
  index: number;
  suspect: Suspect;
  location: Room | CellId;
  cards: Card[];
  failedAccusation: boolean;
  guessedHere: boolean;
  movedBySuggestion: boolean;
  enteredRoomThisTurn: boolean;
  isRobot: boolean;
  userId?: string;
}

export interface PersistedWeapon {
  weapon: Weapon;
  location: Room | CellId;
}

export interface PersistedGame {
  version: 1;
  players: PersistedPlayer[];
  solution: Solution | null;
  phase: Game['phase'];
  turnIndex: number;
  weapons: PersistedWeapon[];
  pendingReveal: Game['pendingReveal'];
  lastDieRoll: number | null;
  hasRolledThisTurn: boolean;
  hasMovedThisTurn: boolean;
  winnerIndex: number | null;
  finishedAt: number | null;
}

/** Return the empty authoritative lobby used when a room has no stored game. */
export function createInitialGame(): Game {
  return createGame([]);
}

/** Convert a Game to a plain value without traversing its cyclic board graph. */
export function serializeGame(game: Game): PersistedGame {
  return {
    version: 1,
    players: game.players.map(player => ({
      name: player.name,
      index: player.index,
      suspect: player.suspect,
      location: serializeLocation(player.piece.location),
      cards: player.cards.map(cloneCard),
      failedAccusation: player.failedAccusation,
      guessedHere: player.guessedHere,
      movedBySuggestion: player.movedBySuggestion,
      enteredRoomThisTurn: player.enteredRoomThisTurn,
      isRobot: player.isRobot,
      ...(player.userId === undefined ? {} : { userId: player.userId }),
    })),
    solution: game.solution === null ? null : cloneSolution(game.solution),
    phase: game.phase,
    turnIndex: game.turnIndex,
    weapons: game.weapons.map(piece => ({
      weapon: piece.weapon,
      location: serializeLocation(piece.location),
    })),
    pendingReveal: game.pendingReveal === null ? null : { ...game.pendingReveal },
    lastDieRoll: game.lastDieRoll,
    hasRolledThisTurn: game.hasRolledThisTurn,
    hasMovedThisTurn: game.hasMovedThisTurn,
    winnerIndex: game.winnerIndex,
    finishedAt: game.finishedAt,
  };
}

/** Rebuild one canonical board and bind every restored piece to it. */
export function hydrateGame(value: unknown): Game {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.players)) {
    throw new Error('invalid persisted game');
  }

  const persisted = value as unknown as PersistedGame;
  const board = buildBoard();
  const players: Player[] = persisted.players.map((player, index) => {
    if (!isRecord(player) || typeof player.name !== 'string' ||
      !Number.isInteger(player.index) || !isSuspect(player.suspect) ||
      !Array.isArray(player.cards)) {
      throw new Error(`invalid persisted player at index ${index}`);
    }
    return {
      name: player.name,
      index: player.index,
      suspect: player.suspect,
      piece: {
        suspect: player.suspect,
        location: hydrateLocation(board, player.location),
      },
      cards: player.cards.map((card, cardIndex) => {
        assertCard(card, `persisted player ${index} card ${cardIndex}`);
        return cloneCard(card);
      }),
      failedAccusation: player.failedAccusation,
      guessedHere: player.guessedHere,
      movedBySuggestion: player.movedBySuggestion,
      enteredRoomThisTurn: player.enteredRoomThisTurn,
      isRobot: player.isRobot,
      ...(player.userId === undefined ? {} : { userId: player.userId }),
    };
  });

  if (!Array.isArray(persisted.weapons)) throw new Error('invalid persisted weapons');
  const weapons = persisted.weapons.map((piece, index) => {
    if (!isRecord(piece) || !isWeapon(piece.weapon)) {
      throw new Error(`invalid persisted weapon at index ${index}`);
    }
    return { weapon: piece.weapon, location: hydrateLocation(board, piece.location) };
  });

  return {
    players,
    solution: persisted.solution === null ? null : cloneSolution(persisted.solution),
    board,
    phase: persisted.phase,
    turnIndex: persisted.turnIndex,
    weapons,
    pendingReveal: persisted.pendingReveal === null ? null : { ...persisted.pendingReveal },
    lastDieRoll: persisted.lastDieRoll,
    hasRolledThisTurn: persisted.hasRolledThisTurn,
    hasMovedThisTurn: persisted.hasMovedThisTurn,
    winnerIndex: persisted.winnerIndex,
    finishedAt: persisted.finishedAt,
  };
}

function serializeLocation(location: { room: Room | null; pos: [number, number] | null }): Room | CellId {
  if (location.room !== null) return location.room;
  if (location.pos !== null) return `${location.pos[0]},${location.pos[1]}`;
  throw new Error('cannot persist a board location without a room or cell');
}

function hydrateLocation(board: Game['board'], location: unknown) {
  if (isRoom(location)) return findRoom(board, location);
  if (typeof location !== 'string' || !/^\d+,\d+$/.test(location)) {
    throw new Error(`invalid persisted location: ${String(location)}`);
  }
  const [col, row] = location.split(',').map(Number);
  return spaceAt(board, col, row);
}

function findRoom(board: Game['board'], room: Room) {
  for (const column of board) {
    for (const space of column) {
      if (!space) continue;
      if (space.room === room) return space;
    }
  }
  throw new Error(`room is not on the board: ${room}`);
}

function cloneCard(value: Card): Card {
  assertCard(value);
  if (value.type === 'suspect') return { type: 'suspect', suspect: value.suspect };
  if (value.type === 'weapon') return { type: 'weapon', weapon: value.weapon };
  return { type: 'room', room: value.room };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
