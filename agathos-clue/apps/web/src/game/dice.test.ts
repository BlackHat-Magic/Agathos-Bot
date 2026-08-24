import { describe, expect, it } from 'vitest';
import {
  DICE_SETTLE_HOLD_MS,
  DICE_TUMBLE_MS,
  FACE_ROTATIONS,
  PIP_LAYOUT,
  splitRoll,
  tumbleStartRotation,
} from './dice';

describe('splitRoll', () => {
  it('produces two legal faces summing to every canonical total', () => {
    for (let total = 2; total <= 12; total++) {
      for (let seed = 0; seed < 20; seed++) {
        let state = seed * 7919 + total;
        const rng = () => {
          state = (state * 1103515245 + 12345) % 2147483648;
          return state / 2147483648;
        };
        const { die1, die2 } = splitRoll(total, rng);
        expect(die1).toBeGreaterThanOrEqual(1);
        expect(die1).toBeLessThanOrEqual(6);
        expect(die2).toBeGreaterThanOrEqual(1);
        expect(die2).toBeLessThanOrEqual(6);
        expect(die1 + die2).toBe(total);
      }
    }
  });

  it('is deterministic for a fixed rng', () => {
    const rng = () => 0.99;
    expect(splitRoll(9, rng)).toEqual({ die1: 6, die2: 3 });
    const zero = () => 0;
    expect(splitRoll(12, zero)).toEqual({ die1: 6, die2: 6 });
    expect(splitRoll(2, zero)).toEqual({ die1: 1, die2: 1 });
  });

  it('rejects impossible totals', () => {
    for (const bad of [0, 1, 13, 6.5, Number.NaN]) {
      expect(() => splitRoll(bad)).toThrow();
    }
  });
});

describe('face data', () => {
  it('maps exactly the six faces', () => {
    expect(Object.keys(FACE_ROTATIONS).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(Object.keys(PIP_LAYOUT).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('draws one pip per face value', () => {
    for (let value = 1; value <= 6; value++) {
      expect(PIP_LAYOUT[value]).toHaveLength(value);
      expect(new Set(PIP_LAYOUT[value]).size).toBe(value);
    }
  });

  it('times are positive', () => {
    expect(DICE_TUMBLE_MS).toBeGreaterThan(500);
    expect(DICE_SETTLE_HOLD_MS).toBeGreaterThan(300);
  });
});

describe('tumbleStartRotation', () => {
  it('starts at least two full turns past the resting angles for the rolled face', () => {
    const endAngles: Record<number, [number, number]> = {
      1: [0, 0], 2: [90, 0], 3: [0, -90], 4: [0, 90], 5: [-90, 0], 6: [0, 180],
    };
    for (const value of [1, 2, 3, 4, 5, 6] as const) {
      const start = tumbleStartRotation(value);
      const match = /rotateX\((-?\d+)deg\) rotateY\((-?\d+)deg\)/.exec(start);
      expect(match).not.toBeNull();
      const [, sx, sy] = match!.map(Number);
      expect(sx).toBeGreaterThanOrEqual(endAngles[value][0] + 720);
      expect(sy).toBeGreaterThanOrEqual(endAngles[value][1] + 720);
      // Same transform structure as the resting pose for smooth interpolation.
      expect(start).toMatch(/^rotateX\(-?\d+deg\) rotateY\(-?\d+deg\)$/);
    }
  });

  it('rejects invalid faces', () => {
    expect(() => tumbleStartRotation(0)).toThrow();
    expect(() => tumbleStartRotation(7)).toThrow();
  });
});
