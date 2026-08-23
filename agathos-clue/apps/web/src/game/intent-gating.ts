import type { GameView } from '@agathos/game';

export interface TurnActions {
  myTurn: boolean;
  failedAccusation: boolean;
  canRoll: boolean;
  canUseSecretPassage: boolean;
  canSuggest: boolean;
  canAccuse: boolean;
  canEndTurn: boolean;
  canMove: boolean;
}

export function actionsFor(view: GameView | null): TurnActions {
  const player = view === null ? undefined : view.players[view.myIndex];
  const myTurn = view?.phase === 'playing' && view.turnIndex === view.myIndex &&
    view.pendingReveal === null;
  const failedAccusation = player?.failedAccusation ?? false;
  const hasRolled = view === null ? false : view.hasRolledThisTurn ?? view.lastDieRoll !== null;
  const hasMoved = view?.hasMovedThisTurn ?? false;
  const movementAvailable = myTurn && !failedAccusation &&
    hasRolled && !hasMoved;

  return {
    myTurn,
    failedAccusation,
    canRoll: myTurn && !failedAccusation && player?.guessedHere === false && !hasRolled && !hasMoved,
    canUseSecretPassage: myTurn && !failedAccusation &&
      player?.guessedHere === false && view?.canUseSecretPassage === true && !hasRolled && !hasMoved,
    canSuggest: myTurn && !failedAccusation && player?.guessedHere === false && view?.canSuggest === true,
    canAccuse: myTurn && !failedAccusation,
    canEndTurn: myTurn,
    canMove: movementAvailable && player?.guessedHere === false,
  };
}
