import { describe, expect, it } from 'vitest';
import type { Event, GameView } from '@agathos/game';
import { formatEvent, relativeEventLabel } from './event-format';

const view = {
  players: [
    { name: 'Alice' },
    { name: 'Bob' },
  ],
} as GameView;

describe('event formatting', () => {
  it('uses player names and never exposes card values for reveal events', () => {
    const event: Event = { type: 'revealed', revealerIndex: 1, cardHint: 'private' };
    expect(formatEvent(event, view)).toBe('Bob revealed a card privately');
    expect(formatEvent(event, view)).not.toContain('Rope');
  });

  it('formats public actions and relative labels', () => {
    expect(formatEvent({
      type: 'suggested', playerIndex: 0, suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Study',
    }, view)).toContain('Alice suggested Miss Scarlett, Rope, and Study');
    expect(relativeEventLabel(2, 3)).toBe('Latest');
    expect(relativeEventLabel(1, 3)).toBe('1 action ago');
    expect(relativeEventLabel(0, 3)).toBe('2 actions ago');
  });
});
