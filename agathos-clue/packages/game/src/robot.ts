import type { Game, Intent, Suspect, Weapon } from './types';
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
  if (player.failedAccusation) return { kind: 'endTurn' };

  const inRoom = player.piece.location.room != null;
  const cornerRoomHasPassage =
    inRoom && player.piece.location.accesses.some(a => a.room != null);

  // 1. secret passage from corner room (50% per clue.py:407)
  if (cornerRoomHasPassage && !player.guessedHere && rng() < 0.5) {
    return { kind: 'useSecretPassage' };
  }

  // 2. roll if not in a room — robots always roll (clue.py:419-420)
  if (!inRoom && game.lastDieRoll == null) {
    return { kind: 'roll' };
  }

  // 3. after rolling, choose destination = farthest reachable room
  //    (or farthest reachable space). clue.py:432-438 picks
  //    `max(zip(dests, costs), key=lambda x: x[1]+100 if x[0].room else x[1])`;
  //    filtering to rooms first then taking the highest-cost room has the
  //    same effect: prefer rooms, and among rooms prefer the farthest.
  if (!inRoom && game.lastDieRoll != null) {
    const r = reachable(player.piece.location, game.lastDieRoll);
    const roomSpaces = r.spaces.filter(s => s.room != null);
    if (roomSpaces.length) {
      let dest = roomSpaces[0]!;
      for (const s of roomSpaces) {
        if ((r.cost.get(s) ?? -1) > (r.cost.get(dest) ?? -1)) dest = s;
      }
      return { kind: 'moveTo', destination: dest.room! };
    }
    if (r.spaces.length) {
      const last = r.spaces[r.spaces.length - 1]!;
      return { kind: 'moveTo', destination: last.pos!.join(',') };
    }
    return { kind: 'endTurn' };
  }

  // 4. in a room — suggest if not already suggested this turn (clue.py:510-523)
  if (inRoom && !player.guessedHere &&
      (player.enteredRoomThisTurn || player.movedBySuggestion)) {
    return {
      kind: 'suggest',
      suspect: randomOf(SUSPECTS, rng),
      weapon: randomOf(WEAPONS, rng),
    };
  }

  // 5. robots never accuse (clue.py:632-737) — end the turn
  return { kind: 'endTurn' };
}

function randomOf<T extends readonly string[]>(arr: T, rng: RNG): T[number] {
  return arr[Math.floor(rng() * arr.length)] as T[number];
}
