import {
  isRoom,
  isSuspect,
  isWeapon,
} from '@agathos/game';
import type {
  Card,
  CellId,
  Room,
  Suspect,
  Weapon,
} from '@agathos/game';

export type ClientIntent =
  | { kind: 'join'; name: string }
  | { kind: 'claimSuspect'; suspect: Suspect }
  | { kind: 'start' }
  | { kind: 'setOrder'; order: Suspect[] }
  | { kind: 'useSecretPassage' }
  | { kind: 'roll' }
  | { kind: 'moveTo'; destination: Room | CellId }
  | { kind: 'suggest'; suspect: Suspect; weapon: Weapon }
  | { kind: 'showCard'; card: Card }
  | { kind: 'declineReveal' }
  | { kind: 'accuse'; suspect: Suspect; weapon: Weapon; room: Room }
  | { kind: 'endTurn' }
  | { kind: 'leave' };

export type Intent = ClientIntent;
export type ClientIntentKind = ClientIntent['kind'];

const CLIENT_INTENT_KINDS = new Set<ClientIntentKind>([
  'join', 'claimSuspect', 'start', 'setOrder', 'useSecretPassage', 'roll', 'moveTo',
  'suggest', 'showCard', 'declineReveal', 'accuse', 'endTurn', 'leave',
]);

export function isClientIntentKind(value: unknown): value is ClientIntentKind {
  return typeof value === 'string' && CLIENT_INTENT_KINDS.has(value as ClientIntentKind);
}

export function createJoinIntent(name: string): Extract<ClientIntent, { kind: 'join' }> {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (trimmedName.length === 0) {
    throw new TypeError('join name must be a non-empty string');
  }
  return { kind: 'join', name: trimmedName };
}

export function createClaimSuspectIntent(
  suspect: Suspect,
): Extract<ClientIntent, { kind: 'claimSuspect' }> {
  requireSuspect(suspect);
  return { kind: 'claimSuspect', suspect };
}

export function createStartIntent(): Extract<ClientIntent, { kind: 'start' }> {
  return { kind: 'start' };
}

export function createSetOrderIntent(
  order: readonly Suspect[],
): Extract<ClientIntent, { kind: 'setOrder' }> {
  if (!Array.isArray(order)) {
    throw new TypeError('order must be an array');
  }
  const copied = [...order];
  const seen = new Set<Suspect>();
  for (const suspect of copied) {
    requireSuspect(suspect);
    if (seen.has(suspect)) throw new TypeError(`duplicate suspect in order: ${suspect}`);
    seen.add(suspect);
  }
  return { kind: 'setOrder', order: copied };
}

export function createUseSecretPassageIntent(): Extract<ClientIntent, { kind: 'useSecretPassage' }> {
  return { kind: 'useSecretPassage' };
}

export function createRollIntent(): Extract<ClientIntent, { kind: 'roll' }> {
  return { kind: 'roll' };
}

export function createMoveToIntent(
  destination: Room | CellId,
): Extract<ClientIntent, { kind: 'moveTo' }> {
  if (!isRoom(destination) && !isCellId(destination)) {
    throw new TypeError('destination must be a room or board cell');
  }
  return { kind: 'moveTo', destination };
}

export function createSuggestIntent(
  suspect: Suspect,
  weapon: Weapon,
): Extract<ClientIntent, { kind: 'suggest' }> {
  requireSuspect(suspect);
  requireWeapon(weapon);
  return { kind: 'suggest', suspect, weapon };
}

export function createShowCardIntent(card: Card): Extract<ClientIntent, { kind: 'showCard' }> {
  if (!isCard(card)) throw new TypeError('card is invalid');
  return { kind: 'showCard', card: cloneCard(card) };
}

export function createDeclineRevealIntent(): Extract<ClientIntent, { kind: 'declineReveal' }> {
  return { kind: 'declineReveal' };
}

export function createAccuseIntent(
  suspect: Suspect,
  weapon: Weapon,
  room: Room,
): Extract<ClientIntent, { kind: 'accuse' }> {
  requireSuspect(suspect);
  requireWeapon(weapon);
  if (!isRoom(room)) throw new TypeError('room is invalid');
  return { kind: 'accuse', suspect, weapon, room };
}

export function createEndTurnIntent(): Extract<ClientIntent, { kind: 'endTurn' }> {
  return { kind: 'endTurn' };
}

export function createLeaveIntent(): Extract<ClientIntent, { kind: 'leave' }> {
  return { kind: 'leave' };
}

function requireSuspect(value: unknown): asserts value is Suspect {
  if (!isSuspect(value)) throw new TypeError('suspect is invalid');
}

function requireWeapon(value: unknown): asserts value is Weapon {
  if (!isWeapon(value)) throw new TypeError('weapon is invalid');
}

function isCellId(value: unknown): value is CellId {
  return typeof value === 'string' && /^\d+,\d+$/.test(value);
}

function isCard(value: unknown): value is Card {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  if (card.type === 'suspect') return isSuspect(card.suspect);
  if (card.type === 'weapon') return isWeapon(card.weapon);
  return card.type === 'room' && isRoom(card.room);
}

function cloneCard(card: Card): Card {
  switch (card.type) {
    case 'suspect': return { type: 'suspect', suspect: card.suspect };
    case 'weapon': return { type: 'weapon', weapon: card.weapon };
    case 'room': return { type: 'room', room: card.room };
  }
}

// Short creator names keep UI event handlers readable while the create* names
// remain explicit for callers that prefer them.
export const join = createJoinIntent;
export const claimSuspect = createClaimSuspectIntent;
export const start = createStartIntent;
export const setOrder = createSetOrderIntent;
export const passage = createUseSecretPassageIntent;
export const useSecretPassage = createUseSecretPassageIntent;
export const roll = createRollIntent;
export const moveTo = createMoveToIntent;
export const suggest = createSuggestIntent;
export const showCard = createShowCardIntent;
export const decline = createDeclineRevealIntent;
export const declineReveal = createDeclineRevealIntent;
export const accuse = createAccuseIntent;
export const endTurn = createEndTurnIntent;
export const leave = createLeaveIntent;
