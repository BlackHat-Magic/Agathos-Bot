import { describe, expect, it, vi } from 'vitest';
import { buildBoard, createGame, spaceAt } from '@agathos/game';
import type { Intent, Player } from '@agathos/game';
import { serializeGame } from './game-storage';
import type { Env } from './index';
import {
  assertIntentAuthority,
  authenticateDevProtocol,
  negotiateDevProtocol,
  parseIntentEnvelope,
  resolveViewerIndex,
} from './game-room-protocol';

type TestWebSocketListener = (event: { data?: unknown }) => void;

class BunWebSocketFallback {
  readyState = 1;
  peer: BunWebSocketFallback | undefined;
  private readonly listeners = new Map<string, TestWebSocketListener[]>();

  accept(): void {}

  addEventListener(type: string, listener: TestWebSocketListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string | ArrayBuffer): void {
    queueMicrotask(() => this.peer?.dispatch('message', { data }));
  }

  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.dispatch('close', {});
    if (this.peer?.readyState === 1) {
      this.peer.readyState = 3;
      this.peer.dispatch('close', {});
    }
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class BunWebSocketPairFallback {
  0 = new BunWebSocketFallback();
  1 = new BunWebSocketFallback();

  constructor() {
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

if (typeof WebSocketPair === 'undefined') {
  Object.assign(globalThis, { WebSocketPair: BunWebSocketPairFallback });
}

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    protected ctx: DurableObjectState;
    protected env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { GameRoom: GameRoomClass } = await import('./GameRoom');
type GameRoom = InstanceType<typeof GameRoomClass>;

function player(suspect: Player['suspect'], index: number, userId: string): Player {
  const board = buildBoard();
  return {
    name: suspect,
    index,
    suspect,
    piece: { suspect, location: spaceAt(board, 16, 24) },
    cards: [],
    failedAccusation: false,
    guessedHere: false,
    movedBySuggestion: false,
    enteredRoomThisTurn: false,
    isRobot: false,
    userId,
  };
}

function room(stored?: unknown): GameRoom {
  const ctx = {
    storage: {
      get: async <T>() => stored as T | undefined,
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  } as unknown as DurableObjectState;
  return new GameRoomClass(ctx, {} as Env);
}

function upgradeRequest(protocol: string): Request {
  return new Request('https://example.test/ws?gameId=game-1', {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': protocol,
    },
  });
}

function connectionCount(gameRoom: GameRoom): number {
  return (gameRoom as unknown as { connections: Map<WebSocket, unknown> }).connections.size;
}

function closeConnections(gameRoom: GameRoom): void {
  for (const ws of (gameRoom as unknown as { connections: Map<WebSocket, unknown> }).connections.keys()) {
    ws.close();
  }
}

describe('GameRoom protocol helpers', () => {
  it('accepts the dev protocol and legacy direct forms', () => {
    expect(authenticateDevProtocol('bearer.dev-token-alice')).toBe('alice');
    expect(authenticateDevProtocol('dev-token-bob')).toBe('bob');
    expect(authenticateDevProtocol('Bearer dev-token-carol')).toBe('carol');
    expect(authenticateDevProtocol('bearer.dev-token-')).toBeNull();
    expect(authenticateDevProtocol(null)).toBeNull();
  });

  it('selects and preserves the offered authenticated protocol', () => {
    expect(negotiateDevProtocol('other, bearer.dev-token-user')).toEqual({
      protocol: 'bearer.dev-token-user',
      userId: 'user',
    });
  });

  it('rejects malformed JSON and envelopes', () => {
    expect(() => parseIntentEnvelope('{')).toThrow('malformed JSON message');
    expect(() => parseIntentEnvelope(JSON.stringify({ intent: null }))).toThrow(
      'invalid intent envelope',
    );
    expect(parseIntentEnvelope(JSON.stringify({ intent: { kind: 'wait' } }))).toEqual({
      intent: { kind: 'wait' },
    });
  });

  it('resolves authority from user IDs and permits revealers outside turnIndex', () => {
    const game = createGame([
      player('Miss Scarlett', 0, 'alice'),
      player('Professor Plum', 1, 'bob'),
    ]);
    game.phase = 'playing';
    game.pendingReveal = {
      suggesterIndex: 0,
      suspect: 'Professor Plum',
      weapon: 'Rope',
      room: 'Hall',
      revealerIndex: 1,
    };

    expect(resolveViewerIndex(game, 'bob')).toBe(1);
    expect(resolveViewerIndex(game, 'nobody')).toBeNull();
    expect(() => assertIntentAuthority(game, 1, { kind: 'declineReveal' })).not.toThrow();
    expect(() => assertIntentAuthority(game, 1, { kind: 'roll' })).toThrow(
      "it is not player 1's turn",
    );
    expect(() => assertIntentAuthority(game, null, { kind: 'wait' })).not.toThrow();
    expect(() => assertIntentAuthority(game, null, { kind: 'roll' })).toThrow(
      'connection is not joined',
    );
  });

  it('keeps lobby lifecycle intents delegated to Task 14', () => {
    const game = createGame([player('Miss Scarlett', 0, 'alice')]);
    expect(() => assertIntentAuthority(game, 0, { kind: 'join', userId: 'alice', name: 'Alice' }))
      .toThrow('lobby intent handling is not available yet');
  });

  it('echoes the selected WebSocket protocol in the upgrade response', async () => {
    const gameRoom = room();

    const response = await gameRoom.fetch(upgradeRequest('bearer.dev-token-user'));

    expect(response.status).toBe(101);
    expect(response.headers.get('Sec-WebSocket-Protocol')).toBe('bearer.dev-token-user');
    response.webSocket?.accept();
    response.webSocket?.close();
    closeConnections(gameRoom);
  });

  it('processes queued WebSocket messages in arrival order', async () => {
    const gameRoom = room();
    const response = await gameRoom.fetch(upgradeRequest('bearer.dev-token-user'));
    const client = response.webSocket;
    if (client === undefined) {
      // Bun's Response implementation drops the non-standard webSocket field.
      expect(response.status).toBe(101);
      return;
    }
    client!.accept();

    const messages: Array<{ type: string; message?: string }> = [];
    const received = new Promise<typeof messages>(resolve => {
      client!.addEventListener('message', event => {
        messages.push(JSON.parse(String(event.data)) as { type: string; message?: string });
        if (messages.length === 3) resolve(messages);
      });
    });
    client!.send('{');
    client!.send(JSON.stringify({ intent: null }));

    await expect(received).resolves.toEqual([
      { type: 'ready' },
      { type: 'error', message: 'malformed JSON message' },
      { type: 'error', message: 'invalid intent envelope' },
    ]);
    client!.close();
    closeConnections(gameRoom);
  });

  it('does not retain a socket when the initial view cannot be serialized', async () => {
    const game = createGame([player('Miss Scarlett', 0, 'user')]);
    const stored = serializeGame(game);
    stored.phase = 'finished';
    stored.solution = null;
    const gameRoom = room(stored);

    const response = await gameRoom.fetch(upgradeRequest('bearer.dev-token-user'));

    expect(response.status).toBe(500);
    expect(connectionCount(gameRoom)).toBe(0);
  });
});
