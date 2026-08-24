/**
 * Pure fan geometry for the Hearthstone-style hand dock. The arc is produced
 * visually with a low transform-origin, so proximity math uses simple even
 * slots across the fan width rather than rotated hit boxes.
 */

export const FAN_MAX_ANGLE_DEG = 12;
export const NEIGHBOR_REACH = 2;
export const NEIGHBOR_PUSH_PX = 18;
export const HOVER_LIFT_PX = -30;
export const HOVER_SCALE = 1.14;

export interface FanPlacement {
  angle: number;
  shiftPx: number;
  liftPx: number;
  scale: number;
  z: number;
}

/** Evenly spread rotations from -max to +max; a single card sits straight. */
export function fanAngles(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) =>
    FAN_MAX_ANGLE_DEG * (2 * index / (count - 1) - 1));
}

export function fanPlacements(count: number, hoverIndex: number | null): FanPlacement[] {
  const angles = fanAngles(count);
  return angles.map((angle, index) => {
    const isHovered = hoverIndex !== null && index === hoverIndex;
    const distance = hoverIndex === null ? 0 : Math.abs(index - hoverIndex);
    const direction = hoverIndex === null ? 0 : Math.sign(index - hoverIndex);
    const push = distance >= 1 && distance <= NEIGHBOR_REACH && hoverIndex !== null
      ? NEIGHBOR_PUSH_PX * ((NEIGHBOR_REACH + 1 - distance) / NEIGHBOR_REACH)
      : 0;
    return {
      angle,
      shiftPx: direction * push,
      liftPx: isHovered ? HOVER_LIFT_PX : 0,
      scale: isHovered ? HOVER_SCALE : 1,
      z: isHovered ? 40 : 10 + index,
    };
  });
}

/**
 * Horizontal rest-pose center of each card, in px across the fan width.
 *
 * Cards are anchored at left:50% and fanned by rotating around a pivot below
 * the card, so a card at angle θ sits at R·sin(θ) from the fan center, where
 * R is the pivot-to-card-center radius. These centers are independent of the
 * current hover transforms, giving stable nearest-card matching that cannot
 * be trapped by the hovered card's own enlarged hit area.
 */
export function fanCenters(count: number, fanWidth: number): number[] {
  return fanAngles(count).map(angle =>
    fanWidth / 2 +
    PIVOT_RADIUS_PX * Math.sin(angle * Math.PI / 180));
}

const CARD_HEIGHT_PX = 142;
/** transform-origin 50% 240% minus half card height = pivot-to-center radius. */
const PIVOT_RADIUS_PX = CARD_HEIGHT_PX * 2.4 - CARD_HEIGHT_PX / 2;

/** Index of the card whose rest center is closest to x, or null when empty. */
export function nearestCard(centers: number[], x: number): number | null {
  if (centers.length === 0 || !Number.isFinite(x)) return null;
  let best = 0;
  for (let index = 1; index < centers.length; index++) {
    if (Math.abs(centers[index]! - x) < Math.abs(centers[best]! - x)) best = index;
  }
  return best;
}
