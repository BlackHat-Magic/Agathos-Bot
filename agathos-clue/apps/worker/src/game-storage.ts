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
import { assertCard, clonePendingReveal, cloneSolution } from '@agathos/game';

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

export interface PersistedPrivateReveal {
  fromIndex: number;
  card?: Card;
}

export type PersistedPrivateReveals = Record<string, PersistedPrivateReveal>;

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
    pendingReveal: game.pendingReveal === null
      ? null
      : clonePendingReveal(game.pendingReveal, game.players.length),
    lastDieRoll: game.lastDieRoll,
    hasRolledThisTurn: game.hasRolledThisTurn,
    hasMovedThisTurn: game.hasMovedThisTurn,
    winnerIndex: game.winnerIndex,
    finishedAt: game.finishedAt,
  };
}

/** Keep private reveal frames separate from the public game snapshot. */
export function serializePrivateReveals(
  reveals: PersistedPrivateReveals,
): PersistedPrivateReveals {
  return Object.fromEntries(Object.entries(reveals).map(([userId, reveal]) => [
    userId,
    {
      fromIndex: reveal.fromIndex,
      ...(reveal.card === undefined ? {} : { card: cloneCard(reveal.card) }),
    },
  ]));
}

export function hydratePrivateReveals(
  value: unknown,
  playerCount: number,
): PersistedPrivateReveals {
  if (value === undefined) return {};
  const persisted = requireRecord(value, 'private reveals');
  const reveals: PersistedPrivateReveals = {};
  for (const [userId, revealValue] of Object.entries(persisted)) {
    if (userId === '') throw new Error('invalid persisted private reveal user ID');
    const reveal = requireRecord(revealValue, `private reveal for ${userId}`);
    requireKeys(
      reveal,
      Object.hasOwn(reveal, 'card') ? ['fromIndex', 'card'] : ['fromIndex'],
      `private reveal for ${userId}`,
    );
    if (typeof reveal.fromIndex !== 'number' || !Number.isInteger(reveal.fromIndex) ||
        reveal.fromIndex < 0 || reveal.fromIndex >= playerCount) {
      throw new Error(`invalid persisted private reveal source for ${userId}`);
    }
    reveals[userId] = {
      fromIndex: reveal.fromIndex,
      ...(Object.hasOwn(reveal, 'card')
        ? { card: cloneCard(reveal.card) }
        : {}),
    };
  }
  return reveals;
}

/** Rebuild one canonical board and bind every restored piece to it. */
export function hydrateGame(value: unknown): Game {
  const persisted = requireRecord(value, 'game');
  requireKeys(persisted, [
    'version', 'players', 'solution', 'phase', 'turnIndex', 'weapons',
    'pendingReveal', 'lastDieRoll', 'hasRolledThisTurn', 'hasMovedThisTurn',
    'winnerIndex', 'finishedAt',
  ], 'game');
  if (persisted.version !== 1) throw new Error(`invalid persisted game version: ${String(persisted.version)}`);
  if (!Array.isArray(persisted.players)) throw new Error('invalid persisted players: expected an array');
  if (!Array.isArray(persisted.weapons)) throw new Error('invalid persisted weapons: expected an array');
  if (persisted.phase !== 'lobby' && persisted.phase !== 'playing' && persisted.phase !== 'finished') {
    throw new Error(`invalid persisted phase: ${String(persisted.phase)}`);
  }

  const board = buildBoard();
  const seenSuspects = new Set<Suspect>();
  const seenUserIds = new Set<string>();
  const players: Player[] = [];
  for (const [index, value] of persisted.players.entries()) {
    const player = requireRecord(value, `player at index ${index}`);
    requireKeys(player, [
      'name', 'index', 'suspect', 'location', 'cards', 'failedAccusation',
      'guessedHere', 'movedBySuggestion', 'enteredRoomThisTurn', 'isRobot',
      ...(Object.hasOwn(player, 'userId') ? ['userId'] : []),
    ], `player at index ${index}`);
    if (typeof player.name !== 'string') {
      throw new Error(`invalid persisted player name at index ${index}`);
    }
    if (player.index !== index) {
      throw new Error(`invalid persisted player index at index ${index}: ${String(player.index)}`);
    }
    if (!isSuspect(player.suspect)) {
      throw new Error(`invalid persisted player suspect at index ${index}: ${String(player.suspect)}`);
    }
    if (seenSuspects.has(player.suspect)) {
      throw new Error(`duplicate persisted player suspect: ${player.suspect}`);
    }
    seenSuspects.add(player.suspect);
    if (!Array.isArray(player.cards)) {
      throw new Error(`invalid persisted player cards at index ${index}: expected an array`);
    }
    if (Object.hasOwn(player, 'userId')) {
      if (typeof player.userId !== 'string') {
        throw new Error(`invalid persisted player userId at index ${index}`);
      }
      if (seenUserIds.has(player.userId)) {
        throw new Error(`duplicate persisted player userId: ${player.userId}`);
      }
      seenUserIds.add(player.userId);
    }
    const userId = typeof player.userId === 'string' ? player.userId : undefined;
    const failedAccusation = requireBoolean(player.failedAccusation, `player ${index} failedAccusation`);
    const guessedHere = requireBoolean(player.guessedHere, `player ${index} guessedHere`);
    const movedBySuggestion = requireBoolean(player.movedBySuggestion, `player ${index} movedBySuggestion`);
    const enteredRoomThisTurn = requireBoolean(
      player.enteredRoomThisTurn,
      `player ${index} enteredRoomThisTurn`,
    );
    const isRobot = requireBoolean(player.isRobot, `player ${index} isRobot`);
    players.push({
      name: player.name,
      index,
      suspect: player.suspect,
      piece: {
        suspect: player.suspect,
        location: hydrateLocation(board, player.location),
      },
      cards: player.cards.map((card, cardIndex) => cloneCard(
        requirePersistedCard(card, `player ${index} card ${cardIndex}`),
      )),
      failedAccusation,
      guessedHere,
      movedBySuggestion,
      enteredRoomThisTurn,
      isRobot,
      ...(userId === undefined ? {} : { userId }),
    });
  }

  const seenWeapons = new Set<Weapon>();
  const weapons = persisted.weapons.map((value, index) => {
    const piece = requireRecord(value, `weapon at index ${index}`);
    requireKeys(piece, ['weapon', 'location'], `weapon at index ${index}`);
    if (!isWeapon(piece.weapon)) {
      throw new Error(`invalid persisted weapon at index ${index}: ${String(piece.weapon)}`);
    }
    if (seenWeapons.has(piece.weapon)) {
      throw new Error(`duplicate persisted weapon: ${piece.weapon}`);
    }
    seenWeapons.add(piece.weapon);
    return { weapon: piece.weapon, location: hydrateLocation(board, piece.location) };
  });

  const turnIndex = requireGameIndex(persisted.turnIndex, players.length, 'turn');
  const winnerIndex = persisted.winnerIndex === null
    ? null
    : requireGameIndex(persisted.winnerIndex, players.length, 'winner');
  if (persisted.lastDieRoll !== null &&
      (typeof persisted.lastDieRoll !== 'number' || !Number.isInteger(persisted.lastDieRoll) ||
       persisted.lastDieRoll < 2 || persisted.lastDieRoll > 12)) {
    throw new Error(`invalid persisted die roll: ${String(persisted.lastDieRoll)}`);
  }
  if (typeof persisted.hasRolledThisTurn !== 'boolean') {
    throw new Error('invalid persisted hasRolledThisTurn');
  }
  if (typeof persisted.hasMovedThisTurn !== 'boolean') {
    throw new Error('invalid persisted hasMovedThisTurn');
  }
  if (!persisted.hasRolledThisTurn && persisted.lastDieRoll !== null) {
    throw new Error('invalid persisted movement state: die roll without hasRolledThisTurn');
  }
  if (persisted.hasMovedThisTurn && persisted.lastDieRoll !== null) {
    throw new Error('invalid persisted movement state: moved turn retains die roll');
  }
  if (persisted.finishedAt !== null &&
      (typeof persisted.finishedAt !== 'number' || !Number.isFinite(persisted.finishedAt) ||
       persisted.finishedAt < 0)) {
    throw new Error(`invalid persisted finishedAt: ${String(persisted.finishedAt)}`);
  }
  const solution = persisted.solution === null ? null : clonePersistedSolution(persisted.solution);
  const pendingReveal = persisted.pendingReveal === null
    ? null
    : clonePendingReveal(persisted.pendingReveal, players.length);
  if (persisted.phase === 'lobby' && solution !== null) {
    throw new Error('invalid persisted lobby solution');
  }
  if (persisted.phase !== 'lobby' && solution === null) {
    throw new Error(`invalid persisted ${persisted.phase} solution`);
  }
  if (persisted.phase === 'finished' && persisted.finishedAt === null) {
    throw new Error('invalid persisted finishedAt: finished game has no timestamp');
  }
  if (persisted.phase !== 'finished' && persisted.finishedAt !== null) {
    throw new Error('invalid persisted finishedAt: unfinished game has a timestamp');
  }
  if (persisted.phase !== 'finished' && winnerIndex !== null) {
    throw new Error('invalid persisted winner index: game is not finished');
  }
  if (pendingReveal !== null && persisted.phase !== 'playing') {
    throw new Error('invalid persisted pending reveal: game is not playing');
  }

  return {
    players,
    solution,
    board,
    phase: persisted.phase,
    turnIndex,
    weapons,
    pendingReveal,
    lastDieRoll: persisted.lastDieRoll,
    hasRolledThisTurn: persisted.hasRolledThisTurn,
    hasMovedThisTurn: persisted.hasMovedThisTurn,
    winnerIndex,
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
  if (typeof location !== 'string' || !/^(0|[1-9]\d*),(0|[1-9]\d*)$/.test(location)) {
    throw new Error(`invalid persisted location: ${String(location)}`);
  }
  const [col, row] = location.split(',').map(Number);
  const space = board[col]?.[row];
  if (space === undefined) throw new Error(`invalid persisted location: ${location}`);
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

function cloneCard(value: unknown): Card {
  assertCard(value);
  if (value.type === 'suspect') return { type: 'suspect', suspect: value.suspect };
  if (value.type === 'weapon') return { type: 'weapon', weapon: value.weapon };
  return { type: 'room', room: value.room };
}

function requirePersistedCard(value: unknown, label: string): Card {
  const card = requireRecord(value, label);
  assertCard(card, `persisted ${label}`);
  requireKeys(card, ['type', card.type], label);
  return card;
}

function clonePersistedSolution(value: unknown): Solution {
  const solution = requireRecord(value, 'solution');
  requireKeys(solution, ['suspect', 'weapon', 'room'], 'solution');
  requirePersistedCard(solution.suspect, 'solution suspect');
  requirePersistedCard(solution.weapon, 'solution weapon');
  requirePersistedCard(solution.room, 'solution room');
  return cloneSolution(solution);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid persisted ${label}: expected an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`invalid persisted ${label}: expected a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const expectedKeys = new Set(expected);
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.size || keys.some(key => !expectedKeys.has(key))) {
    throw new Error(`invalid persisted ${label}: unexpected or missing fields`);
  }
}

function requireGameIndex(value: unknown, playerCount: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 ||
      (playerCount === 0 ? value !== 0 : value >= playerCount)) {
    throw new Error(`invalid persisted ${label} index: ${String(value)}`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid persisted ${label}`);
  return value;
}
