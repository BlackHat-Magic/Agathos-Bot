import { BOARD_HEIGHT, BOARD_WIDTH } from './board';
import type { BoardSpace, Card, CellId, Game, GameView, Room } from './types';

function projectLocation(location: BoardSpace): Room | CellId {
  if (location.room) return location.room;
  if (location.pos) return `${location.pos[0]},${location.pos[1]}`;
  throw new Error('cannot project a board location without a room or cell position');
}

function cloneCard<T extends Card>(card: T): T {
  return { ...card };
}

function matchesPendingReveal(card: Card, pending: NonNullable<Game['pendingReveal']>): boolean {
  return (
    (card.type === 'suspect' && card.suspect === pending.suspect) ||
    (card.type === 'weapon' && card.weapon === pending.weapon) ||
    (card.type === 'room' && card.room === pending.room)
  );
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

  const viewer = game.players[viewerIndex]!;
  const pendingReveal = game.pendingReveal
    ? { ...game.pendingReveal }
    : null;

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

  if (game.phase === 'finished' && game.solution) {
    view.solution = {
      suspect: cloneCard(game.solution.suspect),
      weapon: cloneCard(game.solution.weapon),
      room: cloneCard(game.solution.room),
    };
  }

  return view;
}
