import {
  applyIntent,
  decideRobotIntent,
} from '@agathos/game';
import type { Event, Game, RNG } from '@agathos/game';

export interface RobotSchedulerOptions<Snapshot> {
  getGame: () => Game;
  snapshot: (game: Game) => Snapshot;
  restore: (snapshot: Snapshot) => void;
  persist: (game: Game) => Promise<void>;
  broadcast: (events: Event[]) => void;
  rng?: RNG;
}

/** Run autonomous actions until a human or an internal wait blocks progress. */
export async function runRobotScheduler<Snapshot>(
  options: RobotSchedulerOptions<Snapshot>,
): Promise<void> {
  while (true) {
    const game = options.getGame();
    const robotIndex = nextRobotIndex(game);
    if (robotIndex === null) return;

    const intent = decideRobotIntent(game, robotIndex, options.rng);
    if (intent.kind === 'wait') return;

    const previous = options.snapshot(game);
    try {
      const events = applyIntent(game, robotIndex, intent, options.rng);
      await options.persist(game);
      options.broadcast(events);
    } catch (error) {
      options.restore(previous);
      throw error;
    }
  }
}

function nextRobotIndex(game: Game): number | null {
  if (game.phase !== 'playing') return null;

  if (game.pendingReveal !== null) {
    const revealer = game.players[game.pendingReveal.revealerIndex];
    return revealer?.isRobot === true ? revealer.index : null;
  }

  const turnPlayer = game.players[game.turnIndex];
  return turnPlayer?.isRobot === true ? turnPlayer.index : null;
}
