import { BOARD_HEIGHT, BOARD_WIDTH } from './board';
import { cardMatchesSuggestion, clonePendingReveal } from './rules';
import {
  assertCard, cloneSolution,
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
