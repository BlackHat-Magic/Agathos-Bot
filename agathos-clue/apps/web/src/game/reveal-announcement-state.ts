import type { PrivateReveal } from '../transport/snapshots';

export interface RevealAnnouncementState {
  active: PrivateReveal | null;
  queued: PrivateReveal | null;
  dismissed: PrivateReveal | null;
}

export function activateReveal(
  state: RevealAnnouncementState,
  reveal: PrivateReveal,
): RevealAnnouncementState {
  if (reveal.card === undefined) {
    return {
      active: state.active,
      queued: null,
      dismissed: reveal,
    };
  }
  return {
    active: reveal,
    queued: null,
    dismissed: state.dismissed,
  };
}
