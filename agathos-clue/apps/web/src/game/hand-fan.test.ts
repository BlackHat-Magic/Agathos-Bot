import { describe, expect, it } from 'vitest';
import {
  fanAngles,
  fanCenters,
  fanPlacements,
  nearestCard,
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

describe('fanCenters and nearestCard', () => {
  it('places the fan symmetrically around the width center', () => {
    const centers = fanCenters(5, 780);
    const middle = centers[2]!;
    expect(middle).toBeCloseTo(390, 5);
    expect(centers[0]!).toBeCloseTo(780 - centers[4]!, 5);
    expect(centers[1]!).toBeCloseTo(780 - centers[3]!, 5);
  });

  it('spreads outer cards outward along the arc', () => {
    const centers = fanCenters(4, 600);
    expect(centers[0]!).toBeLessThan(centers[1]!);
    expect(centers[1]!).toBeLessThan(centers[2]!);
    expect(centers[2]!).toBeLessThan(centers[3]!);
  });

  it('handles empty and single hands', () => {
    expect(fanCenters(0, 780)).toEqual([]);
    expect(fanCenters(1, 780)).toEqual([390]);
  });

  it('matches the cursor to the nearest rest center and tolerates junk input', () => {
    const centers = fanCenters(3, 760);
    expect(nearestCard(centers, centers[0]! - 50)).toBe(0);
    expect(nearestCard(centers, centers[1]! + 10)).toBe(1);
    expect(nearestCard(centers, centers[2]! + 200)).toBe(2);
    expect(nearestCard([], 100)).toBeNull();
    expect(nearestCard(centers, Number.NaN)).toBeNull();
  });
});
