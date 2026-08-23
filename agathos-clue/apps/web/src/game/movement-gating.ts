import type { GameView } from '@agathos/game';
import type { BoardLocation } from './BoardRenderer';
import { actionsFor } from './intent-gating';

/** Movement clicks are authorized only by a present, non-empty server hint list. */
export function canClickMove(view: GameView | null, destination: BoardLocation): boolean {
  const hints = view?.reachableSpacesHints;
  return actionsFor(view).canMove && hints !== undefined && hints.length > 0 && hints.includes(destination);
}
