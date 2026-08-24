/**
 * Pure dice-roll presentation helpers. The tumble itself is cosmetic CSS;
 * these pieces are the deterministic, testable core.
 */

export interface RollSplit {
  die1: number;
  die2: number;
}

/** Split a canonical 2d6 total into two legal faces, biased low for variety. */
export function splitRoll(total: number, rng: () => number = Math.random): RollSplit {
  if (!Number.isInteger(total) || total < 2 || total > 12) {
    throw new Error(`invalid dice total: ${total}`);
  }
  const min = Math.max(1, total - 6);
  const max = Math.min(6, total - 1);
  const die1 = min + Math.floor(rng() * (max - min + 1));
  return { die1, die2: total - die1 };
}

/**
 * Resting cube orientation (CSS transform) that brings each value's face
 * toward the viewer. Faces are placed with rotateX(-90)/rotateY(±90)/
 * rotateY(180) around a centered translateZ, opposite faces summing to 7;
 * each entry is the inverse of its face's placement rotation, normalized to
 * `rotateX(a) rotateY(b)` so start/end transforms interpolate per-function.
 */
export const FACE_ROTATIONS: Readonly<Record<number, string>> = {
  1: 'rotateX(0deg) rotateY(0deg)',
  2: 'rotateX(90deg) rotateY(0deg)',
  3: 'rotateX(0deg) rotateY(-90deg)',
  4: 'rotateX(0deg) rotateY(90deg)',
  5: 'rotateX(-90deg) rotateY(0deg)',
  6: 'rotateX(0deg) rotateY(180deg)',
};

/** Pip positions on a 3x3 grid (row-major indices) for each face value. */
export const PIP_LAYOUT: Readonly<Record<number, readonly number[]>> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export const DICE_TUMBLE_MS = 1400;
export const DICE_SETTLE_HOLD_MS = 1100;

/** Full extra turns before settling so the tumble always travels visibly. */
export function tumbleStartRotation(value: number, rng: () => number = Math.random): string {
  const end = FACE_ROTATIONS[value];
  if (end === undefined) throw new Error(`invalid die face: ${value}`);
  const [, ex, ey] = /rotateX\((-?\d+)deg\) rotateY\((-?\d+)deg\)/.exec(end)!.map(Number);
  const spinsX = Number(ex) + 720 + Math.floor(rng() * 360);
  const spinsY = Number(ey) + 720 + Math.floor(rng() * 360);
  return `rotateX(${spinsX}deg) rotateY(${spinsY}deg)`;
}
