import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRollIntent } from './intents';
import { connect, buildWebSocketUrl } from './ws';
import type { WebSocketLike } from './ws';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
  }

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

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('typed WebSocket transport', () => {
  it('builds the page-origin URL and offers the exact bearer subprotocol', () => {
    expect(buildWebSocketUrl('clue-game:abc', 'http://localhost:5173')).toBe(
      'ws://localhost:5173/ws?gameId=clue-game%3Aabc',
    );
    expect(buildWebSocketUrl('clue-game:abc', 'https://clue.example/play')).toBe(
      'wss://clue.example/ws?gameId=clue-game%3Aabc',
    );

    const sockets: FakeSocket[] = [];
    const transport = connect('clue-game:abc', 'jwt.value', {
      origin: 'https://clue.example',
      socketFactory: (url, protocols) => {
        expect(url).toBe('wss://clue.example/ws?gameId=clue-game%3Aabc');
        expect(protocols).toEqual(['bearer.jwt.value']);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    expect(sockets).toHaveLength(1);
    expect(get(transport.status)).toBe('connecting');
    transport.close();
  });

  it('queues intents until open and enforces a bounded FIFO policy', () => {
    const sockets: FakeSocket[] = [];
    const transport = connect('game', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    for (let index = 0; index < 32; index += 1) {
      expect(transport.send(createRollIntent())).toBe(true);
    }
    expect(transport.send(createRollIntent())).toBe(false);
    expect(get(transport.error)).toBe('send queue is full (32 intents)');
    sockets[0]!.open();
    expect(sockets[0]!.sent).toHaveLength(32);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ intent: { kind: 'roll' } });
    transport.close();
  });

  it('reconnects with exponential backoff, resets after open, and caps at 15 seconds', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = connect('game', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    sockets[0]!.open();
    sockets[0]!.close();
    expect(get(transport.status)).toBe('reconnecting');
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.close();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(3);

    sockets[2]!.close();
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(4);
    sockets[3]!.close();
    vi.advanceTimersByTime(4_000);
    expect(sockets).toHaveLength(5);
    sockets[4]!.close();
    vi.advanceTimersByTime(8_000);
    expect(sockets).toHaveLength(6);
    sockets[5]!.close();
    vi.advanceTimersByTime(15_000);
    expect(sockets).toHaveLength(7);
    sockets[6]!.close();
    vi.advanceTimersByTime(15_000);
    expect(sockets).toHaveLength(8);
    transport.close();
  });

  it('prevents duplicate reconnects and never reconnects after close', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = connect('game', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    sockets[0]!.close();
    sockets[0]!.close();
    transport.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(get(transport.status)).toBe('closed');
  });

  it('isolates private reveal cards in the local view and rejects malformed frames', () => {
    const socket = new FakeSocket();
    const transport = connect('game', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => socket,
    });
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
      events: [],
    }));
    const publicView = get(transport.view);
    expect(publicView).not.toBeNull();
    socket.message(JSON.stringify({
      type: 'private', reveal: { fromIndex: 0, card: { type: 'weapon', weapon: 'Rope' } },
    }));
    expect(get(transport.privateReveal)).toEqual({
      fromIndex: 0, card: { type: 'weapon', weapon: 'Rope' },
    });
    expect(get(transport.view)).toEqual({
      ...publicView,
      lastSuggestionReveal: { fromIndex: 0, card: { type: 'weapon', weapon: 'Rope' } },
    });
    expect(get(transport.view)?.myHand).toEqual([]);

    socket.message(JSON.stringify({
      type: 'state',
      view: {
        phase: 'playing', boardWidth: 24, boardHeight: 25,
        players: [{ name: 'Alice', suspect: 'Miss Scarlett', location: '16,24', handCount: 0,
          failedAccusation: false, isRobot: false, movedBySuggestion: false }],
        weaponLocations: [], turnIndex: 0, winnerIndex: null, pendingReveal: null,
        lastDieRoll: null, myIndex: 0, myHand: [],
      },
      events: [],
    }));
    expect(get(transport.privateReveal)).toBeNull();
    expect(get(transport.view)).toEqual(publicView);

    socket.message('{"type":"private","reveal":{"fromIndex":0,"card":{"type":"secret"}}}');
    expect(get(transport.error)).toMatch(/invalid private reveal card/);
    expect(get(transport.view)).toEqual(publicView);
    socket.message(JSON.stringify({ type: 'error', message: 'not your turn' }));
    expect(get(transport.error)).toBe('not your turn');
    transport.close();
  });

  it('clears a transport error after a successful frame', () => {
    const socket = new FakeSocket();
    const transport = connect('game', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => socket,
    });
    socket.open();
    socket.message(JSON.stringify({ type: 'error', message: 'game is full' }));
    expect(get(transport.error)).toBe('game is full');
    socket.message(JSON.stringify({
      type: 'lobby', gameId: 'game', isHost: false, players: [],
    }));
    expect(get(transport.error)).toBeNull();
    transport.close();
  });
});
