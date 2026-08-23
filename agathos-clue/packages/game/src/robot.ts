import type { Card, Game, Intent, Suspect, Weapon } from './types';
import { SUSPECTS, WEAPONS } from './types';
import { reachable } from './pathfind';

type RNG = () => number;

/**
 * Decide the next intent for a robot player.
 *
 * The robot is a STATE MACHINE called repeatedly by the DO scheduler
 * (Task 15) until it returns `endTurn`. Each call inspects the current
 * `Game` state to choose the next intent. Ports the robot branches of
 * `clue.py:_play_game` (lines 405-523).
 *
 *   - clue.py:405-415  robots take secret passage 50% of the time
 *   - clue.py:419-424  robots always roll the dice (dice_conf = True)
 *   - clue.py:432-438  robots pick the farthest reachable room
 *                       (or farthest space if no room reachable)
 *   - clue.py:510-523  robots suggest using random suspect + random weapon,
 *                       the room is their current room
 *   - clue.py:632-737  robots never make accusations
 */
export function decideRobotIntent(
  game: Game,
  robotIndex: number,
  rng: RNG = Math.random,
): Intent {
  const player = game.players[robotIndex];
  const pending = game.pendingReveal;

  if (game.phase !== 'playing') return { kind: 'wait' };

  if (pending) {
    if (pending.revealerIndex !== robotIndex) return { kind: 'wait' };

    const matches = player.cards.filter(card => matchesPendingReveal(card, pending));
    return matches.length
      ? { kind: 'showCard', card: randomOf(matches, rng) }
      : { kind: 'declineReveal' };
  }

  if (game.turnIndex !== robotIndex) return { kind: 'wait' };

  if (player.failedAccusation) return { kind: 'endTurn' };

  const inRoom = player.piece.location.room != null;
  const cornerRoomHasPassage =
    inRoom && player.piece.location.accesses.some(a => a.room != null);

  // A movement action is terminal unless it entered an eligible room.
  if (game.hasMovedThisTurn) {
    if (
      inRoom &&
      !player.guessedHere &&
      (player.enteredRoomThisTurn || player.movedBySuggestion)
    ) {
      return {
        kind: 'suggest',
        suspect: randomOf(SUSPECTS, rng),
        weapon: randomOf(WEAPONS, rng),
      };
    }
    return { kind: 'endTurn' };
  }

  // Preserve room-entry state when a caller has not yet reflected the move flag.
  if (
    !game.hasRolledThisTurn &&
    inRoom &&
    !player.guessedHere &&
    (player.enteredRoomThisTurn || player.movedBySuggestion)
  ) {
    return {
      kind: 'suggest',
      suspect: randomOf(SUSPECTS, rng),
      weapon: randomOf(WEAPONS, rng),
    };
  }

  if (player.guessedHere) return { kind: 'endTurn' };

  // After rolling, choose destination = farthest reachable room
  //    (or farthest reachable space). clue.py:432-438 picks
  //    `max(zip(dests, costs), key=lambda x: x[1]+100 if x[0].room else x[1])`;
  //    filtering to rooms first then taking the highest-cost room has the
  //    same effect: prefer rooms, and among rooms prefer the farthest.
  if (game.hasRolledThisTurn && game.lastDieRoll !== null) {
    const r = reachable(player.piece.location, game.lastDieRoll);
    const roomSpaces = r.spaces.filter(s => s.room != null);
    if (roomSpaces.length) {
      let dest = roomSpaces[0]!;
      for (const s of roomSpaces) {
        if ((r.cost.get(s) ?? -1) > (r.cost.get(dest) ?? -1)) dest = s;
      }
      return { kind: 'moveTo', destination: dest.room! };
    }
    const corridorSpaces = r.spaces.filter(s => s.room == null);
    if (corridorSpaces.length) {
      let dest = corridorSpaces[0]!;
      for (const s of corridorSpaces) {
        if ((r.cost.get(s) ?? -1) > (r.cost.get(dest) ?? -1)) dest = s;
      }
      return { kind: 'moveTo', destination: dest.pos!.join(',') };
    }
    return { kind: 'endTurn' };
  }

  // At the start of a turn, robots either take a passage or roll.
  if (!game.hasRolledThisTurn && !game.hasMovedThisTurn) {
    if (cornerRoomHasPassage && rng() < 0.5) return { kind: 'useSecretPassage' };
    return { kind: 'roll' };
  }

  // Robots never accuse (clue.py:632-737).
  return { kind: 'endTurn' };
}

function matchesPendingReveal(card: Card, pending: NonNullable<Game['pendingReveal']>): boolean {
  return (
    (card.type === 'suspect' && card.suspect === pending.suspect) ||
    (card.type === 'weapon' && card.weapon === pending.weapon) ||
    (card.type === 'room' && card.room === pending.room)
  );
}

function randomOf<T>(arr: readonly T[], rng: RNG): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
