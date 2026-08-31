import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJoinIntent, createLeaveIntent, createRollIntent } from './intents';
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

  fail(): void {
    this.dispatch('error', {});
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
    const transport = connect('clue-game:test', 'jwt', {
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
    const transport = connect('clue-game:test', 'jwt', {
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
    const transport = connect('clue-game:test', 'jwt', {
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

  it('replays the accepted normalized join once before queued intents after reconnect', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    sockets[0]!.open();
    expect(transport.send({ kind: 'join', name: '  Alice  ' })).toBe(true);
    expect(sockets[0]!.sent).toEqual(['{"intent":{"kind":"join","name":"Alice"}}']);
    sockets[0]!.close();
    expect(transport.send(createRollIntent())).toBe(false);
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([
      '{"intent":{"kind":"join","name":"Alice"}}',
    ]);
    expect(JSON.stringify(sockets[1]!.sent)).not.toContain('jwt');
    transport.close();
  });

  it('reconnects after a socket error without waiting for an external close', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    sockets[0]!.open();
    transport.send(createJoinIntent('Alice'));
    sockets[0]!.fail();
    expect(get(transport.status)).toBe('reconnecting');
    expect(get(transport.error)).toBe('WebSocket connection error');
    expect(transport.send(createRollIntent())).toBe(false);
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([
      '{"intent":{"kind":"join","name":"Alice"}}',
    ]);
    transport.close();
  });

  it('does not replay a lobby join after an authoritative state frame', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    sockets[0]!.open();
    transport.send(createJoinIntent('Alice'));
    sockets[0]!.message(JSON.stringify({
      type: 'lobby', gameId: 'clue-game:test', isHost: false, players: [],
    }));
    sockets[0]!.message(JSON.stringify({
      type: 'state',
      view: {
        phase: 'playing', boardWidth: 24, boardHeight: 25,
        players: [{ name: 'Alice', suspect: 'Miss Scarlett', location: '16,24', handCount: 0,
          failedAccusation: false, guessedHere: false, isRobot: false, movedBySuggestion: false }],
        weaponLocations: [], turnIndex: 0, winnerIndex: null, pendingReveal: null,
        lastDieRoll: null, myIndex: 0, myHand: [],
      },
      events: [],
    }));
    sockets[0]!.close();
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();

    expect(sockets[1]!.sent).toEqual([]);
    transport.close();
  });

  it('schedules only one reconnect when an error is followed by close', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    sockets[0]!.open();
    sockets[0]!.fail();
    sockets[0]!.close();
    vi.advanceTimersByTime(1_000);

    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
    transport.close();
  });

  it('does not replay after an explicit close or an accepted leave', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    sockets[0]!.open();
    transport.send(createJoinIntent('Alice'));
    transport.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);

    const nextSockets: FakeSocket[] = [];
    const nextTransport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        nextSockets.push(socket);
        return socket;
      },
    });
    nextSockets[0]!.open();
    nextTransport.send(createJoinIntent('Alice'));
    nextSockets[0]!.close();
    expect(nextTransport.send(createLeaveIntent())).toBe(false);
    vi.advanceTimersByTime(1_000);
    nextSockets[1]!.open();
    expect(nextSockets[1]!.sent).toEqual(['{"intent":{"kind":"join","name":"Alice"}}']);
    nextTransport.close();
  });

  it('clears replay state after a rejected join and ignores stale callbacks', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    sockets[0]!.open();
    transport.send(createJoinIntent('Alice'));
    sockets[0]!.close();
    sockets[0]!.message(JSON.stringify({ type: 'error', message: 'stale rejection' }));
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual(['{"intent":{"kind":"join","name":"Alice"}}']);
    sockets[1]!.message(JSON.stringify({ type: 'error', message: 'join rejected', intentKind: 'join' }));
    sockets[1]!.close();
    vi.advanceTimersByTime(1_000);
    sockets[2]!.open();
    expect(sockets[2]!.sent).toEqual([]);
    transport.close();
  });

  it('preserves replay after claim and start errors', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    sockets[0]!.open();
    transport.send(createJoinIntent('Alice'));
    sockets[0]!.close();
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual(['{"intent":{"kind":"join","name":"Alice"}}']);

    expect(transport.send({ kind: 'claimSuspect', suspect: 'Miss Scarlett' })).toBe(false);
    sockets[1]!.message(JSON.stringify({
      type: 'error', message: 'claim rejected', intentKind: 'claimSuspect',
    }));
    expect(transport.send({ kind: 'start' })).toBe(false);
    sockets[1]!.message(JSON.stringify({
      type: 'error', message: 'start rejected', intentKind: 'start',
    }));
    sockets[1]!.close();
    vi.advanceTimersByTime(1_000);
    sockets[2]!.open();

    expect(sockets[2]!.sent).toEqual(['{"intent":{"kind":"join","name":"Alice"}}']);
    transport.close();
  });

  it('preserves replay after malformed and uncorrelated errors', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    sockets[0]!.open();
    transport.send(createJoinIntent('Alice'));
    sockets[0]!.close();
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();
    sockets[1]!.message('not json');
    sockets[1]!.message(JSON.stringify({ type: 'error', message: 'internal failure' }));
    sockets[1]!.close();
    vi.advanceTimersByTime(1_000);
    sockets[2]!.open();

    expect(sockets[2]!.sent).toEqual(['{"intent":{"kind":"join","name":"Alice"}}']);
    transport.close();
  });

  it('isolates private reveal cards in the local view and rejects malformed frames', () => {
    const socket = new FakeSocket();
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => socket,
    });
    socket.open();
    socket.message(JSON.stringify({
      type: 'state',
      view: {
        phase: 'playing', boardWidth: 24, boardHeight: 25,
        players: [{ name: 'Alice', suspect: 'Miss Scarlett', location: '16,24', handCount: 0,
          failedAccusation: false, guessedHere: false, isRobot: false, movedBySuggestion: false }],
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
          failedAccusation: false, guessedHere: false, isRobot: false, movedBySuggestion: false }],
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
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => socket,
    });
    socket.open();
    socket.message(JSON.stringify({ type: 'error', message: 'game is full' }));
    expect(get(transport.error)).toBe('game is full');
    socket.message(JSON.stringify({
      type: 'lobby', gameId: 'clue-game:test', isHost: false, players: [],
    }));
    expect(get(transport.error)).toBeNull();
    transport.close();
  });

  it('appends event deltas, caps the log, and keeps it across ready frames', () => {
    const socket = new FakeSocket();
    const transport = connect('clue-game:test', 'jwt', {
      origin: 'https://example.test',
      socketFactory: () => socket,
    });
    socket.open();
    const baseView = {
      phase: 'playing', boardWidth: 24, boardHeight: 25,
      players: [{ name: 'Alice', suspect: 'Miss Scarlett', location: '16,24', handCount: 0,
        failedAccusation: false, guessedHere: false, isRobot: false, movedBySuggestion: false }],
      weaponLocations: [], turnIndex: 0, winnerIndex: null, pendingReveal: null,
      lastDieRoll: null, myIndex: 0, myHand: [],
    };
    socket.message(JSON.stringify({ type: 'state', view: baseView, events: [
      { type: 'turnEnded', playerIndex: 0 },
    ] }));
    socket.message(JSON.stringify({ type: 'state', view: baseView, events: [
      { type: 'rolled', playerIndex: 0, result: 7 },
    ] }));
    expect(get(transport.events)).toEqual([
      { type: 'turnEnded', playerIndex: 0 },
      { type: 'rolled', playerIndex: 0, result: 7 },
    ]);
    for (let index = 0; index < 64; index += 1) {
      socket.message(JSON.stringify({ type: 'state', view: baseView, events: [
        { type: 'turnEnded', playerIndex: 0 },
      ] }));
    }
    expect(get(transport.events)).toHaveLength(64);
    socket.message(JSON.stringify({ type: 'ready' }));
    expect(get(transport.events)).toHaveLength(64);
    socket.message(JSON.stringify({
      type: 'lobby', gameId: 'clue-game:test', isHost: false, players: [],
    }));
    expect(get(transport.events)).toEqual([]);
    transport.close();
  });
});
