import { describe, expect, it, vi } from 'vitest';
import { buildBoard, createGame, spaceAt } from '@agathos/game';
import type { Card, Intent, Player } from '@agathos/game';
import { hydrateGame, serializeGame } from './game-storage';
import type { Env } from './index';
import {
  assertIntentAuthority,
  authenticateDevProtocol,
  negotiateDevProtocol,
  parseIntentEnvelope,
  resolveViewerIndex,
} from './game-room-protocol';

type TestWebSocketListener = (event: { data?: unknown }) => void;
type TestMessage =
  | { type: 'ready' }
  | {
    type: 'lobby';
    gameId: string;
    hostUserId: string | null;
    players: Array<{ name: string; suspect: Player['suspect'] | null; isHost: boolean }>;
  }
  | { type: 'error'; message: string }
  | {
    type: 'state';
    view: {
      myIndex: number;
      myHand: Card[];
      turnIndex: number;
    };
    events: unknown[];
  };

class BunWebSocketFallback {
  readyState = 1;
  peer: BunWebSocketFallback | undefined;
  private readonly listeners = new Map<string, TestWebSocketListener[]>();
  private readonly pendingMessages: Array<{ data?: unknown }> = [];

  accept(): void {}

  addEventListener(type: string, listener: TestWebSocketListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
    if (type === 'message' && this.pendingMessages.length > 0) {
      for (const event of this.pendingMessages.splice(0)) listener(event);
    }
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
    const listeners = this.listeners.get(type) ?? [];
    if (type === 'message' && listeners.length === 0) {
      this.pendingMessages.push(event);
      return;
    }
    for (const listener of listeners) listener(event);
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

if (typeof WebSocketPair === 'undefined' || Object.hasOwn(globalThis, 'Bun')) {
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

function player(
  suspect: Player['suspect'],
  index: number,
  userId: string,
  cards: Card[] = [],
): Player {
  const board = buildBoard();
  return {
    name: suspect,
    index,
    suspect,
    piece: { suspect, location: spaceAt(board, 16, 24) },
    cards,
    failedAccusation: false,
    guessedHere: false,
    movedBySuggestion: false,
    enteredRoomThisTurn: false,
    isRobot: false,
    userId,
  };
}

interface TestStorage {
  value: unknown;
  lobby: unknown;
  failPuts: boolean;
  failTransactions: boolean;
  putCount: number;
  transactionCount: number;
}

function roomWithStorage(stored?: unknown, storedLobby?: unknown): { gameRoom: GameRoom; storage: TestStorage } {
  const storage: TestStorage = {
    value: stored,
    lobby: storedLobby,
    failPuts: false,
    failTransactions: false,
    putCount: 0,
    transactionCount: 0,
  };
  const ctx = {
    storage: {
      get: async <T>(key: string) =>
        (key === 'lobby' ? storage.lobby : storage.value) as T | undefined,
      put: async (key: string, value: unknown) => {
        storage.putCount += 1;
        if (storage.failPuts) throw new Error('storage unavailable');
        if (key === 'lobby') storage.lobby = value;
        else storage.value = value;
      },
      transaction: async <T>(callback: (transaction: {
        put: (entries: Record<string, unknown>) => Promise<void>;
      }) => Promise<T>) => {
        storage.transactionCount += 1;
        const pending = new Map<string, unknown>();
        const result = await callback({
          put: async entries => {
            for (const [key, value] of Object.entries(entries)) pending.set(key, value);
          },
        });
        if (storage.failTransactions) throw new Error('storage unavailable');
        for (const [key, value] of pending) {
          if (key === 'lobby') storage.lobby = value;
          else storage.value = value;
        }
        return result;
      },
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  } as unknown as DurableObjectState;
  return { gameRoom: new GameRoomClass(ctx, {} as Env), storage };
}

function room(stored?: unknown): GameRoom {
  return roomWithStorage(stored).gameRoom;
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

function messageQueue(ws: WebSocket): {
  received: TestMessage[];
  next: () => Promise<TestMessage>;
} {
  const received: TestMessage[] = [];
  const waiters: Array<(message: TestMessage) => void> = [];
  let consumed = 0;
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)) as TestMessage;
    received.push(message);
    waiters.shift()?.(message);
  });
  return {
    received,
    next: () => {
      if (consumed < received.length) return Promise.resolve(received[consumed++]!);
      return new Promise(resolve => waiters.push(message => {
        consumed += 1;
        resolve(message);
      }));
    },
  };
}

async function connectJoinedPlayer(
  gameRoom: GameRoom,
  userId: string,
): Promise<{ client: WebSocket; messages: ReturnType<typeof messageQueue>; initial: TestMessage }> {
  const response = await gameRoom.fetch(upgradeRequest(`bearer.dev-token-${userId}`));
  expect(response.status).toBe(101);
  let client = response.webSocket;
  if (client === null || client === undefined) {
    const connections = (gameRoom as unknown as {
      connections: Map<WebSocket, { ws: WebSocket; userId: string }>;
    }).connections;
    const server = [...connections.values()].find(connection => connection.userId === userId)?.ws;
    const peer = (server as unknown as { peer?: WebSocket } | undefined)?.peer;
    if (peer === undefined) throw new Error('test WebSocket was not returned');
    client = peer;
  }
  client.accept();
  const messages = messageQueue(client);
  const initial = await messages.next();
  return { client, messages, initial };
}

function joinedGame(): ReturnType<typeof serializeGame> {
  const game = createGame([
    player('Miss Scarlett', 0, 'alice', [{ type: 'room', room: 'Library' }]),
    player('Professor Plum', 1, 'bob', [{ type: 'weapon', weapon: 'Lead Pipe' }]),
  ]);
  game.phase = 'playing';
  game.solution = {
    suspect: { type: 'suspect', suspect: 'Mrs. Peacock' },
    weapon: { type: 'weapon', weapon: 'Dagger' },
    room: { type: 'room', room: 'Study' },
  };
  return serializeGame(game);
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
        {
          type: 'lobby',
          gameId: 'game-1',
          hostUserId: null,
          players: [],
        },
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

  it('persists a joined mutation and broadcasts redacted views to each viewer', async () => {
    const stored = joinedGame();
    const { gameRoom, storage } = roomWithStorage(stored);
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');

    expect(alice.initial).toMatchObject({
      type: 'state',
      view: { myIndex: 0, myHand: [{ type: 'room', room: 'Library' }], turnIndex: 0 },
    });
    expect(bob.initial).toMatchObject({
      type: 'state',
      view: { myIndex: 1, myHand: [{ type: 'weapon', weapon: 'Lead Pipe' }], turnIndex: 0 },
    });

    alice.client.send(JSON.stringify({ intent: { kind: 'endTurn' } }));

    const aliceUpdate = await alice.messages.next();
    const bobUpdate = await bob.messages.next();
    expect(aliceUpdate).toMatchObject({
      type: 'state',
      view: { myIndex: 0, myHand: [{ type: 'room', room: 'Library' }], turnIndex: 1 },
      events: [{ type: 'turnEnded', playerIndex: 0 }],
    });
    expect(bobUpdate).toMatchObject({
      type: 'state',
      view: { myIndex: 1, myHand: [{ type: 'weapon', weapon: 'Lead Pipe' }], turnIndex: 1 },
      events: [{ type: 'turnEnded', playerIndex: 0 }],
    });
    expect(JSON.stringify(bobUpdate)).not.toContain('Library');
    expect(storage.putCount).toBe(1);
    expect(hydrateGame(storage.value).turnIndex).toBe(1);

    closeConnections(gameRoom);
  });

  it('rolls back a joined mutation and reports storage failures without broadcasting', async () => {
    const stored = joinedGame();
    const { gameRoom, storage } = roomWithStorage(stored);
    storage.failPuts = true;
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');

    alice.client.send(JSON.stringify({ intent: { kind: 'endTurn' } }));

    await expect(alice.messages.next()).resolves.toEqual({
      type: 'error',
      message: 'storage unavailable',
    });
    expect(bob.messages.received).toHaveLength(1);
    expect(storage.putCount).toBe(1);
    expect(storage.value).toEqual(stored);

    storage.failPuts = false;
    alice.client.send(JSON.stringify({ intent: { kind: 'endTurn' } }));
    await expect(alice.messages.next()).resolves.toMatchObject({
      type: 'state',
      view: { myIndex: 0, turnIndex: 1 },
    });
    await expect(bob.messages.next()).resolves.toMatchObject({
      type: 'state',
      view: { myIndex: 1, turnIndex: 1 },
    });
    expect(storage.putCount).toBe(2);
    expect(hydrateGame(storage.value).turnIndex).toBe(1);

    closeConnections(gameRoom);
  });

  it('handles lobby membership, claims, host order, and redacted broadcasts', async () => {
    const { gameRoom, storage } = roomWithStorage();
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    expect(alice.initial).toEqual({
      type: 'lobby',
      gameId: 'game-1',
      hostUserId: null,
      players: [],
    });

    alice.client.send(JSON.stringify({
      intent: { kind: 'join', userId: 'attacker', name: ' Alice ' },
    }));
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'lobby',
      gameId: 'game-1',
      hostUserId: 'alice',
      players: [{ name: 'Alice', suspect: null, isHost: true }],
    });

    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    expect(bob.initial).toMatchObject({ type: 'lobby', hostUserId: 'alice' });
    bob.client.send(JSON.stringify({ intent: { kind: 'join', userId: 'alice', name: 'Bob' } }));
    await expect(alice.messages.next()).resolves.toMatchObject({
      type: 'lobby',
      hostUserId: 'alice',
      players: [
        { name: 'Alice', suspect: null, isHost: true },
        { name: 'Bob', suspect: null, isHost: false },
      ],
    });
    await expect(bob.messages.next()).resolves.toMatchObject({ type: 'lobby', hostUserId: 'alice' });

    bob.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Miss Scarlett' } }));
    await expect(bob.messages.next()).resolves.toMatchObject({ type: 'lobby' });
    await expect(alice.messages.next()).resolves.toMatchObject({ type: 'lobby' });
    alice.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Miss Scarlett' } }));
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'error', message: 'suspect is already claimed: Miss Scarlett',
    });
    expect(storage.putCount).toBe(3);
    expect(JSON.stringify(alice.messages.received)).not.toContain('solution');
    expect(JSON.stringify(alice.messages.received)).not.toContain('cards');

    closeConnections(gameRoom);
  });

  it('persists and reloads the lobby snapshot, reassigning its host when the host leaves', async () => {
    const first = roomWithStorage();
    const alice = await connectJoinedPlayer(first.gameRoom, 'alice');
    alice.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Alice' } }));
    await alice.messages.next();
    const bob = await connectJoinedPlayer(first.gameRoom, 'bob');
    bob.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Bob' } }));
    await alice.messages.next();
    await bob.messages.next();
    closeConnections(first.gameRoom);

    const reloaded = roomWithStorage(first.storage.value, first.storage.lobby);
    const bobReloaded = await connectJoinedPlayer(reloaded.gameRoom, 'bob');
    expect(bobReloaded.initial).toMatchObject({
      type: 'lobby',
      hostUserId: 'alice',
      players: [
        { name: 'Alice', suspect: null, isHost: true },
        { name: 'Bob', suspect: null, isHost: false },
      ],
    });
    const aliceReloaded = await connectJoinedPlayer(reloaded.gameRoom, 'alice');
    aliceReloaded.client.send(JSON.stringify({ intent: { kind: 'leave' } }));
    await expect(aliceReloaded.messages.next()).resolves.toEqual({
      type: 'lobby',
      gameId: 'game-1',
      hostUserId: 'bob',
      players: [{ name: 'Bob', suspect: null, isHost: true }],
    });
    await expect(bobReloaded.messages.next()).resolves.toEqual({
      type: 'lobby',
      gameId: 'game-1',
      hostUserId: 'bob',
      players: [{ name: 'Bob', suspect: null, isHost: true }],
    });
    closeConnections(reloaded.gameRoom);
  });

  it('preserves the host when order moves another player first', async () => {
    const { gameRoom, storage } = roomWithStorage();
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');

    alice.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Alice' } }));
    await alice.messages.next();
    await bob.messages.next();
    bob.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Bob' } }));
    await alice.messages.next();
    await bob.messages.next();
    alice.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Professor Plum' } }));
    await alice.messages.next();
    await bob.messages.next();
    bob.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Miss Scarlett' } }));
    await alice.messages.next();
    await bob.messages.next();

    alice.client.send(JSON.stringify({
      intent: { kind: 'setOrder', order: ['Miss Scarlett', 'Professor Plum'] },
    }));
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'lobby',
      gameId: 'game-1',
      hostUserId: 'alice',
      players: [
        { name: 'Bob', suspect: 'Miss Scarlett', isHost: false },
        { name: 'Alice', suspect: 'Professor Plum', isHost: true },
      ],
    });
    await expect(bob.messages.next()).resolves.toEqual({
      type: 'lobby',
      gameId: 'game-1',
      hostUserId: 'alice',
      players: [
        { name: 'Bob', suspect: 'Miss Scarlett', isHost: false },
        { name: 'Alice', suspect: 'Professor Plum', isHost: true },
      ],
    });
    expect(storage.lobby).toMatchObject({ hostUserId: 'alice' });

    closeConnections(gameRoom);
    const reloaded = roomWithStorage(storage.value, storage.lobby);
    const bobReloaded = await connectJoinedPlayer(reloaded.gameRoom, 'bob');
    const aliceReloaded = await connectJoinedPlayer(reloaded.gameRoom, 'alice');
    expect(bobReloaded.initial).toEqual({
      type: 'lobby',
      gameId: 'game-1',
      hostUserId: 'alice',
      players: [
        { name: 'Bob', suspect: 'Miss Scarlett', isHost: false },
        { name: 'Alice', suspect: 'Professor Plum', isHost: true },
      ],
    });

    bobReloaded.client.send(JSON.stringify({ intent: { kind: 'start' } }));
    await expect(bobReloaded.messages.next()).resolves.toEqual({
      type: 'error', message: 'only the host can perform this lobby action',
    });
    bobReloaded.client.send(JSON.stringify({
      intent: { kind: 'setOrder', order: ['Professor Plum', 'Miss Scarlett'] },
    }));
    await expect(bobReloaded.messages.next()).resolves.toEqual({
      type: 'error', message: 'only the host can perform this lobby action',
    });

    aliceReloaded.client.send(JSON.stringify({ intent: { kind: 'start' } }));
    await expect(aliceReloaded.messages.next()).resolves.toMatchObject({ type: 'state' });
    await expect(bobReloaded.messages.next()).resolves.toMatchObject({ type: 'state' });
    closeConnections(reloaded.gameRoom);
  });

  it('enforces host-only start/order and rejects invalid lifecycle payloads without mutation', async () => {
    const { gameRoom, storage } = roomWithStorage();
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    alice.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Alice' } }));
    await alice.messages.next();
    await bob.messages.next();
    bob.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Bob' } }));
    await alice.messages.next();
    await bob.messages.next();

    const beforeStart = JSON.stringify(storage.lobby);
    alice.client.send(JSON.stringify({ intent: { kind: 'start' } }));
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'error', message: 'every lobby player must claim a suspect before starting',
    });
    expect(JSON.stringify(storage.lobby)).toBe(beforeStart);
    bob.client.send(JSON.stringify({ intent: { kind: 'start' } }));
    await expect(bob.messages.next()).resolves.toEqual({
      type: 'error', message: 'only the host can perform this lobby action',
    });
    bob.client.send(JSON.stringify({ intent: { kind: 'setOrder', order: ['Miss Scarlett'] } }));
    await expect(bob.messages.next()).resolves.toEqual({
      type: 'error', message: 'only the host can perform this lobby action',
    });
    const beforeInvalid = JSON.stringify(storage.lobby);
    alice.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'invalid' } }));
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'error', message: 'invalid suspect: invalid',
    });
    expect(JSON.stringify(storage.lobby)).toBe(beforeInvalid);
    closeConnections(gameRoom);
  });

  it('starts valid canonical humans plus robots and invokes the robot hook', async () => {
    const { gameRoom, storage } = roomWithStorage();
    const hook = vi.spyOn(GameRoomClass.prototype, 'maybeRunRobot');
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    const spectator = await connectJoinedPlayer(gameRoom, 'spectator');

    alice.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Alice' } }));
    await alice.messages.next();
    await bob.messages.next();
    await spectator.messages.next();
    bob.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Bob' } }));
    await alice.messages.next();
    await bob.messages.next();
    await spectator.messages.next();
    alice.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Miss Scarlett' } }));
    await alice.messages.next();
    await bob.messages.next();
    await spectator.messages.next();
    bob.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Professor Plum' } }));
    await alice.messages.next();
    await bob.messages.next();
    await spectator.messages.next();

    alice.client.send(JSON.stringify({ intent: { kind: 'start' } }));
    await expect(alice.messages.next()).resolves.toMatchObject({ type: 'state', view: { myIndex: 0 } });
    await expect(bob.messages.next()).resolves.toMatchObject({ type: 'state', view: { myIndex: 1 } });
    await expect(spectator.messages.next()).resolves.toEqual({ type: 'ready' });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hydrateGame(storage.value).players).toHaveLength(6);
    expect(hydrateGame(storage.value).phase).toBe('playing');
    expect(hydrateGame(storage.value).players.slice(0, 2).map(player => player.userId)).toEqual(['alice', 'bob']);
    expect(hydrateGame(storage.value).players.slice(2).every(player => player.isRobot)).toBe(true);
    expect(storage.lobby).toEqual({ hostUserId: null, players: [] });
    hook.mockRestore();
    closeConnections(gameRoom);
  });

  it('atomically rejects a failed start without partial persistence or a success broadcast', async () => {
    const { gameRoom, storage } = roomWithStorage();
    const hook = vi.spyOn(GameRoomClass.prototype, 'maybeRunRobot');
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');

    alice.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Alice' } }));
    await alice.messages.next();
    await bob.messages.next();
    bob.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Bob' } }));
    await alice.messages.next();
    await bob.messages.next();
    alice.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Miss Scarlett' } }));
    await alice.messages.next();
    await bob.messages.next();
    bob.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Professor Plum' } }));
    await alice.messages.next();
    await bob.messages.next();

    const previousLobby = structuredClone(storage.lobby);
    storage.failTransactions = true;
    alice.client.send(JSON.stringify({ intent: { kind: 'start' } }));

    await expect(alice.messages.next()).resolves.toEqual({
      type: 'error', message: 'storage unavailable',
    });
    expect(bob.messages.received).toHaveLength(5);
    expect(storage.value).toBeUndefined();
    expect(storage.lobby).toEqual(previousLobby);
    expect(storage.transactionCount).toBe(1);
    expect(hook).not.toHaveBeenCalled();

    storage.failTransactions = false;
    alice.client.send(JSON.stringify({ intent: { kind: 'start' } }));
    await expect(alice.messages.next()).resolves.toMatchObject({ type: 'state' });
    await expect(bob.messages.next()).resolves.toMatchObject({ type: 'state' });
    expect(hook).toHaveBeenCalledTimes(1);
    closeConnections(gameRoom);
    hook.mockRestore();
  });

  it('serves a valid active game and repairs corrupt lobby persistence', async () => {
    const storedGame = joinedGame();
    const { gameRoom, storage } = roomWithStorage(storedGame, { players: [{ bad: true }] });

    const connection = await connectJoinedPlayer(gameRoom, 'alice');

    expect(connection.initial).toMatchObject({
      type: 'state',
      view: { myIndex: 0, turnIndex: 0 },
    });
    expect(storage.value).toEqual(storedGame);
    expect(storage.lobby).toEqual({ hostUserId: null, players: [] });
    connection.client.close();
  });

  it('resets corrupt lobby-only persistence without returning an error', async () => {
    const { gameRoom, storage } = roomWithStorage(undefined, { players: [{ bad: true }] });
    const connection = await connectJoinedPlayer(gameRoom, 'user');

    expect(connection.initial).toEqual({
      type: 'lobby',
      gameId: 'game-1',
      hostUserId: null,
      players: [],
    });
    expect(storage.lobby).toEqual({ hostUserId: null, players: [] });
    connection.client.close();
  });
});
