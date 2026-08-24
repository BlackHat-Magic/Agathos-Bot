import Icon from '@iconify/svelte';
import { SUSPECT_COLORS } from './canvas2d';

export type CardType = 'suspect' | 'weapon' | 'room';

const TYPE_ACCENTS: Record<CardType, string> = {
  suspect: 'var(--color-mocha-mauve)',
  weapon: 'var(--color-mocha-red)',
  room: 'var(--color-mocha-teal)',
};

const TYPE_GLYPHS: Record<CardType, string> = {
  suspect: 'hugeicons:user',
  weapon: 'hugeicons:knife-02',
  room: 'hugeicons:door-01',
};

/** Suspects wear their board-token color; weapons/rooms share a type accent. */
export function accentFor(type: CardType, value: string): string {
  return type === 'suspect' && value in SUSPECT_COLORS
    ? SUSPECT_COLORS[value as keyof typeof SUSPECT_COLORS]
    : TYPE_ACCENTS[type];
}

export function glyphFor(type: CardType): string {
  return TYPE_GLYPHS[type];
}

export { Icon };
