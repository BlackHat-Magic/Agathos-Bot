import { describe, expect, it } from 'vitest';
import {
  canManageLobby,
  canStartLobby,
  enqueueLeave,
  shouldResetJoinedState,
} from './lobby-lifecycle';

describe('lobby connection lifecycle', () => {
  it('resets optimistic membership after server rejection or transport loss', () => {
    expect(shouldResetJoinedState(true, 'open', 'game is full', true)).toBe(true);
    expect(shouldResetJoinedState(true, 'reconnecting', null, true)).toBe(true);
    expect(shouldResetJoinedState(true, 'closed', null, true)).toBe(true);
    expect(shouldResetJoinedState(true, 'open', null, false)).toBe(true);
    expect(shouldResetJoinedState(true, 'open', null, true)).toBe(false);
  });

  it('requires local membership for claims and host actions', () => {
    expect(canManageLobby(false)).toBe(false);
    expect(canManageLobby(true)).toBe(true);
    expect(canStartLobby(false, true)).toBe(false);
    expect(canStartLobby(true, false)).toBe(false);
    expect(canStartLobby(true, true)).toBe(true);
  });

  it('enqueues the typed leave intent and reports send failure', () => {
    const sent: unknown[] = [];
    expect(enqueueLeave(intent => { sent.push(intent); return true; })).toBe(true);
    expect(sent).toEqual([{ kind: 'leave' }]);
    expect(enqueueLeave(() => false)).toBe(false);
  });
});
