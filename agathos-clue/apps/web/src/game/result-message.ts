import type { GameView } from '@agathos/game';

export function finishedGameMessage(
  view: Pick<GameView, 'winnerIndex' | 'myIndex' | 'players'>,
): string {
  if (view.winnerIndex === null) return 'No detective solved the case.';
  if (view.winnerIndex === view.myIndex) return 'You solved the case.';
  return `${view.players[view.winnerIndex]?.name ?? 'A detective'} solved the case.`;
}
