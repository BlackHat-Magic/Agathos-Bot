import { get } from 'svelte/store';
import { afterEach, describe, expect, it } from 'vitest';
import { session } from '../auth/standalone';
import { error, events, gameId, privateReveal } from './stores';
import type { WebSocketLike } from '../transport/ws';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.dispatch('close', {});
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open', {});
  }

  message(data: unknown): void {
    this.dispatch('message', { data });
  }

  fail(): void {
    this.dispatch('error', {});
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');

afterEach(() => {
  gameId.set(null);
  session.set(null);
  restoreGlobal('location', originalLocation);
  restoreGlobal('WebSocket', originalWebSocket);
});

describe('global game stores', () => {
  it('clears a mirrored transport error after the next successful frame', () => {
    const socket = new FakeSocket();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://example.test' },
    });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: class {
      constructor() {
        return socket;
      }
    } });

    gameId.set('game');
    session.set({ authenticated: true, userId: 'alice', token: 'jwt' });
    socket.fail();
    expect(get(error)).toBe('WebSocket connection error');
    socket.open();
    expect(get(error)).toBeNull();
    socket.message(JSON.stringify({ type: 'error', message: 'game is full' }));
    expect(get(error)).toBe('game is full');
    socket.message(JSON.stringify({
      type: 'lobby', gameId: 'game', isHost: false, players: [],
    }));
    expect(get(error)).toBeNull();
  });

  it('mirrors typed events and private reveals, then clears them on lobby state', () => {
    const socket = new FakeSocket();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://example.test' },
    });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: class {
      constructor() {
        return socket;
      }
    } });

    gameId.set('game');
    session.set({ authenticated: true, userId: 'alice', token: 'jwt' });
    socket.open();
    socket.message(JSON.stringify({
      type: 'state',
      view: {
        phase: 'playing', boardWidth: 24, boardHeight: 25,
        players: [{ name: 'Alice', suspect: 'Miss Scarlett', location: '16,24', handCount: 0,
          failedAccusation: false, isRobot: false, movedBySuggestion: false }],
        weaponLocations: [], turnIndex: 0, winnerIndex: null, pendingReveal: null,
        lastDieRoll: null, myIndex: 0, myHand: [],
      },
      events: [{ type: 'rolled', playerIndex: 0, result: 7 }],
    }));
    expect(get(events)).toEqual([{ type: 'rolled', playerIndex: 0, result: 7 }]);
    socket.message(JSON.stringify({
      type: 'private', reveal: { fromIndex: 0, card: { type: 'room', room: 'Study' } },
    }));
    expect(get(privateReveal)).toEqual({
      fromIndex: 0, card: { type: 'room', room: 'Study' },
    });
    socket.message(JSON.stringify({
      type: 'lobby', gameId: 'game', isHost: false, players: [],
    }));
    expect(get(events)).toEqual([]);
    expect(get(privateReveal)).toBeNull();
  });
});

function restoreGlobal(
  name: 'location' | 'WebSocket',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}
