import { describe, expect, it } from 'vitest';
import { buildBoard, reachable } from '@agathos/game';
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
       guessedHere: false,
       isRobot: false,
       movedBySuggestion: false,
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
    expect(parseServerMessage('{"type":"error","message":"not your turn","intentKind":"claimSuspect"}')).toEqual({
      ok: true, frame: { type: 'error', message: 'not your turn', intentKind: 'claimSuspect' },
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
    const player = (view().players as unknown[])[0] as Record<string, unknown>;
    expect(isGameView({ ...view(), players: [{ ...player, location: { card: 'secret' } }] })).toBe(false);
  });

  it('accepts full-board reachable hint sets, such as Dining Room with a roll of 8', () => {
    const board = buildBoard();
    const diningRoom = board.flat().find(space => space?.room === 'Dining Room')!;
    // Mirrors view.ts projection: rooms project by name, cells as "col,row".
    const hints = reachable(diningRoom, 8).spaces.map(space =>
      space.room ?? `${space.pos![0]},${space.pos![1]}`);
    expect(hints.length).toBeGreaterThan(100);
    // Moving into the occupied room is not offered; its doors are.
    const parsed = validateGameView({ ...view(), reachableSpacesHints: hints });
    expect(parsed.reachableSpacesHints).toHaveLength(hints.length);
    expect(parsed.reachableSpacesHints).toContain('15,12');
    expect(isGameView({
      ...view(),
      reachableSpacesHints: Array.from({ length: 24 * 25 + 1 }, (_, i) => `${i % 24},${i % 25}`),
    })).toBe(false);
  });

  it('rejects player user identities from public views', () => {
    expect(isGameView({
      ...view(),
      players: [{ ...(view().players as unknown[])[0] as Record<string, unknown>, userId: 'alice' }],
    })).toBe(false);
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
    expect(parseServerMessage('{"type":"error","message":"bad","intentKind":"wait"}'))
      .toMatchObject({ ok: false });
  });

  it('returns detached validated snapshots', () => {
    const raw = view();
    const validated = validateGameView(raw);
    (raw.myHand as Array<Record<string, unknown>>)[0]!.room = 'Kitchen';
    expect(validated.myHand[0]).toEqual({ type: 'room', room: 'Study' });
  });

  it('requires an authoritative guessedHere boolean for every player', () => {
    const player = (view().players as unknown[])[0] as Record<string, unknown>;
    expect(isGameView({ ...view(), players: [{ ...player, guessedHere: undefined }] })).toBe(false);
    expect(isGameView({ ...view(), players: [{ ...player, guessedHere: 'false' }] })).toBe(false);
    expect(validateGameView(view()).players[0]!.guessedHere).toBe(false);
  });

  it('rejects lobby frames carrying an authenticated host identity', () => {
    expect(parseServerMessage(JSON.stringify({
      type: 'lobby', gameId: 'clue-game:test', hostUserId: 'alice',
      players: [{ name: 'Alice', suspect: null, isHost: true }],
    }))).toMatchObject({ ok: false });
  });
});
