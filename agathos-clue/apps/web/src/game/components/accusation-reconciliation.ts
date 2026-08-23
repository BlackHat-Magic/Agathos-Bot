import type { GameView, Phase } from '@agathos/game';

export interface AccusationBaseline {
  phase: Phase;
  failedAccusation: boolean;
}

export function shouldCloseAfterAccusation(
  view: GameView,
  baseline: AccusationBaseline,
): boolean {
  const viewer = view.players[view.myIndex];
  const failedAccusationAccepted = viewer?.failedAccusation === true && !baseline.failedAccusation;
  const correctAccusationAccepted = view.phase === 'finished' && baseline.phase !== 'finished';
  return failedAccusationAccepted || correctAccusationAccepted;
}
