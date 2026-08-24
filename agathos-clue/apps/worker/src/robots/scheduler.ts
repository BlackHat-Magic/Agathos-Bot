import {
  applyIntent,
  decideRobotIntent,
} from '@agathos/game';
import type { Card, Event, Game, Intent, RNG } from '@agathos/game';

export interface RobotPrivateReveal {
  recipientIndex: number;
  fromIndex: number;
  card?: Card;
}

export interface RobotSchedulerOptions<Snapshot> {
  getGame: () => Game;
  snapshot: (game: Game) => Snapshot;
  restore: (snapshot: Snapshot) => void;
  persist: (game: Game, privateReveal?: RobotPrivateReveal) => Promise<void>;
  broadcast: (events: Event[], privateReveal?: RobotPrivateReveal) => void;
  onActionPersisted?: () => void;
  /** Observes each applied action so callers can pace phase transitions. */
  onAction?: (intent: Intent) => void;
  rng?: RNG;
  /**
   * Stop after this many persisted actions so callers can pace turns
   * (e.g. one action per alarm tick) instead of bursting a full sweep.
   */
  maxSteps?: number;
}

/** Run autonomous actions until a human, an internal wait, or maxSteps blocks progress. */
export async function runRobotScheduler<Snapshot>(
  options: RobotSchedulerOptions<Snapshot>,
): Promise<void> {
  let steps = 0;
  while (options.maxSteps === undefined || steps < options.maxSteps) {
    const game = options.getGame();
    const robotIndex = currentRobotIndex(game);
    if (robotIndex === null) return;

    const intent = decideRobotIntent(game, robotIndex, options.rng);
    if (intent.kind === 'wait') return;

    const previous = options.snapshot(game);
    const privateReveal = intent.kind === 'showCard' || intent.kind === 'declineReveal'
      ? pendingPrivateReveal(game, robotIndex, intent)
      : undefined;
    try {
      const events = applyIntent(game, robotIndex, intent, options.rng);
      await options.persist(game, privateReveal);
      options.broadcast(events, privateReveal);
      options.onActionPersisted?.();
      options.onAction?.(intent);
      steps += 1;
    } catch (error) {
      options.restore(previous);
      throw error;
    }
  }
}

function pendingPrivateReveal(
  game: Game,
  fromIndex: number,
  intent: Extract<Intent, { kind: 'showCard' | 'declineReveal' }>,
): RobotPrivateReveal | undefined {
  const pending = game.pendingReveal;
  if (pending === null || (intent.kind !== 'showCard' && intent.kind !== 'declineReveal')) {
    return undefined;
  }
  return {
    recipientIndex: pending.suggesterIndex,
    fromIndex,
    ...(intent.kind === 'showCard' ? { card: intent.card } : {}),
  };
}

export function hasRobotActionableState(game: Game): boolean {
  return currentRobotIndex(game) !== null;
}

/** Index of the robot that must act now (turn owner or pending revealer). */
export function currentRobotIndex(game: Game): number | null {
  if (game.phase !== 'playing') return null;

  if (game.pendingReveal !== null) {
    const revealer = game.players[game.pendingReveal.revealerIndex];
    return revealer?.isRobot === true ? revealer.index : null;
  }

  const turnPlayer = game.players[game.turnIndex];
  return turnPlayer?.isRobot === true ? turnPlayer.index : null;
}
