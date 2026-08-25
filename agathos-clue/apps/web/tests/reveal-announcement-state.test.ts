import { describe, expect, it } from 'vitest';
import type { PrivateReveal } from '../src/transport/snapshots';
import { activateReveal, type RevealAnnouncementState } from '../src/game/reveal-announcement-state';

const cardReveal: PrivateReveal = {
  fromIndex: 1,
  card: { type: 'weapon', weapon: 'Lead Pipe' },
};

const staleQueuedReveal: PrivateReveal = {
  fromIndex: 1,
  card: { type: 'weapon', weapon: 'Lead Pipe' },
};

const emptyReveal: PrivateReveal = { fromIndex: 1 };

const emptyState: RevealAnnouncementState = {
  active: null,
  queued: staleQueuedReveal,
  dismissed: null,
};

describe('activateReveal', () => {
  it('consumes an empty-handed reveal without activating an invisible overlay', () => {
    expect(activateReveal(emptyState, emptyReveal)).toEqual({
      active: null,
      queued: null,
      dismissed: emptyReveal,
    });
  });

  it('allows a card reveal to replace a stale queued reveal', () => {
    expect(activateReveal(emptyState, cardReveal)).toEqual({
      active: cardReveal,
      queued: null,
      dismissed: null,
    });
  });

  it('preserves an activated card when an empty reveal arrives', () => {
    const activeState = activateReveal(emptyState, cardReveal);
    expect(activateReveal(activeState, emptyReveal)).toEqual({
      active: cardReveal,
      queued: null,
      dismissed: emptyReveal,
    });
  });
});
