import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  isCard,
  isRoom,
  isSolution,
  isSuspect,
  isWeapon,
} from '@agathos/game';
import type { Card, CellId, Event, GameView, Room, Suspect, Weapon } from '@agathos/game';
import { isClientIntentKind } from './intents';
import type { ClientIntentKind } from './intents';

const MAX_PLAYERS = 6;
const MAX_CARDS = 18;
const MAX_EVENTS = 64;
const MAX_MESSAGE_LENGTH = 4_096;
const CELL_ID = /^\d+,\d+$/;

export interface StateFrame {
  type: 'state';
  view: GameView;
  events: Event[];
}

export interface PrivateReveal {
  fromIndex: number;
  card?: Card;
}

export interface PrivateRevealFrame {
  type: 'private';
  reveal: PrivateReveal;
}

export interface LobbySnapshot {
  type: 'lobby';
  gameId: string;
  isHost: boolean;
  players: Array<{
    name: string;
    suspect: Suspect | null;
    isHost: boolean;
  }>;
}

export interface ReadyFrame {
  type: 'ready';
}

export interface ErrorFrame {
  type: 'error';
  message: string;
  intentKind?: ClientIntentKind;
}

export type ServerFrame = StateFrame | PrivateRevealFrame | LobbySnapshot | ReadyFrame | ErrorFrame;

export type ParseResult =
  | { ok: true; frame: ServerFrame }
  | { ok: false; error: string };

export function parseServerMessage(data: unknown): ParseResult {
  let value: unknown;
  if (typeof data === 'string') {
    if (data.length > MAX_MESSAGE_LENGTH) return invalid('message is too large');
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      return invalid('malformed JSON message');
    }
  } else if (data instanceof ArrayBuffer) {
    try {
      const text = new TextDecoder().decode(data);
      if (text.length > MAX_MESSAGE_LENGTH) return invalid('message is too large');
      value = JSON.parse(text) as unknown;
    } catch {
      return invalid('malformed JSON message');
    }
  } else {
    return invalid('unsupported WebSocket message');
  }

  try {
    return { ok: true, frame: validateServerFrame(value) };
  } catch (error) {
    return invalid(errorMessage(error));
  }
}

export function validateServerFrame(value: unknown): ServerFrame {
  const record = requireObject(value, 'server frame');
  switch (record.type) {
    case 'state':
      requireKeys(record, ['type', 'view', 'events'], 'state frame');
      if (!Array.isArray(record.events) || record.events.length > MAX_EVENTS) {
        throw new Error('invalid state events');
      }
      const rawView = requireObject(record.view, 'state game view');
      if (Object.hasOwn(rawView, 'myLastShownCard') || Object.hasOwn(rawView, 'lastSuggestionReveal')) {
        throw new Error('state frame contains private reveal data');
      }
      const view = validateGameView(rawView);
      return {
        type: 'state',
        view,
        events: record.events.map((event, index) => validateEvent(event, index, view.players.length)),
      };
    case 'private':
      requireKeys(record, ['type', 'reveal'], 'private frame');
      return { type: 'private', reveal: validatePrivateReveal(record.reveal) };
    case 'lobby':
      return validateLobbySnapshot(record);
    case 'ready':
      requireKeys(record, ['type'], 'ready frame');
      return { type: 'ready' };
    case 'error':
      requireKeys(record, ['type', 'message'], 'error frame', ['intentKind']);
      if (typeof record.message !== 'string' || record.message.length === 0 ||
          record.message.length > 1_024) {
        throw new Error('invalid error message');
      }
      if (record.intentKind !== undefined && !isClientIntentKind(record.intentKind)) {
        throw new Error('invalid error intent kind');
      }
      return record.intentKind === undefined
        ? { type: 'error', message: record.message }
        : { type: 'error', message: record.message, intentKind: record.intentKind };
    default:
      throw new Error(`unknown server frame type: ${String(record.type)}`);
  }
}

export function validateGameView(value: unknown): GameView {
  const record = requireObject(value, 'game view');
  requireKeys(record, [
    'phase', 'boardWidth', 'boardHeight', 'players', 'weaponLocations', 'turnIndex',
    'winnerIndex', 'pendingReveal', 'lastDieRoll', 'myIndex', 'myHand',
  ], 'game view', [
    'myRevealOpportunities', 'myLastShownCard', 'lastSuggestionReveal',
    'reachableSpacesHints', 'solution', 'hasRolledThisTurn', 'hasMovedThisTurn',
    'canSuggest', 'canUseSecretPassage',
  ]);

  if (record.phase !== 'lobby' && record.phase !== 'playing' && record.phase !== 'finished') {
    throw new Error('invalid game view phase');
  }
  if (record.boardWidth !== BOARD_WIDTH || record.boardHeight !== BOARD_HEIGHT) {
    throw new Error('invalid game view board dimensions');
  }
  if (!Array.isArray(record.players) || record.players.length === 0 ||
      record.players.length > MAX_PLAYERS) {
    throw new Error('invalid game view players');
  }
  const players = record.players.map((player, index) => validateViewPlayer(player, index));
  const playerCount = players.length;
  const myIndex = requireIndex(record.myIndex, playerCount, 'my index');
  const turnIndex = requireIndex(record.turnIndex, playerCount, 'turn index');
  const winnerIndex = optionalIndex(record.winnerIndex, playerCount, 'winner index');
  const pendingReveal = validatePendingReveal(record.pendingReveal, playerCount);
  const myHand = validateCards(record.myHand, 'my hand');
  const weaponLocations = validateWeaponLocations(record.weaponLocations);

  if (record.lastDieRoll !== null &&
      (typeof record.lastDieRoll !== 'number' || !Number.isInteger(record.lastDieRoll) ||
       record.lastDieRoll < 2 || record.lastDieRoll > 12)) {
    throw new Error('invalid last die roll');
  }
  for (const key of ['hasRolledThisTurn', 'hasMovedThisTurn', 'canSuggest', 'canUseSecretPassage']) {
    if (record[key] !== undefined && typeof record[key] !== 'boolean') {
      throw new Error(`invalid ${key}`);
    }
  }
  if (record.solution !== undefined) {
    if (record.phase !== 'finished' || !isSolution(record.solution)) {
      throw new Error('solution is only valid for a finished game');
    }
  }

  const view: GameView = {
    phase: record.phase,
    boardWidth: record.boardWidth,
    boardHeight: record.boardHeight,
    players,
    weaponLocations,
    turnIndex,
    winnerIndex,
    pendingReveal,
    lastDieRoll: record.lastDieRoll,
    myIndex,
    myHand,
  };
  const hasRolledThisTurn = optionalBoolean(record.hasRolledThisTurn, 'hasRolledThisTurn');
  const hasMovedThisTurn = optionalBoolean(record.hasMovedThisTurn, 'hasMovedThisTurn');
  const canSuggest = optionalBoolean(record.canSuggest, 'canSuggest');
  const canUseSecretPassage = optionalBoolean(record.canUseSecretPassage, 'canUseSecretPassage');
  if (hasRolledThisTurn !== undefined) view.hasRolledThisTurn = hasRolledThisTurn;
  if (hasMovedThisTurn !== undefined) view.hasMovedThisTurn = hasMovedThisTurn;
  if (canSuggest !== undefined) view.canSuggest = canSuggest;
  if (canUseSecretPassage !== undefined) view.canUseSecretPassage = canUseSecretPassage;
  if (record.myRevealOpportunities !== undefined) {
    view.myRevealOpportunities = validateCards(record.myRevealOpportunities, 'reveal opportunities');
  }
  if (record.myLastShownCard !== undefined) {
    view.myLastShownCard = validateCard(record.myLastShownCard, 'last shown card');
  }
  if (record.lastSuggestionReveal !== undefined) {
    const reveal = requireObject(record.lastSuggestionReveal, 'last suggestion reveal');
    requireKeys(reveal, ['fromIndex', 'card'], 'last suggestion reveal');
    view.lastSuggestionReveal = {
      fromIndex: requireIndex(reveal.fromIndex, playerCount, 'reveal source index'),
      card: validateCard(reveal.card, 'last suggestion reveal card'),
    };
  }
  if (record.reachableSpacesHints !== undefined) {
    // A full-board roll can legitimately reach most corridor cells plus every
    // room (worst observed: 173 from the Ballroom), so bound by board size.
    if (!Array.isArray(record.reachableSpacesHints) ||
      record.reachableSpacesHints.length > BOARD_WIDTH * BOARD_HEIGHT) {
      throw new Error('invalid reachable spaces hints');
    }
    view.reachableSpacesHints = record.reachableSpacesHints.map((space, index) =>
      validateLocation(space, `reachable space at index ${index}`));
  }
  if (record.solution !== undefined) {
    view.solution = {
      suspect: { type: 'suspect', suspect: record.solution.suspect.suspect },
      weapon: { type: 'weapon', weapon: record.solution.weapon.weapon },
      room: { type: 'room', room: record.solution.room.room },
    };
  }
  return view;
}

export function isGameView(value: unknown): value is GameView {
  try {
    validateGameView(value);
    return true;
  } catch {
    return false;
  }
}

function validatePrivateReveal(value: unknown): PrivateReveal {
  const record = requireObject(value, 'private reveal');
  requireKeys(record, ['fromIndex'], 'private reveal', ['card']);
  const reveal: PrivateReveal = { fromIndex: requireIndex(record.fromIndex, MAX_PLAYERS, 'reveal source index') };
  if (record.card !== undefined) reveal.card = validateCard(record.card, 'private reveal card');
  return reveal;
}

function validateLobbySnapshot(record: Record<string, unknown>): LobbySnapshot {
  requireKeys(record, ['type', 'gameId', 'isHost', 'players']);
  if (typeof record.gameId !== 'string' || record.gameId.length === 0 || record.gameId.length > 80) {
    throw new Error('invalid lobby game id');
  }
  if (typeof record.isHost !== 'boolean') {
    throw new Error('invalid lobby host flag');
  }
  if (!Array.isArray(record.players) || record.players.length > MAX_PLAYERS) {
    throw new Error('invalid lobby players');
  }
  return {
    type: 'lobby',
    gameId: record.gameId,
    isHost: record.isHost,
    players: record.players.map((value, index) => {
      const player = requireObject(value, `lobby player at index ${index}`);
      requireKeys(player, ['name', 'suspect', 'isHost']);
      if (typeof player.name !== 'string' || player.name.trim().length === 0 || player.name.length > 32 ||
          (player.suspect !== null && !isSuspect(player.suspect)) || typeof player.isHost !== 'boolean') {
        throw new Error(`invalid lobby player at index ${index}`);
      }
      return { name: player.name, suspect: player.suspect, isHost: player.isHost };
    }),
  };
}

function validateViewPlayer(value: unknown, index: number): GameView['players'][number] {
  const player = requireObject(value, `view player at index ${index}`);
  requireKeys(player, [
    'name', 'suspect', 'location', 'handCount', 'failedAccusation', 'guessedHere', 'isRobot',
    'movedBySuggestion',
  ], 'view player');
  const guessedHere = player.guessedHere;
  if (typeof player.name !== 'string' || player.name.length === 0 || player.name.length > 32 ||
      !isSuspect(player.suspect) || !isLocation(player.location) ||
      !isBoundedInteger(player.handCount, 0, MAX_CARDS) || typeof player.failedAccusation !== 'boolean' ||
      typeof guessedHere !== 'boolean' || typeof player.isRobot !== 'boolean' ||
      typeof player.movedBySuggestion !== 'boolean') {
    throw new Error(`invalid view player at index ${index}`);
  }
  const result: GameView['players'][number] = {
    name: player.name,
    suspect: player.suspect,
    location: player.location,
    handCount: player.handCount,
    failedAccusation: player.failedAccusation,
    guessedHere,
    isRobot: player.isRobot,
    movedBySuggestion: player.movedBySuggestion,
  };
  return result;
}

function validateWeaponLocations(value: unknown): GameView['weaponLocations'] {
  if (!Array.isArray(value) || value.length > MAX_PLAYERS) throw new Error('invalid weapon locations');
  return value.map((raw, index) => {
    const location = requireObject(raw, `weapon location at index ${index}`);
    requireKeys(location, ['weapon', 'location']);
    if (!isWeapon(location.weapon) || !isLocation(location.location)) {
      throw new Error(`invalid weapon location at index ${index}`);
    }
    return { weapon: location.weapon, location: location.location };
  });
}

function validatePendingReveal(value: unknown, playerCount: number): GameView['pendingReveal'] {
  if (value === null) return null;
  const pending = requireObject(value, 'pending reveal');
  requireKeys(pending, ['suggesterIndex', 'suspect', 'weapon', 'room', 'revealerIndex']);
  if (!isSuspect(pending.suspect) || !isWeapon(pending.weapon) || !isRoom(pending.room)) {
    throw new Error('invalid pending reveal cards');
  }
  return {
    suggesterIndex: requireIndex(pending.suggesterIndex, playerCount, 'suggester index'),
    suspect: pending.suspect,
    weapon: pending.weapon,
    room: pending.room,
    revealerIndex: requireIndex(pending.revealerIndex, playerCount, 'revealer index'),
  };
}

function validateCards(value: unknown, label: string): Card[] {
  if (!Array.isArray(value) || value.length > MAX_CARDS) throw new Error(`invalid ${label}`);
  return value.map((card, index) => validateCard(card, `${label} card at index ${index}`));
}

function validateCard(value: unknown, label: string): Card {
  if (!isCard(value)) throw new Error(`invalid ${label}`);
  switch (value.type) {
    case 'suspect': return { type: 'suspect', suspect: value.suspect };
    case 'weapon': return { type: 'weapon', weapon: value.weapon };
    case 'room': return { type: 'room', room: value.room };
  }
}

function validateEvent(value: unknown, index: number, playerCount: number): Event {
  const event = requireObject(value, `event at index ${index}`);
  if (typeof event.type !== 'string') throw new Error(`invalid event at index ${index}`);
  switch (event.type) {
    case 'rolled':
      requireKeys(event, ['type', 'playerIndex', 'result']);
      if (!isBoundedInteger(event.result, 2, 12)) throw new Error(`invalid rolled event at index ${index}`);
      return { type: 'rolled', playerIndex: requireIndex(event.playerIndex, playerCount, 'event player index'), result: event.result };
    case 'moved':
      requireKeys(event, ['type', 'playerIndex', 'destination']);
      return { type: 'moved', playerIndex: requireIndex(event.playerIndex, playerCount, 'event player index'), destination: validateLocation(event.destination, 'event destination') };
    case 'usedSecretPassage':
      requireKeys(event, ['type', 'playerIndex', 'to']);
      if (!isRoom(event.to)) throw new Error(`invalid passage event at index ${index}`);
      return { type: 'usedSecretPassage', playerIndex: requireIndex(event.playerIndex, playerCount, 'event player index'), to: event.to };
    case 'suggested':
      requireKeys(event, ['type', 'playerIndex', 'suspect', 'weapon', 'room']);
      if (!isSuspect(event.suspect) || !isWeapon(event.weapon) || !isRoom(event.room)) {
        throw new Error(`invalid suggested event at index ${index}`);
      }
      return { type: 'suggested', playerIndex: requireIndex(event.playerIndex, playerCount, 'event player index'), suspect: event.suspect, weapon: event.weapon, room: event.room };
    case 'revealRequested':
      requireKeys(event, ['type', 'revealerIndex']);
      return { type: 'revealRequested', revealerIndex: requireIndex(event.revealerIndex, playerCount, 'event revealer index') };
    case 'revealed':
      requireKeys(event, ['type', 'revealerIndex', 'cardHint']);
      if (event.cardHint !== 'private') throw new Error(`invalid revealed event at index ${index}`);
      return { type: 'revealed', revealerIndex: requireIndex(event.revealerIndex, playerCount, 'event revealer index'), cardHint: 'private' };
    case 'declinedReveal':
      requireKeys(event, ['type', 'revealerIndex']);
      return { type: 'declinedReveal', revealerIndex: requireIndex(event.revealerIndex, playerCount, 'event revealer index') };
    case 'accused':
      requireKeys(event, ['type', 'playerIndex', 'correct']);
      if (typeof event.correct !== 'boolean') throw new Error(`invalid accused event at index ${index}`);
      return { type: 'accused', playerIndex: requireIndex(event.playerIndex, playerCount, 'event player index'), correct: event.correct };
    case 'turnEnded':
      requireKeys(event, ['type', 'playerIndex']);
      return { type: 'turnEnded', playerIndex: requireIndex(event.playerIndex, playerCount, 'event player index') };
    case 'gameWon':
      requireKeys(event, ['type', 'playerIndex']);
      return { type: 'gameWon', playerIndex: requireIndex(event.playerIndex, playerCount, 'event player index') };
    default:
      throw new Error(`unknown event type: ${event.type}`);
  }
}

function validateLocation(value: unknown, label: string): Room | CellId {
  if (isRoom(value) || (typeof value === 'string' && CELL_ID.test(value))) return value as Room | CellId;
  throw new Error(`invalid ${label}`);
}

function isLocation(value: unknown): value is Room | CellId {
  return isRoom(value) || (typeof value === 'string' && CELL_ID.test(value));
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(
  value: Record<string, unknown>,
  required: string[],
  label = 'object',
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.has(key))) throw new Error(`invalid ${label} fields`);
  if (required.some(key => !Object.hasOwn(value, key))) throw new Error(`invalid ${label} fields`);
}

function requireIndex(value: unknown, playerCount: number, label: string): number {
  if (!isBoundedInteger(value, 0, playerCount - 1)) throw new Error(`invalid ${label}`);
  return value;
}

function optionalIndex(value: unknown, playerCount: number, label: string): number | null {
  if (value === null) return null;
  return requireIndex(value, playerCount, label);
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`invalid ${label}`);
  return value;
}

function invalid(error: string): ParseResult {
  return { ok: false, error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'invalid server frame';
}
