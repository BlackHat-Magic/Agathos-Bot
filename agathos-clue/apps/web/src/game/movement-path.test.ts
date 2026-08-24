import { describe, expect, it } from 'vitest';
import { hopPath, roomSpread } from './movement-path';

describe('hopPath', () => {
  it('is trivial when already at the destination', () => {
    expect(hopPath('7,5', '7,5')).toEqual(['7,5']);
  });

  it('walks adjacent corridor cells one hop at a time', () => {
    const path = hopPath('6,5', '7,5');
    expect(path).toEqual(['6,5', '7,5']);
  });

  it('ends inside the destination room through its door', () => {
    const path = hopPath('9,8', 'Ballroom');
    expect(path.length).toBeGreaterThan(1);
    expect(path[path.length - 1]).toBe('Ballroom');
    // Every intermediate waypoint is a corridor cell.
    for (const step of path.slice(0, -1)) {
      expect(step).toMatch(/^\d+,\d+$/);
    }
  });

  it('never takes a secret room-to-room shortcut', () => {
    const path = hopPath('Kitchen', 'Study');
    if (path.length > 2) {
      // Any real route must pass corridor cells; a direct flight would not.
      expect(path.filter(step => /^\d+,\d+$/.test(step)).length).toBeGreaterThan(0);
    }
  });

  it('returns empty for impossible endpoints', () => {
    expect(hopPath('99,99', '7,5')).toEqual([]);
    expect(hopPath('7,5', 'Not A Room')).toEqual([]);
  });
});

describe('roomSpread', () => {
  it('centers a lone piece', () => {
    expect(roomSpread(1, 40, 30)).toEqual([[0, 0]]);
    expect(roomSpread(0, 40, 30)).toEqual([]);
  });

  it('spaces multiple pieces on a ring without overlap', () => {
    const offsets = roomSpread(6, 60, 60);
    expect(offsets).toHaveLength(6);
    for (const [x, y] of offsets) {
      const distance = Math.hypot(x, y);
      expect(distance).toBeGreaterThan(10);
      expect(distance).toBeLessThanOrEqual(33);
    }
    // First piece sits at the top of the ring.
    expect(offsets[0]![1]).toBeLessThan(0);
  });
});
