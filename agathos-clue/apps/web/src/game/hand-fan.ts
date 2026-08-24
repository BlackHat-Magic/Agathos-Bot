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

/** Normalized slot centers (0..1); the cursor is matched against these. */
export function slotCenters(count: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, index) =>
    count === 1 ? 0.5 : (index + 0.5) / count);
}

/** Closest slot to a normalized cursor position, or null outside 0..1. */
export function hoveredSlot(count: number, cursor: number): number | null {
  if (count <= 0 || !Number.isFinite(cursor) || cursor < 0 || cursor > 1) return null;
  const slot = Math.floor(cursor * count);
  return Math.min(slot, count - 1);
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
