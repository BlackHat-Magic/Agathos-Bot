import type { BoardSpace } from './types';

export interface ReachResult {
  spaces: BoardSpace[];
  cost: Map<BoardSpace, number>;
}

export function reachable(source: BoardSpace, limit: number): ReachResult {
  if (limit <= 0) return { spaces: [], cost: new Map() };

  const queue: Array<[BoardSpace, number]> = [];
  const visited = new Map<BoardSpace, number>();

  for (const a of source.accesses) {
    // Secret passages are a start-of-turn alternative to rolling, not a dice move
    if (source.room && a.room) continue;
    // A door is not a space: stepping through it into a room is free
    queue.push([a, a.room ? 0 : 1]);
  }

  while (queue.length) {
    const [space, cost] = queue.shift()!;
    if (space === source) continue;
    if (cost > limit) continue;
    const existing = visited.get(space);
    if (existing !== undefined && cost >= existing) continue;
    visited.set(space, cost);
    // Entering a room ends the move: rooms are destinations only, so only
    // corridors are expanded (no pass-through, no secret-passage chaining)
    if (!space.room) {
      for (const acc of space.accesses) {
        queue.push([acc, acc.room ? cost : cost + 1]);
      }
    }
  }

  const sorted = [...visited.entries()].sort((a, b) => a[1] - b[1]);
  return {
    spaces: sorted.map(e => e[0]),
    cost: new Map(sorted),
  };
}