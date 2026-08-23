import { describe, expect, it } from 'vitest';
import {
  createAccuseIntent,
  createClaimSuspectIntent,
  createDeclineRevealIntent,
  createEndTurnIntent,
  createJoinIntent,
  createLeaveIntent,
  createMoveToIntent,
  createRollIntent,
  createSetOrderIntent,
  createShowCardIntent,
  createStartIntent,
  createSuggestIntent,
  createUseSecretPassageIntent,
} from './intents';

describe('typed intent creators', () => {
  it('creates every supported lobby and game intent shape', () => {
    expect(createJoinIntent(' Alice ')).toEqual({ kind: 'join', name: ' Alice ' });
    expect(createClaimSuspectIntent('Miss Scarlett')).toEqual({
      kind: 'claimSuspect', suspect: 'Miss Scarlett',
    });
    expect(createStartIntent()).toEqual({ kind: 'start' });
    expect(createSetOrderIntent(['Miss Scarlett', 'Professor Plum'])).toEqual({
      kind: 'setOrder', order: ['Miss Scarlett', 'Professor Plum'],
    });
    expect(createUseSecretPassageIntent()).toEqual({ kind: 'useSecretPassage' });
    expect(createRollIntent()).toEqual({ kind: 'roll' });
    expect(createMoveToIntent('12,8')).toEqual({ kind: 'moveTo', destination: '12,8' });
    expect(createSuggestIntent('Professor Plum', 'Rope')).toEqual({
      kind: 'suggest', suspect: 'Professor Plum', weapon: 'Rope',
    });
    expect(createShowCardIntent({ type: 'room', room: 'Study' })).toEqual({
      kind: 'showCard', card: { type: 'room', room: 'Study' },
    });
    expect(createDeclineRevealIntent()).toEqual({ kind: 'declineReveal' });
    expect(createAccuseIntent('Mrs. White', 'Dagger', 'Kitchen')).toEqual({
      kind: 'accuse', suspect: 'Mrs. White', weapon: 'Dagger', room: 'Kitchen',
    });
    expect(createEndTurnIntent()).toEqual({ kind: 'endTurn' });
    expect(createLeaveIntent()).toEqual({ kind: 'leave' });
  });

  it('does not expose an auth user id in join and copies mutable inputs', () => {
    const order = ['Miss Scarlett', 'Professor Plum'] as const;
    const intent = createSetOrderIntent(order);
    expect(intent).not.toHaveProperty('userId');
    expect(intent.order).not.toBe(order);
  });

  it('rejects invalid domain values and arbitrary cards', () => {
    expect(() => createJoinIntent('')).toThrow();
    expect(() => createClaimSuspectIntent('unknown' as never)).toThrow();
    expect(() => createSetOrderIntent(['Miss Scarlett', 'Miss Scarlett'])).toThrow();
    expect(() => createMoveToIntent('not-a-cell' as never)).toThrow();
    expect(() => createShowCardIntent({ type: 'room', room: 'not a room' } as never)).toThrow();
  });
});
