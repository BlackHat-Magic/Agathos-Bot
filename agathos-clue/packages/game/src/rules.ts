import type { Card, Game, Player, Room, Suspect, Weapon } from './types';
import { SUSPECTS, WEAPONS, ROOMS } from './types';
import { buildBoard, spaceAt } from './board';

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
  game.players.forEach((player, index) => { player.index = index; });
  for (const player of game.players) {
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

  const suspectCards: Card[] = SUSPECTS.map(suspect => ({ type: 'suspect', suspect }));
  const weaponCards: Card[] = WEAPONS.map(weapon => ({ type: 'weapon', weapon }));
  const roomCards: Card[] = ROOMS.map(room => ({ type: 'room', room }));

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

export function resolveSuggestion(
  game: Game,
  suggesterIndex: number,
  guess: { suspect: Suspect; weapon: Weapon; room: Room },
): SuggestionResult {
  const n = game.players.length;
  for (let off = 1; off < n; off++) {
    const idx = (suggesterIndex + off) % n;
    const candidate = game.players[idx].cards.find(
      c =>
        (c.type === 'suspect' && c.suspect === guess.suspect) ||
        (c.type === 'weapon' && c.weapon === guess.weapon) ||
        (c.type === 'room' && c.room === guess.room),
    );
    if (candidate) return { revealerIndex: idx, card: candidate };
  }
  return { revealerIndex: null, card: null };
}

export function evaluateAccusation(
  game: Game,
  playerIndex: number,
  guess: { suspect: Suspect; weapon: Weapon; room: Room },
): boolean {
  const sol = game.solution!;
  const ok =
    sol.suspect.type === 'suspect' &&
    sol.suspect.suspect === guess.suspect &&
    sol.weapon.type === 'weapon' &&
    sol.weapon.weapon === guess.weapon &&
    sol.room.type === 'room' &&
    sol.room.room === guess.room;
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
