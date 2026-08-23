import { describe, expect, it } from 'vitest';
import {
  isGameView,
  parseServerMessage,
  validateGameView,
} from './snapshots';

function view(phase: 'playing' | 'finished' = 'playing'): Record<string, unknown> {
  return {
    phase,
    boardWidth: 24,
    boardHeight: 25,
    players: [{
      name: 'Alice',
      suspect: 'Miss Scarlett',
      location: '16,24',
      handCount: 1,
      failedAccusation: false,
      isRobot: false,
      movedBySuggestion: false,
      userId: 'alice',
    }],
    weaponLocations: [{ weapon: 'Rope', location: 'Kitchen' }],
    turnIndex: 0,
    winnerIndex: null,
    pendingReveal: null,
    lastDieRoll: null,
    myIndex: 0,
    myHand: [{ type: 'room', room: 'Study' }],
    ...(phase === 'finished' ? {
      solution: {
        suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
        weapon: { type: 'weapon', weapon: 'Rope' },
        room: { type: 'room', room: 'Kitchen' },
      },
    } : {}),
  };
}

describe('server snapshot validation', () => {
  it('parses state, lobby, ready, error, and private frames', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'state', view: view(), events: [] }))).toEqual({
      ok: true,
      frame: { type: 'state', view: expect.objectContaining({ myHand: [{ type: 'room', room: 'Study' }] }), events: [] },
    });
    expect(parseServerMessage(JSON.stringify({
      type: 'lobby', gameId: 'clue-game:test', isHost: true,
      players: [{ name: 'Alice', suspect: null, isHost: true }],
    }))).toEqual({
      ok: true,
      frame: {
        type: 'lobby', gameId: 'clue-game:test', isHost: true,
        players: [{ name: 'Alice', suspect: null, isHost: true }],
      },
    });
    expect(parseServerMessage('{"type":"ready"}')).toEqual({ ok: true, frame: { type: 'ready' } });
    expect(parseServerMessage('{"type":"error","message":"not your turn"}')).toEqual({
      ok: true, frame: { type: 'error', message: 'not your turn' },
    });
    expect(parseServerMessage(JSON.stringify({
      type: 'private', reveal: { fromIndex: 1, card: { type: 'weapon', weapon: 'Rope' } },
    }))).toEqual({
      ok: true,
      frame: { type: 'private', reveal: { fromIndex: 1, card: { type: 'weapon', weapon: 'Rope' } } },
    });
  });

  it('validates local cards but rejects arbitrary public payloads', () => {
    expect(isGameView(view())).toBe(true);
    expect(isGameView({ ...view(), myHand: [{ type: 'room', room: 'secret' }] })).toBe(false);
    expect(isGameView({ ...view(), players: [{ ...view().players instanceof Array ? view().players[0] : {}, location: { card: 'secret' } }] })).toBe(false);
  });

  it('permits a solution only in a finished view', () => {
    expect(isGameView(view('finished'))).toBe(true);
    expect(isGameView({ ...view(), solution: view('finished').solution })).toBe(false);
    expect(isGameView({ ...view('finished'), solution: { suspect: { type: 'weapon', weapon: 'Rope' } } })).toBe(false);
  });

  it.each([2, 6, 7, 12])('accepts canonical last die roll total %s', (total) => {
    expect(isGameView({ ...view(), lastDieRoll: total })).toBe(true);
    expect(parseServerMessage(JSON.stringify({
      type: 'state', view: { ...view(), lastDieRoll: total },
      events: [{ type: 'rolled', playerIndex: 0, result: total }],
    }))).toMatchObject({ ok: true });
  });

  it.each([1, 13, 6.5, '7'])('rejects invalid die roll value %s', (value) => {
    expect(isGameView({ ...view(), lastDieRoll: value })).toBe(false);
    expect(parseServerMessage(JSON.stringify({
      type: 'state', view: view(),
      events: [{ type: 'rolled', playerIndex: 0, result: value }],
    }))).toMatchObject({ ok: false });
  });

  it('rejects malformed, unknown, and unsafe event frames without throwing', () => {
    expect(parseServerMessage('not json')).toEqual({ ok: false, error: 'malformed JSON message' });
    expect(parseServerMessage(JSON.stringify({ type: 'unknown' }))).toMatchObject({ ok: false });
    expect(parseServerMessage(JSON.stringify({
      type: 'state', view: view(), events: [{ type: 'revealed', revealerIndex: 0, card: { secret: true } }],
    }))).toMatchObject({ ok: false });
    expect(parseServerMessage(JSON.stringify({
      type: 'state', view: { ...view(), lastSuggestionReveal: {
        fromIndex: 0, card: { type: 'weapon', weapon: 'Rope' },
      } }, events: [],
    }))).toMatchObject({ ok: false });
    expect(parseServerMessage({ type: 'state' })).toEqual({
      ok: false, error: 'unsupported WebSocket message',
    });
  });

  it('returns detached validated snapshots', () => {
    const raw = view();
    const validated = validateGameView(raw);
    (raw.myHand as Array<Record<string, unknown>>)[0]!.room = 'Kitchen';
    expect(validated.myHand[0]).toEqual({ type: 'room', room: 'Study' });
  });

  it('rejects lobby frames carrying an authenticated host identity', () => {
    expect(parseServerMessage(JSON.stringify({
      type: 'lobby', gameId: 'clue-game:test', hostUserId: 'alice',
      players: [{ name: 'Alice', suspect: null, isHost: true }],
    }))).toMatchObject({ ok: false });
  });
});
