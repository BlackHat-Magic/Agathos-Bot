import {
  buildBoard,
  isSuspect,
  SUSPECTS,
  suspectStart,
} from '@agathos/game';
import type { Player, Suspect } from '@agathos/game';

export const LOBBY_STORAGE_KEY = 'lobby';
export const MAX_LOBBY_PLAYERS = 6;
export const MAX_PLAYER_NAME_LENGTH = 32;

export interface LobbyPlayer {
  userId: string;
  name: string;
  suspect: Suspect | null;
}

export interface LobbyState {
  players: LobbyPlayer[];
}

export interface LobbyViewPlayer {
  name: string;
  suspect: Suspect | null;
  isHost: boolean;
}

export interface LobbyView {
  type: 'lobby';
  gameId: string;
  hostUserId: string | null;
  players: LobbyViewPlayer[];
}

export function createLobby(): LobbyState {
  return { players: [] };
}

export function serializeLobby(lobby: LobbyState): LobbyState {
  validateLobby(lobby);
  return { players: lobby.players.map(player => ({ ...player })) };
}

export function hydrateLobby(value: unknown): LobbyState {
  if (!isRecord(value) || !isPlainObject(value)) {
    throw new Error('invalid persisted lobby: expected an object');
  }
  requireExactKeys(value, ['players'], 'lobby');
  if (!Array.isArray(value.players)) {
    throw new Error('invalid persisted lobby players: expected an array');
  }

  const players = value.players.map((rawPlayer, index) => {
    if (!isRecord(rawPlayer) || !isPlainObject(rawPlayer)) {
      throw new Error(`invalid persisted lobby player at index ${index}`);
    }
    requireExactKeys(rawPlayer, ['userId', 'name', 'suspect'], `lobby player at index ${index}`);
    if (typeof rawPlayer.userId !== 'string' || rawPlayer.userId.length === 0) {
      throw new Error(`invalid persisted lobby userId at index ${index}`);
    }
    const name = validateName(rawPlayer.name);
    const suspect = rawPlayer.suspect === null ? null : validateSuspect(rawPlayer.suspect);
    return { userId: rawPlayer.userId, name, suspect };
  });
  const lobby = { players };
  validateLobby(lobby);
  return lobby;
}

export function joinLobby(lobby: LobbyState, userId: string, rawName: unknown): LobbyState {
  validateLobby(lobby);
  if (lobby.players.some(player => player.userId === userId)) {
    throw new Error('user is already in the lobby');
  }
  if (lobby.players.length >= MAX_LOBBY_PLAYERS) {
    throw new Error('lobby is full');
  }
  const name = validateName(rawName);
  return {
    players: [...lobby.players.map(player => ({ ...player })), { userId, name, suspect: null }],
  };
}

export function claimLobbySuspect(
  lobby: LobbyState,
  userId: string,
  rawSuspect: unknown,
): LobbyState {
  validateLobby(lobby);
  const suspect = validateSuspect(rawSuspect);
  requireLobbyPlayer(lobby, userId);
  const owner = lobby.players.find(player => player.suspect === suspect && player.userId !== userId);
  if (owner !== undefined) throw new Error(`suspect is already claimed: ${suspect}`);
  return {
    players: lobby.players.map(player =>
      player.userId === userId ? { ...player, suspect } : { ...player }),
  };
}

export function setLobbyOrder(
  lobby: LobbyState,
  userId: string,
  rawOrder: unknown,
): LobbyState {
  validateLobby(lobby);
  requireLobbyHost(lobby, userId);
  if (!Array.isArray(rawOrder)) throw new Error('invalid lobby order: expected an array');

  const claimed = lobby.players.filter(player => player.suspect !== null);
  if (rawOrder.length !== claimed.length) {
    throw new Error('invalid lobby order: expected a complete claimed-suspect permutation');
  }
  const seen = new Set<Suspect>();
  const orderedClaimed: LobbyPlayer[] = [];
  for (const rawSuspect of rawOrder) {
    const suspect = validateSuspect(rawSuspect);
    if (seen.has(suspect)) throw new Error(`duplicate lobby order suspect: ${suspect}`);
    seen.add(suspect);
    const player = claimed.find(candidate => candidate.suspect === suspect);
    if (player === undefined) throw new Error(`unknown lobby order suspect: ${suspect}`);
    orderedClaimed.push({ ...player });
  }
  const unclaimed = lobby.players
    .filter(player => player.suspect === null)
    .map(player => ({ ...player }));
  return { players: [...orderedClaimed, ...unclaimed] };
}

export function requireLobbyHost(lobby: LobbyState, userId: string): void {
  validateLobby(lobby);
  if (lobby.players[0]?.userId !== userId) throw new Error('only the host can perform this lobby action');
}

export function leaveLobby(lobby: LobbyState, userId: string): LobbyState {
  validateLobby(lobby);
  requireLobbyPlayer(lobby, userId);
  return { players: lobby.players.filter(player => player.userId !== userId).map(player => ({ ...player })) };
}

/** Build valid game-package players only after the lobby is ready to start. */
export function createStartPlayers(lobby: LobbyState): Player[] {
  validateLobby(lobby);
  if (lobby.players.length === 0) throw new Error('cannot start an empty lobby');
  if (lobby.players.some(player => player.suspect === null)) {
    throw new Error('every lobby player must claim a suspect before starting');
  }

  const board = buildBoard();
  const claimed = new Set<Suspect>();
  const humans: Player[] = lobby.players.map((lobbyPlayer, index) => {
    const suspect = lobbyPlayer.suspect;
    if (suspect === null) throw new Error('every lobby player must claim a suspect before starting');
    if (claimed.has(suspect)) throw new Error(`duplicate lobby suspect: ${suspect}`);
    claimed.add(suspect);
    return makePlayer(lobbyPlayer.name, suspect, index, false, lobbyPlayer.userId, board);
  });

  const robots = SUSPECTS
    .filter(suspect => !claimed.has(suspect))
    .map((suspect, index) => makePlayer(suspect, suspect, humans.length + index, true, undefined, board));
  return [...humans, ...robots];
}

export function lobbyView(lobby: LobbyState, gameId: string): LobbyView {
  validateLobby(lobby);
  const hostUserId = lobby.players[0]?.userId ?? null;
  return {
    type: 'lobby',
    gameId,
    hostUserId,
    players: lobby.players.map((player, index) => ({
      name: player.name,
      suspect: player.suspect,
      isHost: index === 0,
    })),
  };
}

function makePlayer(
  name: string,
  suspect: Suspect,
  index: number,
  isRobot: boolean,
  userId: string | undefined,
  board: ReturnType<typeof buildBoard>,
): Player {
  return {
    name,
    index,
    suspect,
    piece: { suspect, location: suspectStart(suspect, board) },
    cards: [],
    failedAccusation: false,
    guessedHere: false,
    movedBySuggestion: false,
    enteredRoomThisTurn: false,
    isRobot,
    ...(userId === undefined ? {} : { userId }),
  };
}

function validateLobby(lobby: LobbyState): void {
  if (!isRecord(lobby) || !Array.isArray(lobby.players)) {
    throw new Error('invalid lobby state');
  }
  if (lobby.players.length > MAX_LOBBY_PLAYERS) throw new Error('lobby is full');
  const seenUsers = new Set<string>();
  const seenSuspects = new Set<Suspect>();
  for (const player of lobby.players) {
    if (!isRecord(player) || typeof player.userId !== 'string' || player.userId.length === 0) {
      throw new Error('invalid lobby user');
    }
    if (seenUsers.has(player.userId)) throw new Error(`duplicate lobby user: ${player.userId}`);
    seenUsers.add(player.userId);
    validateName(player.name);
    if (player.suspect !== null) {
      const suspect = validateSuspect(player.suspect);
      if (seenSuspects.has(suspect)) throw new Error(`duplicate lobby suspect: ${suspect}`);
      seenSuspects.add(suspect);
    }
  }
}

function requireLobbyPlayer(lobby: LobbyState, userId: string): LobbyPlayer {
  const player = lobby.players.find(candidate => candidate.userId === userId);
  if (player === undefined) throw new Error('user is not in the lobby');
  return player;
}

function validateName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid name: expected a string');
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_PLAYER_NAME_LENGTH) {
    throw new Error('invalid name: expected 1-32 trimmed characters');
  }
  return name;
}

function validateSuspect(value: unknown): Suspect {
  if (!isSuspect(value)) throw new Error(`invalid suspect: ${String(value)}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const expectedKeys = new Set(expected);
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.size || keys.some(key => !expectedKeys.has(key))) {
    throw new Error(`invalid persisted ${label}: unexpected or missing fields`);
  }
}
