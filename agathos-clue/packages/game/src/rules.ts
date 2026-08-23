import type { Card, Game, Player, Room, Solution, Suspect, SuspectCard, Weapon, WeaponCard, RoomCard } from './types';
import { isCard, isRoom, isSuspect, isWeapon, SUSPECTS, WEAPONS, ROOMS } from './types';
import { buildBoard, spaceAt, suspectStart } from './board';

type RNG = () => number;

function shuffle<T>(arr: T[], rng: RNG = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick<T>(arr: T[], rng: RNG): T {
  return arr[Math.floor(rng() * arr.length)];
}

function canonicalLocation(game: Game, player: Player) {
  const source = player.piece.location;
  if (source.room) {
    for (const column of game.board) {
      for (const space of column) {
        if (space.room === source.room) return space;
      }
    }
    throw new Error(`room is not on the board: ${source.room}`);
  }
  if (source.pos) return spaceAt(game.board, ...source.pos);
  throw new Error('player location is not a room or board cell');
}

/** Create a game whose player indexes are always their Game.players offsets. */
export function createGame(players: Player[]): Game {
  const game: Game = {
    players,
    solution: null,
    board: buildBoard(),
    phase: 'lobby',
    turnIndex: 0,
    weapons: [],
    pendingReveal: null,
    lastDieRoll: null,
    hasRolledThisTurn: false,
    hasMovedThisTurn: false,
    winnerIndex: null,
    finishedAt: null,
  };

  for (const [index, player] of game.players.entries()) {
    player.index = index;
    player.piece.location = canonicalLocation(game, player);
    player.enteredRoomThisTurn = false;
  }
  return game;
}

export function begin(game: Game, rng: RNG = Math.random): void {
  if (game.players.length === 0) {
    throw new Error('cannot begin a game without players');
  }

  const seenSuspects = new Set<string>();
  for (const player of game.players) {
    if (!(SUSPECTS as readonly string[]).includes(player.suspect)) {
      throw new Error(`invalid suspect: ${player.suspect}`);
    }
    if (seenSuspects.has(player.suspect)) {
      throw new Error(`duplicate suspect: ${player.suspect}`);
    }
    seenSuspects.add(player.suspect);
  }

  game.players.forEach((player, index) => { player.index = index; });
  for (const player of game.players) {
    player.piece.location = suspectStart(player.suspect, game.board);
    player.cards = [];
    player.failedAccusation = false;
    player.guessedHere = false;
    player.movedBySuggestion = false;
    player.enteredRoomThisTurn = false;
  }
  game.pendingReveal = null;
  game.lastDieRoll = null;
  game.hasRolledThisTurn = false;
  game.hasMovedThisTurn = false;
  game.winnerIndex = null;
  game.finishedAt = null;

  const suspectCards: SuspectCard[] = SUSPECTS.map(suspect => ({ type: 'suspect', suspect }));
  const weaponCards: WeaponCard[] = WEAPONS.map(weapon => ({ type: 'weapon', weapon }));
  const roomCards: RoomCard[] = ROOMS.map(room => ({ type: 'room', room }));

  const s = pick(suspectCards, rng);
  const w = pick(weaponCards, rng);
  const r = pick(roomCards, rng);
  game.solution = { suspect: s, weapon: w, room: r };

  const remaining = shuffle(
    [
      ...suspectCards.filter(c => c !== s),
      ...weaponCards.filter(c => c !== w),
      ...roomCards.filter(c => c !== r),
    ],
    rng,
  );

  game.weapons = WEAPONS.map(weapon => ({
    weapon,
    // placeholder; actual placement happens during suggest (Task 11). (0,0) is
    // not a valid cell on this board, so use a known-valid starting cell.
    location: spaceAt(game.board, 16, 24),
  }));

  let i = 0;
  while (remaining.length) {
    game.players[i % game.players.length].cards.push(remaining.shift()!);
    i++;
  }
  game.phase = 'playing';
  game.turnIndex = 0;
}

export interface SuggestionResult {
  /** Player index who must reveal, or null if no player has any matching card. */
  revealerIndex: number | null;
  /**
   * The first matching card found in the revealer's hand, or null if none.
   * This is a HINT for who-can-reveal and what cards qualify; the actual
   * revealed card is chosen by the player (via `showCard` intent — Task 11)
   * or, for robots, by the robot policy in Task 10's `decideRobotIntent`
   * (which may pick a different matching card).
   */
  card: Card | null;
}

export type SuggestionGuess = { suspect: Suspect; weapon: Weapon; room: Room };

function requireGuess(value: unknown, label: 'suggestion' | 'accusation'): SuggestionGuess {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`invalid ${label}: expected an object`);
  }
  const guess = value as Record<string, unknown>;
  if (!isSuspect(guess.suspect)) throw new Error(`invalid suspect: ${String(guess.suspect)}`);
  if (!isWeapon(guess.weapon)) throw new Error(`invalid weapon: ${String(guess.weapon)}`);
  if (!isRoom(guess.room)) throw new Error(`invalid room: ${String(guess.room)}`);
  return { suspect: guess.suspect, weapon: guess.weapon, room: guess.room };
}

/** Value-based card matching shared by advisory queries and sequential reveals. */
export function cardMatchesSuggestion(card: unknown, guess: SuggestionGuess): card is Card {
  if (!isCard(card)) return false;
  return (
    (card.type === 'suspect' && card.suspect === guess.suspect) ||
    (card.type === 'weapon' && card.weapon === guess.weapon) ||
    (card.type === 'room' && card.room === guess.room)
  );
}

/**
 * Advisory query: skips players without a matching card to identify the first
 * possible revealer. The reducer instead advances sequentially through every
 * reveal opportunity, including players who must decline.
 */
export function resolveSuggestion(
  game: Game,
  suggesterIndex: number,
  guess: { suspect: Suspect; weapon: Weapon; room: Room },
): SuggestionResult {
  if (!Number.isInteger(suggesterIndex) || suggesterIndex < 0 || suggesterIndex >= game.players.length) {
    throw new Error(`invalid suggester index: ${String(suggesterIndex)}`);
  }
  const validGuess = requireGuess(guess, 'suggestion');
  const n = game.players.length;
  for (let off = 1; off < n; off++) {
    const idx = (suggesterIndex + off) % n;
    const candidate = game.players[idx].cards.find(c => cardMatchesSuggestion(c, validGuess));
    if (candidate) {
      const card: Card = candidate.type === 'suspect'
        ? { type: 'suspect', suspect: candidate.suspect }
        : candidate.type === 'weapon'
          ? { type: 'weapon', weapon: candidate.weapon }
          : { type: 'room', room: candidate.room };
      return { revealerIndex: idx, card };
    }
  }
  return { revealerIndex: null, card: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidSolutionCard(
  value: unknown,
  type: 'suspect' | 'weapon' | 'room',
  field: 'suspect' | 'weapon' | 'room',
  validValues: readonly string[],
): boolean {
  return isRecord(value) && value.type === type &&
    typeof value[field] === 'string' && validValues.includes(value[field]);
}

function isValidSolution(value: unknown): value is Solution {
  return (
    isRecord(value) &&
    isValidSolutionCard(value.suspect, 'suspect', 'suspect', SUSPECTS) &&
    isValidSolutionCard(value.weapon, 'weapon', 'weapon', WEAPONS) &&
    isValidSolutionCard(value.room, 'room', 'room', ROOMS)
  );
}

export function requireAccusationSolution(game: Game): Solution {
  const solution: unknown = game.solution;
  if (solution === null || solution === undefined) {
    throw new Error('cannot evaluate accusation without a game solution');
  }
  if (!isValidSolution(solution)) {
    throw new Error('invalid game solution');
  }
  return {
    suspect: { type: 'suspect', suspect: solution.suspect.suspect },
    weapon: { type: 'weapon', weapon: solution.weapon.weapon },
    room: { type: 'room', room: solution.room.room },
  };
}

export function evaluateAccusation(
  game: Game,
  playerIndex: number,
  guess: { suspect: Suspect; weapon: Weapon; room: Room },
): boolean {
  if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= game.players.length) {
    throw new Error(`invalid player index: ${String(playerIndex)}`);
  }
  if (game.phase !== 'playing') throw new Error('game is not in the playing phase');
  if (game.turnIndex !== playerIndex) throw new Error(`it is not player ${playerIndex}'s turn`);
  if (game.pendingReveal !== null) throw new Error('a card reveal is pending');
  if (game.players[playerIndex]!.failedAccusation) {
    throw new Error('players with failed accusations may only end their turn');
  }

  const validGuess = requireGuess(guess, 'accusation');
  const sol = requireAccusationSolution(game);
  const ok =
    sol.suspect.suspect === validGuess.suspect &&
    sol.weapon.weapon === validGuess.weapon &&
    sol.room.room === validGuess.room;
  if (ok) {
    game.phase = 'finished';
    game.winnerIndex = playerIndex;
    game.finishedAt = Date.now();
  } else {
    game.players[playerIndex].failedAccusation = true;
    if (game.players.every(p => p.isRobot || p.failedAccusation)) {
      game.phase = 'finished';
      game.finishedAt = Date.now();
    }
  }
  return ok;
}
