export const SUSPECTS = ['Miss Scarlett', 'Professor Plum', 'Mrs. Peacock',
                        'Colonel Mustard', 'Mr. Green', 'Mrs. White'] as const;
export type Suspect = typeof SUSPECTS[number];

export const WEAPONS = ['Candlestick', 'Dagger', 'Lead Pipe',
                        'Revolver', 'Rope', 'Wrench'] as const;
export type Weapon = typeof WEAPONS[number];

export const ROOMS = ['Ballroom', 'Billiard Room', 'Conservatory', 'Dining Room',
                      'Hall', 'Kitchen', 'Library', 'Lounge', 'Study'] as const;
export type Room = typeof ROOMS[number];

export type Card =
  | { type: 'suspect'; suspect: Suspect }
  | { type: 'weapon'; weapon: Weapon }
  | { type: 'room'; room: Room };

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
  solution: { suspect: Card; weapon: Card; room: Card } | null;
  board: BoardSpace[][];            // [24][25] like clue.py:114
  phase: Phase;
  turnIndex: number;
  weapons: WeaponPiece[];          // each weapon starts on a valid board cell
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
