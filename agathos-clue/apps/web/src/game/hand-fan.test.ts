import { describe, expect, it } from 'vitest';
import {
  fanAngles,
  fanPlacements,
  hoveredSlot,
  slotCenters,
} from './hand-fan';

describe('fanAngles', () => {
  it('is empty for no cards and straight for one card', () => {
    expect(fanAngles(0)).toEqual([]);
    expect(fanAngles(1)).toEqual([0]);
  });

  it('spreads symmetrically around zero', () => {
    expect(fanAngles(3)).toEqual([-12, 0, 12]);
    const five = fanAngles(5);
    expect(five[0]).toBe(-12);
    expect(five[4]).toBe(12);
    expect(five[2]).toBe(0);
    for (let i = 0; i < 5; i++) {
      expect(five[i]).toBeCloseTo(-five[4 - i]!, 10);
    }
  });
});

describe('slotCenters', () => {
  it('handles empty and single hands', () => {
    expect(slotCenters(0)).toEqual([]);
    expect(slotCenters(1)).toEqual([0.5]);
  });

  it('spaces centers evenly across the fan', () => {
    expect(slotCenters(4)).toEqual([0.125, 0.375, 0.625, 0.875]);
  });
});

describe('hoveredSlot', () => {
  it('maps a cursor to the nearest slot and clamps the last bucket', () => {
    expect(hoveredSlot(4, 0)).toBe(0);
    expect(hoveredSlot(4, 0.9)).toBe(3);
    expect(hoveredSlot(4, 1)).toBe(3);
    expect(hoveredSlot(4, 0.5)).toBe(2);
  });

  it('rejects empty hands and out-of-range cursors', () => {
    expect(hoveredSlot(0, 0.5)).toBeNull();
    expect(hoveredSlot(4, -0.1)).toBeNull();
    expect(hoveredSlot(4, 1.1)).toBeNull();
    expect(hoveredSlot(4, Number.NaN)).toBeNull();
  });
});

describe('fanPlacements', () => {
  it('rests cards with no shift or lift when nothing is hovered', () => {
    const placements = fanPlacements(4, null);
    for (const placement of placements) {
      expect(placement.shiftPx).toBe(0);
      expect(placement.liftPx).toBe(0);
      expect(placement.scale).toBe(1);
    }
    expect(placements.map(p => p.z)).toEqual([10, 11, 12, 13]);
  });

  it('lifts and enlarges only the hovered card with topmost z', () => {
    const placements = fanPlacements(4, 2);
    expect(placements[2]).toMatchObject({ liftPx: -30, scale: 1.14, z: 40 });
    expect(placements[1]!.z).toBeLessThan(40);
    expect(placements[3]!.z).toBeLessThan(40);
  });

  it('pushes neighbors away from the cursor with falloff', () => {
    const placements = fanPlacements(5, 2);
    expect(placements[1]!.shiftPx).toBeLessThan(0);
    expect(placements[3]!.shiftPx).toBeGreaterThan(0);
    expect(Math.abs(placements[1]!.shiftPx!)).toBeGreaterThan(
      Math.abs(placements[0]!.shiftPx!));
    expect(Math.abs(placements[3]!.shiftPx!)).toBe(18);
    expect(Math.abs(placements[0]!.shiftPx!)).toBe(9);
    expect(Math.abs(placements[4]!.shiftPx!)).toBe(9);
    // Symmetric push around the hovered card.
    expect(placements[1]!.shiftPx).toBeCloseTo(-placements[3]!.shiftPx!, 10);
    expect(placements[0]!.shiftPx).toBeCloseTo(-placements[4]!.shiftPx!, 10);
    expect(fanPlacements(5, 2)[4]).toMatchObject({ shiftPx: 9 });
  });

  it('keeps the hovered card itself unshifted', () => {
    expect(fanPlacements(5, 0)[0]!.shiftPx).toBe(0);
  });
});
