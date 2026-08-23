export const SUSPECTS = ['Miss Scarlett', 'Professor Plum', 'Mrs. Peacock',
                        'Colonel Mustard', 'Mr. Green', 'Mrs. White'] as const;
export type Suspect = typeof SUSPECTS[number];

export const WEAPONS = ['Candlestick', 'Dagger', 'Lead Pipe',
                        'Revolver', 'Rope', 'Wrench'] as const;
export type Weapon = typeof WEAPONS[number];

export const ROOMS = ['Ballroom', 'Billiard Room', 'Conservatory', 'Dining Room',
                      'Hall', 'Kitchen', 'Library', 'Lounge', 'Study'] as const;
export type Room = typeof ROOMS[number];

export function isSuspect(value: unknown): value is Suspect {
  return typeof value === 'string' && (SUSPECTS as readonly string[]).includes(value);
}

export function isWeapon(value: unknown): value is Weapon {
  return typeof value === 'string' && (WEAPONS as readonly string[]).includes(value);
}

export function isRoom(value: unknown): value is Room {
  return typeof value === 'string' && (ROOMS as readonly string[]).includes(value);
}

export type SuspectCard = { type: 'suspect'; suspect: Suspect };
export type WeaponCard = { type: 'weapon'; weapon: Weapon };
export type RoomCard = { type: 'room'; room: Room };
export type Card = SuspectCard | WeaponCard | RoomCard;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCard(value: unknown): value is Card {
  if (!isRecord(value)) return false;
  if (value.type === 'suspect') return isSuspect(value.suspect);
  if (value.type === 'weapon') return isWeapon(value.weapon);
  if (value.type === 'room') return isRoom(value.room);
  return false;
}

export function assertCard(value: unknown, label = 'card'): asserts value is Card {
  if (!isRecord(value)) throw new Error(`invalid ${label}: expected an object`);
  if (value.type !== 'suspect' && value.type !== 'weapon' && value.type !== 'room') {
    throw new Error(`invalid ${label} type: ${String(value.type)}`);
  }
  const valid = value.type === 'suspect'
    ? isSuspect(value.suspect)
    : value.type === 'weapon'
      ? isWeapon(value.weapon)
      : isRoom(value.room);
  if (!valid) {
    const field = value.type;
    throw new Error(`invalid ${label} ${field}: ${String(value[field])}`);
  }
}
export interface Solution {
  suspect: SuspectCard;
  weapon: WeaponCard;
  room: RoomCard;
}

function isSolutionCard(
  value: unknown,
  type: 'suspect' | 'weapon' | 'room',
  isValue: (value: unknown) => boolean,
): boolean {
  if (!isRecord(value) || value.type !== type) return false;
  const field = type;
  return isValue(value[field]);
}

export function isSolution(value: unknown): value is Solution {
  return isRecord(value) &&
    isSolutionCard(value.suspect, 'suspect', isSuspect) &&
    isSolutionCard(value.weapon, 'weapon', isWeapon) &&
    isSolutionCard(value.room, 'room', isRoom);
}

/** Validate and detach a solution while enforcing each slot's card category. */
export function cloneSolution(value: unknown, label = 'solution'): Solution {
  if (!isSolution(value)) throw new Error(`invalid ${label}`);
  return {
    suspect: { type: 'suspect', suspect: value.suspect.suspect },
    weapon: { type: 'weapon', weapon: value.weapon.weapon },
    room: { type: 'room', room: value.room.room },
  };
}

export type CellId = string;           // `${col},${row}` format
export type BoardSpaceId = CellId | Room;  // rooms are their own id

export interface BoardSpace {
  room: Room | null;
  pos: [number, number] | null;
  accesses: BoardSpace[];
}

export interface SuspectPiece {
  suspect: Suspect;
  location: BoardSpace;
}
export interface WeaponPiece {
  weapon: Weapon;
  location: BoardSpace;
}
export type GamePiece = SuspectPiece | WeaponPiece;

export interface Player {
  name: string;
  /** Canonical array offset in Game.players. */
  index: number;
  suspect: Suspect;
  piece: SuspectPiece;
  cards: Card[];
  failedAccusation: boolean;
  guessedHere: boolean;
  movedBySuggestion: boolean;
  enteredRoomThisTurn: boolean;
  isRobot: boolean;
  userId?: string;    // for humans
}

export type Phase = 'lobby' | 'playing' | 'finished';

export interface Game {
  players: Player[];
  solution: Solution | null;
  board: BoardSpace[][];            // [24][25] like clue.py:114
  phase: Phase;
  turnIndex: number;
  weapons: WeaponPiece[];          // each weapon starts in a canonical room
  pendingReveal: {
    suggesterIndex: number;
    suspect: Suspect; weapon: Weapon; room: Room;
    revealerIndex: number;
  } | null;
  lastDieRoll: number | null;
  hasRolledThisTurn: boolean;
  hasMovedThisTurn: boolean;
  winnerIndex: number | null;
  finishedAt: number | null;
}

export interface GameView {
  phase: Phase;
  boardWidth: number;
  boardHeight: number;
  players: Array<{
    name: string;
    suspect: Suspect;
    location: Room | CellId;
    handCount: number;
    failedAccusation: boolean;
    isRobot: boolean;
    movedBySuggestion: boolean;
    userId?: string;
  }>;
  weaponLocations: Array<{
    weapon: Weapon;
    location: Room | CellId;
  }>;
  turnIndex: number;
  winnerIndex: number | null;
  pendingReveal: {
    suggesterIndex: number;
    suspect: Suspect;
    weapon: Weapon;
    room: Room;
    revealerIndex: number;
  } | null;
  lastDieRoll: number | null;
  /** Turn state is public and lets clients gate controls without guessing. */
  hasRolledThisTurn?: boolean;
  hasMovedThisTurn?: boolean;
  canSuggest?: boolean;
  canUseSecretPassage?: boolean;
  myIndex: number;
  myHand: Card[];
  myRevealOpportunities?: Card[];
  /**
   * Reserved for Task 16/private server event handling. Intentionally omitted
   * by the current toView because Game does not own this state yet; no card is
   * fabricated or leaked.
   */
  myLastShownCard?: Card;
  /**
   * Reserved for Task 16/private server event handling. Intentionally omitted
   * by the current toView because Game does not own this state yet; no card is
   * fabricated or leaked.
   */
  lastSuggestionReveal?: { fromIndex: number; card: Card };
  /**
   * Reserved for Task 16/private server event handling. Intentionally omitted
   * by the current toView because Game does not own this state yet.
   */
  reachableSpacesHints?: Array<Room | CellId>;
  solution?: Solution;
}

export const STARTING_POSITIONS: Record<Suspect, [number, number]> = {
  'Miss Scarlett': [16, 24],
  'Professor Plum': [0, 19],
  'Mrs. Peacock': [0, 6],
  'Colonel Mustard': [23, 17],
  'Mr. Green': [9, 0],
  'Mrs. White': [14, 0],
};

export type Intent =
  /** Internal server-side scheduler signal; not a public gameplay action. */
  | { kind: 'wait' }
  | { kind: 'join'; userId: string; name: string }
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
