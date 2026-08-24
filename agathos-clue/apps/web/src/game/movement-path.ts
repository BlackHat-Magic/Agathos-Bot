import { buildBoard, type BoardSpace } from '@agathos/game';
import type { BoardLocation } from './BoardRenderer';

/**
 * Hop-by-hop waypoint path between two locations, corridor cell by corridor
 * cell, so a piece can visibly tap each square en route (BFS over the
 * canonical board). Secret room-to-room shortcuts are excluded: passage use
 * animates as a single flight instead.
 */

const CELL_ID = /^(\d+),(\d+)$/;
const board = buildBoard();

export interface Point {
  col: number;
  row: number;
}

function locationOf(space: BoardSpace): BoardLocation | null {
  if (space.room !== null) return space.room;
  return space.pos === null ? null : `${space.pos[0]},${space.pos[1]}`;
}

function spaceAtLocation(location: BoardLocation): BoardSpace | null {
  const match = CELL_ID.exec(location);
  if (match !== null) {
    const col = Number(match[1]);
    const row = Number(match[2]);
    return board[col]?.[row] ?? null;
  }
  for (const column of board) {
    for (const space of column) {
      if (space?.room === location) return space;
    }
  }
  return null;
}

/** Breadth-first waypoint list including both endpoints; [] when unreachable. */
export function hopPath(from: BoardLocation, to: BoardLocation): BoardLocation[] {
  if (from === to) return [from];
  const start = spaceAtLocation(from);
  const goal = spaceAtLocation(to);
  if (start === null || goal === null) return [];

  const cameFrom = new Map<BoardSpace, BoardSpace | null>();
  cameFrom.set(start, null);
  const queue: BoardSpace[] = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === goal) break;
    for (const access of current.accesses) {
      // Room-to-room edges are secret passages, not dice moves.
      if (current.room !== null && access.room !== null) continue;
      if (!cameFrom.has(access)) {
        cameFrom.set(access, current);
        queue.push(access);
      }
    }
  }
  if (!cameFrom.has(goal)) return [];

  const path: BoardSpace[] = [];
  let cursor: BoardSpace | undefined = goal;
  while (cursor !== undefined && cursor !== start) {
    path.unshift(cursor);
    cursor = cameFrom.get(cursor) ?? undefined;
  }
  path.unshift(start);
  return path.map(locationOf).filter((loc): loc is BoardLocation => loc !== null);
}

/**
 * Evenly spaced ring offsets so pieces sharing one room never overlap.
 * Radius scales with the room's half-extents; a lone piece sits centered.
 */
export function roomSpread(
  count: number,
  halfWidth: number,
  halfHeight: number,
): Array<[number, number]> {
  if (count <= 0) return [];
  if (count === 1) return [[0, 0]];
  const radius = Math.max(6, Math.min(halfWidth, halfHeight) * 0.55);
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / count);
    return [Math.cos(angle) * radius, Math.sin(angle) * radius] as [number, number];
  });
}
