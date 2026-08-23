import { BOARD_HEIGHT, BOARD_WIDTH } from './board';
import { cardMatchesSuggestion } from './rules';
import {
  assertCard, cloneSolution, isRoom, isSuspect, isWeapon,
} from './types';
import type {
  BoardSpace, Card, CellId, Game, GameView, Room, RoomCard, SuspectCard, WeaponCard,
} from './types';

function projectLocation(location: BoardSpace): Room | CellId {
  if (location.room) return location.room;
  if (location.pos) return `${location.pos[0]},${location.pos[1]}`;
  throw new Error('cannot project a board location without a room or cell position');
}

function cloneCard(card: SuspectCard): SuspectCard;
function cloneCard(card: WeaponCard): WeaponCard;
function cloneCard(card: RoomCard): RoomCard;
function cloneCard(card: Card): Card;
function cloneCard(card: unknown): Card {
  assertCard(card);
  switch (card.type) {
    case 'suspect': return { type: 'suspect', suspect: card.suspect };
    case 'weapon': return { type: 'weapon', weapon: card.weapon };
    case 'room': return { type: 'room', room: card.room };
  }
}

function matchesPendingReveal(card: Card, pending: NonNullable<Game['pendingReveal']>): boolean {
  return cardMatchesSuggestion(card, pending);
}

function clonePendingReveal(
  value: unknown,
  playerCount: number,
): NonNullable<Game['pendingReveal']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid pending reveal metadata: expected an object');
  }
  const pending = value as Record<string, unknown>;
  const expectedKeys = ['revealerIndex', 'room', 'suggesterIndex', 'suspect', 'weapon'];
  for (const key of Reflect.ownKeys(pending)) {
    if (typeof key !== 'string' || !expectedKeys.includes(key)) {
      throw new Error(`invalid pending reveal metadata key: ${String(key)}`);
    }
  }

  const suggesterIndex = pending.suggesterIndex;
  if (typeof suggesterIndex !== 'number' || !Number.isInteger(suggesterIndex) ||
      suggesterIndex < 0 || suggesterIndex >= playerCount) {
    throw new Error(`invalid pending reveal suggester index: ${String(suggesterIndex)}`);
  }
  const revealerIndex = pending.revealerIndex;
  if (typeof revealerIndex !== 'number' || !Number.isInteger(revealerIndex) ||
      revealerIndex < 0 || revealerIndex >= playerCount) {
    throw new Error(`invalid pending reveal revealer index: ${String(revealerIndex)}`);
  }
  if (!isSuspect(pending.suspect)) {
    throw new Error(`invalid pending reveal suspect: ${String(pending.suspect)}`);
  }
  if (!isWeapon(pending.weapon)) {
    throw new Error(`invalid pending reveal weapon: ${String(pending.weapon)}`);
  }
  if (!isRoom(pending.room)) {
    throw new Error(`invalid pending reveal room: ${String(pending.room)}`);
  }

  return {
    suggesterIndex,
    suspect: pending.suspect,
    weapon: pending.weapon,
    room: pending.room,
    revealerIndex,
  };
}

function requireWinnerIndex(value: unknown, playerCount: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= playerCount) {
    throw new Error(`invalid winner index: ${String(value)}`);
  }
  return value;
}

/**
 * Projects server-owned game state into the redacted view for one player.
 *
 * `viewerIndex` must be resolved from trusted server-side connection identity
 * and must never be accepted directly from an untrusted client.
 */
export function toView(game: Game, viewerIndex: number): GameView {
  if (!Number.isInteger(viewerIndex) || viewerIndex < 0 || viewerIndex >= game.players.length) {
    throw new Error(`invalid viewer index: ${viewerIndex}`);
  }

  let finishedSolution: GameView['solution'];
  if (game.phase === 'finished') {
    if (game.solution === null || game.solution === undefined) {
      throw new Error('cannot project finished game without a valid game solution');
    }
    finishedSolution = cloneSolution(game.solution, 'game solution');
  }

  const viewer = game.players[viewerIndex]!;
  const pendingReveal = game.pendingReveal === null
    ? null
    : clonePendingReveal(game.pendingReveal, game.players.length);
  const winnerIndex = requireWinnerIndex(game.winnerIndex, game.players.length);

  const view: GameView = {
    phase: game.phase,
    boardWidth: BOARD_WIDTH,
    boardHeight: BOARD_HEIGHT,
    players: game.players.map(player => ({
      name: player.name,
      suspect: player.suspect,
      location: projectLocation(player.piece.location),
      handCount: player.cards.length,
      failedAccusation: player.failedAccusation,
      isRobot: player.isRobot,
      movedBySuggestion: player.movedBySuggestion,
      ...(player.userId === undefined ? {} : { userId: player.userId }),
    })),
    weaponLocations: game.weapons.map(weapon => ({
      weapon: weapon.weapon,
      location: projectLocation(weapon.location),
    })),
    turnIndex: game.turnIndex,
    winnerIndex,
    pendingReveal,
    lastDieRoll: game.lastDieRoll,
    myIndex: viewerIndex,
    myHand: viewer.cards.map(cloneCard),
  };

  if (pendingReveal?.revealerIndex === viewerIndex) {
    view.myRevealOpportunities = viewer.cards
      .filter(card => matchesPendingReveal(card, pendingReveal))
      .map(cloneCard);
  }

  if (finishedSolution !== undefined) view.solution = finishedSolution;

  return view;
}
