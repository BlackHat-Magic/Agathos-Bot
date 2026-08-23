import { describe, expect, it } from 'vitest';
import {
  canManageLobby,
  canStartLobby,
  enqueueJoin,
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

  it('clears a stale error before retrying a valid join', () => {
    let visibleError: string | null = 'game is full';
    let errorAtSend: string | null = null;
    const sent: unknown[] = [];

    expect(enqueueJoin('  Alice  ', () => { visibleError = null; }, intent => {
      errorAtSend = visibleError;
      visibleError = 'new failure';
      sent.push(intent);
      return false;
    })).toBe(false);
    expect(errorAtSend).toBeNull();
    expect(visibleError).toBe('new failure');
    expect(shouldResetJoinedState(true, 'open', visibleError, true)).toBe(true);
    expect(sent).toEqual([{ kind: 'join', name: 'Alice' }]);
  });

  it('does not clear an error when the join name is blank', () => {
    let visibleError: string | null = 'previous failure';

    expect(enqueueJoin('  ', () => { visibleError = null; }, () => true)).toBe(false);
    expect(visibleError).toBe('previous failure');
  });

  it('enqueues the typed leave intent and reports send failure', () => {
    const sent: unknown[] = [];
    expect(enqueueLeave(intent => { sent.push(intent); return true; })).toBe(true);
    expect(sent).toEqual([{ kind: 'leave' }]);
    expect(enqueueLeave(() => false)).toBe(false);
  });
});
