import { describe, expect, it, vi } from 'vitest';
import { buildBoard, createGame, spaceAt } from '@agathos/game';
import type { Card, Intent, Player } from '@agathos/game';
import { hydrateGame, serializeGame } from './game-storage';
import type { Env } from './index';
import { mintJwt } from './auth/jwt';
import {
  assertIntentAuthority,
  authenticateJwtProtocol,
  negotiateJwtProtocol,
  parseIntentEnvelope,
  resolveViewerIndex,
} from './game-room-protocol';

const JWT_SECRET = 'test-secret';

type TestWebSocketListener = (event: { data?: unknown }) => void;
type TestMessage =
  | { type: 'ready' }
  | {
    type: 'lobby';
    gameId: string;
    isHost: boolean;
    players: Array<{ name: string; suspect: Player['suspect'] | null; isHost: boolean }>;
  }
  | { type: 'error'; message: string; intentKind?: string }
  | {
    type: 'state';
    view: {
      myIndex: number;
      myHand: Card[];
      turnIndex: number;
    };
    events: unknown[];
  }
  | {
    type: 'private';
    reveal: { fromIndex: number; card?: Card };
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
  privateReveals: unknown;
  lobby: unknown;
  robotAlarmInfo: unknown;
  failPuts: boolean;
  remainingPutFailures: number;
  remainingGamePutFailures: number;
  failTransactions: boolean;
  failGetAlarm: boolean;
  failSetAlarm: boolean;
  putCount: number;
  transactionCount: number;
  alarm: number | null;
  setAlarmCount: number;
  deleteAlarmCount: number;
}

function roomWithStorage(
  stored?: unknown,
  storedLobby?: unknown,
  storedPrivateReveals?: unknown,
  envOverrides: Record<string, string> = {},
): { gameRoom: GameRoom; storage: TestStorage } {
  const storage: TestStorage = {
    value: stored,
    privateReveals: storedPrivateReveals,
    lobby: storedLobby,
    robotAlarmInfo: undefined,
    failPuts: false,
    remainingPutFailures: 0,
    remainingGamePutFailures: 0,
    failTransactions: false,
    failGetAlarm: false,
    failSetAlarm: false,
    putCount: 0,
    transactionCount: 0,
    alarm: null,
    setAlarmCount: 0,
    deleteAlarmCount: 0,
  };
  const ctx = {
    storage: {
      get: async <T>(key: string) =>
        (key === 'lobby'
          ? storage.lobby
          : key === 'robot-alarm-info'
            ? storage.robotAlarmInfo
            : key === 'lastShownCard' ? storage.privateReveals : storage.value) as T | undefined,
      put: async (key: string, value: unknown) => {
        storage.putCount += 1;
        if (storage.failPuts ||
          (key === 'game' && storage.remainingGamePutFailures > 0) ||
          storage.remainingPutFailures > 0) {
          if (key === 'game' && storage.remainingGamePutFailures > 0) {
            storage.remainingGamePutFailures -= 1;
          }
          if (storage.remainingPutFailures > 0) storage.remainingPutFailures -= 1;
          throw new Error('storage unavailable');
        }
        if (key === 'lobby') storage.lobby = value;
        else if (key === 'robot-alarm-info') storage.robotAlarmInfo = value;
        else if (key === 'lastShownCard') storage.privateReveals = value;
        else storage.value = value;
      },
      getAlarm: async () => {
        if (storage.failGetAlarm) throw new Error('getAlarm unavailable');
        return storage.alarm;
      },
      setAlarm: async (scheduledTime: number | Date) => {
        storage.setAlarmCount += 1;
        if (storage.failSetAlarm) throw new Error('setAlarm unavailable');
        storage.alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
      },
      deleteAlarm: async () => {
        storage.alarm = null;
        storage.deleteAlarmCount += 1;
        return true;
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
          else if (key === 'lastShownCard') storage.privateReveals = value;
          else storage.value = value;
        }
        return result;
      },
    },
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
  } as unknown as DurableObjectState;
  return {
    gameRoom: new GameRoomClass(ctx, { JWT_SECRET, ...envOverrides } as Env),
    storage,
  };
}

function room(stored?: unknown): GameRoom {
  return roomWithStorage(stored).gameRoom;
}

async function upgradeRequest(protocol: string): Promise<Request> {
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
  const token = await mintJwt({ userId }, JWT_SECRET, 60);
  const response = await gameRoom.fetch(await upgradeRequest(`bearer.${token}`));
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

function robotTurnGame(): ReturnType<typeof serializeGame> {
  const stored = joinedGame();
  stored.players[0]!.isRobot = true;
  stored.players[0]!.failedAccusation = true;
  delete stored.players[0]!.userId;
  return stored;
}

function pendingRevealGame(revealerIsRobot: boolean, revealerCards: Card[]): ReturnType<typeof serializeGame> {
  const game = hydrateGame(joinedGame());
  game.players[1]!.isRobot = revealerIsRobot;
  game.players[1]!.cards = revealerCards;
  game.pendingReveal = {
    suggesterIndex: 0,
    suspect: 'Professor Plum',
    weapon: 'Lead Pipe',
    room: 'Hall',
    revealerIndex: 1,
  };
  return serializeGame(game);
}

describe('GameRoom protocol helpers', () => {
  it('accepts only a verified bearer JWT protocol', async () => {
    const token = await mintJwt({ userId: 'alice', scope: 'game' }, JWT_SECRET, 60);
    await expect(authenticateJwtProtocol(`bearer.${token}`, JWT_SECRET)).resolves.toMatchObject({
      protocol: `bearer.${token}`,
      userId: 'alice',
      claims: { userId: 'alice', scope: 'game' },
    });
    await expect(authenticateJwtProtocol('bearer.dev-token-alice', JWT_SECRET)).resolves.toBeNull();
    await expect(authenticateJwtProtocol(`Bearer.${token}`, JWT_SECRET)).resolves.toBeNull();
    await expect(authenticateJwtProtocol('bearer.', JWT_SECRET)).resolves.toBeNull();

    const issuedAt = Math.floor(Date.now() / 1_000) - 1;
    const boundaryId = 'x'.repeat(128);
    await expect(authenticateJwtProtocol(
      `bearer.${await signRawClaims({ userId: boundaryId, iat: issuedAt, exp: issuedAt + 86_400 })}`,
      JWT_SECRET,
    )).resolves.toMatchObject({ userId: boundaryId });
    const invalidClaims = [
      { userId: boundaryId, iat: issuedAt },
      { userId: boundaryId, exp: issuedAt + 60 },
      { userId: boundaryId, iat: issuedAt, exp: issuedAt + 86_401 },
      { userId: 'alice smith', iat: issuedAt, exp: issuedAt + 60 },
      { userId: 'x'.repeat(129), iat: issuedAt, exp: issuedAt + 60 },
    ];
    for (const claims of invalidClaims) {
      await expect(authenticateJwtProtocol(
        `bearer.${await signRawClaims(claims)}`,
        JWT_SECRET,
      )).resolves.toBeNull();
    }
  });

  it('selects and preserves the offered authenticated protocol', () => {
    return mintJwt({ userId: 'user' }, JWT_SECRET, 60).then(token =>
      expect(negotiateJwtProtocol(`other, bearer.${token}`, JWT_SECRET)).resolves.toMatchObject({
        protocol: `bearer.${token}`,
        userId: 'user',
      }));
  });

  it('rejects malformed JSON and envelopes', () => {
    expect(() => parseIntentEnvelope('{')).toThrow('malformed JSON message');
    expect(() => parseIntentEnvelope(JSON.stringify({ intent: null }))).toThrow(
      'invalid intent envelope',
    );
    expect(() => parseIntentEnvelope(JSON.stringify({ intent: { kind: 7 } }))).toThrow(
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

    const token = await mintJwt({ userId: 'user' }, JWT_SECRET, 60);
    const response = await gameRoom.fetch(await upgradeRequest(`bearer.${token}`));

    expect(response.status).toBe(101);
    expect(response.headers.get('Sec-WebSocket-Protocol')).toBe(`bearer.${token}`);
    response.webSocket?.accept();
    response.webSocket?.close();
    closeConnections(gameRoom);
  });

  it('processes queued WebSocket messages in arrival order', async () => {
    const gameRoom = room();
    const token = await mintJwt({ userId: 'user' }, JWT_SECRET, 60);
    const response = await gameRoom.fetch(await upgradeRequest(`bearer.${token}`));
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
          isHost: false,
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

    const token = await mintJwt({ userId: 'user' }, JWT_SECRET, 60);
    const response = await gameRoom.fetch(await upgradeRequest(`bearer.${token}`));

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

  it('sends a human show privately after persistence without putting the card in state', async () => {
    const { gameRoom, storage } = roomWithStorage(pendingRevealGame(false, [
      { type: 'weapon', weapon: 'Lead Pipe' },
    ]));
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');

    bob.client.send(JSON.stringify({ intent: {
      kind: 'showCard', card: { type: 'weapon', weapon: 'Lead Pipe' },
    } }));

    const aliceState = await alice.messages.next();
    await expect(bob.messages.next()).resolves.toMatchObject({
      type: 'state', view: { pendingReveal: null },
    });
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'private',
      reveal: { fromIndex: 1, card: { type: 'weapon', weapon: 'Lead Pipe' } },
    });
    expect(JSON.stringify(aliceState)).not.toContain('Lead Pipe');
    expect(storage.value).toEqual(expect.not.objectContaining({ lastShownCard: expect.anything() }));
    expect(storage.privateReveals).toEqual({
      alice: { fromIndex: 1, card: { type: 'weapon', weapon: 'Lead Pipe' } },
    });
    closeConnections(gameRoom);
  });

  it('sends a human decline privately without a card', async () => {
    const { gameRoom, storage } = roomWithStorage(pendingRevealGame(false, []));
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');

    bob.client.send(JSON.stringify({ intent: { kind: 'declineReveal' } }));

    await expect(alice.messages.next()).resolves.toMatchObject({
      type: 'state', view: { pendingReveal: null },
    });
    await expect(bob.messages.next()).resolves.toMatchObject({
      type: 'state', view: { pendingReveal: null },
    });
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'private', reveal: { fromIndex: 1 },
    });
    expect(storage.privateReveals).toEqual({ alice: { fromIndex: 1 } });
    closeConnections(gameRoom);
  });

  it('does not deliver a private reveal to another connected identity', async () => {
    const { gameRoom } = roomWithStorage(pendingRevealGame(false, [
      { type: 'weapon', weapon: 'Lead Pipe' },
    ]));
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    const spectator = await connectJoinedPlayer(gameRoom, 'spectator');

    bob.client.send(JSON.stringify({ intent: {
      kind: 'showCard', card: { type: 'weapon', weapon: 'Lead Pipe' },
    } }));

    await alice.messages.next();
    await bob.messages.next();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(spectator.messages.received.some(message => message.type === 'private')).toBe(false);
    closeConnections(gameRoom);
  });

  it('delivers robot show and decline frames to the human suggester', async () => {
    const shown = roomWithStorage(pendingRevealGame(true, [
      { type: 'weapon', weapon: 'Lead Pipe' },
    ]));
    const shownAlice = await connectJoinedPlayer(shown.gameRoom, 'alice');
    await shown.gameRoom.maybeRunRobot();
    await shownAlice.messages.next();
    await expect(shownAlice.messages.next()).resolves.toEqual({
      type: 'private',
      reveal: { fromIndex: 1, card: { type: 'weapon', weapon: 'Lead Pipe' } },
    });
    closeConnections(shown.gameRoom);

    const declined = roomWithStorage(pendingRevealGame(true, []));
    const declinedAlice = await connectJoinedPlayer(declined.gameRoom, 'alice');
    await declined.gameRoom.maybeRunRobot();
    await declinedAlice.messages.next();
    await expect(declinedAlice.messages.next()).resolves.toEqual({
      type: 'private', reveal: { fromIndex: 1 },
    });
    closeConnections(declined.gameRoom);
  });

  it('retains an undelivered robot reveal for the correct reconnecting human', async () => {
    const first = roomWithStorage(pendingRevealGame(true, [
      { type: 'weapon', weapon: 'Lead Pipe' },
    ]));
    await first.gameRoom.maybeRunRobot();
    expect(first.storage.privateReveals).toEqual({
      alice: { fromIndex: 1, card: { type: 'weapon', weapon: 'Lead Pipe' } },
    });

    const reloaded = roomWithStorage(
      first.storage.value,
      undefined,
      first.storage.privateReveals,
    );
    const alice = await connectJoinedPlayer(reloaded.gameRoom, 'alice');
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'private',
      reveal: { fromIndex: 1, card: { type: 'weapon', weapon: 'Lead Pipe' } },
    });
    closeConnections(reloaded.gameRoom);
  });

  it('replays only the recipient latest reveal and replaces it after a later suggestion', async () => {
    const stored = pendingRevealGame(false, [
      { type: 'weapon', weapon: 'Lead Pipe' },
      { type: 'suspect', suspect: 'Professor Plum' },
    ]);
    stored.players[0]!.location = 'Hall';
    stored.players[0]!.enteredRoomThisTurn = true;
    const { gameRoom, storage } = roomWithStorage(stored);
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');

    bob.client.send(JSON.stringify({ intent: {
      kind: 'showCard', card: { type: 'weapon', weapon: 'Lead Pipe' },
    } }));
    await alice.messages.next();
    await bob.messages.next();
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'private',
      reveal: { fromIndex: 1, card: { type: 'weapon', weapon: 'Lead Pipe' } },
    });
    closeConnections(gameRoom);

    const aliceReloaded = await connectJoinedPlayer(gameRoom, 'alice');
    await expect(aliceReloaded.messages.next()).resolves.toEqual({
      type: 'private',
      reveal: { fromIndex: 1, card: { type: 'weapon', weapon: 'Lead Pipe' } },
    });
    const bobReloaded = await connectJoinedPlayer(gameRoom, 'bob');
    expect(bobReloaded.messages.received.some(message => message.type === 'private')).toBe(false);

    aliceReloaded.client.send(JSON.stringify({ intent: {
      kind: 'suggest', suspect: 'Professor Plum', weapon: 'Dagger',
    } }));
    await aliceReloaded.messages.next();
    await bobReloaded.messages.next();
    expect(storage.privateReveals).toEqual({});

    bobReloaded.client.send(JSON.stringify({ intent: {
      kind: 'showCard', card: { type: 'suspect', suspect: 'Professor Plum' },
    } }));
    await aliceReloaded.messages.next();
    await bobReloaded.messages.next();
    await expect(aliceReloaded.messages.next()).resolves.toEqual({
      type: 'private',
      reveal: { fromIndex: 1, card: { type: 'suspect', suspect: 'Professor Plum' } },
    });
    expect(storage.privateReveals).toEqual({
      alice: { fromIndex: 1, card: { type: 'suspect', suspect: 'Professor Plum' } },
    });
    expect(bobReloaded.messages.received.some(message => message.type === 'private')).toBe(false);
    closeConnections(gameRoom);
  });

  it('does not broadcast or persist a reveal when game/private persistence fails', async () => {
    const stored = pendingRevealGame(false, [
      { type: 'weapon', weapon: 'Lead Pipe' },
    ]);
    const { gameRoom, storage } = roomWithStorage(stored);
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    storage.failTransactions = true;

    bob.client.send(JSON.stringify({ intent: {
      kind: 'showCard', card: { type: 'weapon', weapon: 'Lead Pipe' },
    } }));

    await expect(bob.messages.next()).resolves.toEqual({
      type: 'error', message: 'storage unavailable', intentKind: 'showCard',
    });
    expect(alice.messages.received).toHaveLength(1);
    expect(storage.value).toEqual(stored);
    expect(storage.privateReveals).toBeUndefined();
    closeConnections(gameRoom);
  });

  it('persists a robot reveal without requiring a connected recipient', async () => {
    const { gameRoom, storage } = roomWithStorage(pendingRevealGame(true, []));

    await gameRoom.maybeRunRobot();

    expect(hydrateGame(storage.value).pendingReveal).toBeNull();
    expect(storage.privateReveals).toEqual({ alice: { fromIndex: 1 } });
  });

  it('rolls back a joined mutation and reports storage failures without broadcasting', async () => {
    const stored = joinedGame();
    const { gameRoom, storage } = roomWithStorage(stored);
    storage.remainingGamePutFailures = 1;
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    const bob = await connectJoinedPlayer(gameRoom, 'bob');

    alice.client.send(JSON.stringify({ intent: { kind: 'endTurn' } }));

    await expect(alice.messages.next()).resolves.toEqual({
      type: 'error',
      message: 'storage unavailable',
      intentKind: 'endTurn',
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
      isHost: false,
      players: [],
    });

    alice.client.send(JSON.stringify({
      intent: { kind: 'join', userId: 'attacker', name: ' Alice ' },
    }));
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'lobby',
      gameId: 'game-1',
      isHost: true,
      players: [{ name: 'Alice', suspect: null, isHost: true }],
    });

    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    expect(bob.initial).toMatchObject({ type: 'lobby', isHost: false });
    expect(JSON.stringify(bob.initial)).not.toContain('alice');
    bob.client.send(JSON.stringify({ intent: { kind: 'join', userId: 'alice', name: 'Bob' } }));
    await expect(alice.messages.next()).resolves.toMatchObject({
      type: 'lobby',
      isHost: true,
      players: [
        { name: 'Alice', suspect: null, isHost: true },
        { name: 'Bob', suspect: null, isHost: false },
      ],
    });
    await expect(bob.messages.next()).resolves.toMatchObject({ type: 'lobby', isHost: false });

    bob.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Miss Scarlett' } }));
    await expect(bob.messages.next()).resolves.toMatchObject({ type: 'lobby' });
    await expect(alice.messages.next()).resolves.toMatchObject({ type: 'lobby' });
    alice.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Alice replay' } }));
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'lobby',
      gameId: 'game-1',
      isHost: true,
      players: [
        { name: 'Alice', suspect: null, isHost: true },
        { name: 'Bob', suspect: 'Miss Scarlett', isHost: false },
      ],
    });
    await expect(bob.messages.next()).resolves.toMatchObject({
      type: 'lobby',
      isHost: false,
      players: [{ name: 'Alice', suspect: null }, { name: 'Bob', suspect: 'Miss Scarlett' }],
    });
    alice.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Miss Scarlett' } }));
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'error', message: 'suspect is already claimed: Miss Scarlett', intentKind: 'claimSuspect',
    });
    expect(storage.putCount).toBe(4);
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
      isHost: false,
      players: [
        { name: 'Alice', suspect: null, isHost: true },
        { name: 'Bob', suspect: null, isHost: false },
      ],
    });
    const aliceReloaded = await connectJoinedPlayer(reloaded.gameRoom, 'alice');
    expect(aliceReloaded.initial).toEqual({
      type: 'lobby',
      gameId: 'game-1',
      isHost: true,
      players: [
        { name: 'Alice', suspect: null, isHost: true },
        { name: 'Bob', suspect: null, isHost: false },
      ],
    });
    aliceReloaded.client.send(JSON.stringify({ intent: { kind: 'leave' } }));
    await expect(aliceReloaded.messages.next()).resolves.toEqual({
      type: 'lobby',
      gameId: 'game-1',
      isHost: false,
      players: [{ name: 'Bob', suspect: null, isHost: true }],
    });
    await expect(bobReloaded.messages.next()).resolves.toEqual({
      type: 'lobby',
      gameId: 'game-1',
      isHost: true,
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
      isHost: true,
      players: [
        { name: 'Bob', suspect: 'Miss Scarlett', isHost: false },
        { name: 'Alice', suspect: 'Professor Plum', isHost: true },
      ],
    });
    await expect(bob.messages.next()).resolves.toEqual({
      type: 'lobby',
      gameId: 'game-1',
      isHost: false,
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
      isHost: false,
      players: [
        { name: 'Bob', suspect: 'Miss Scarlett', isHost: false },
        { name: 'Alice', suspect: 'Professor Plum', isHost: true },
      ],
    });

    bobReloaded.client.send(JSON.stringify({ intent: { kind: 'start' } }));
    await expect(bobReloaded.messages.next()).resolves.toEqual({
      type: 'error', message: 'only the host can perform this lobby action', intentKind: 'start',
    });
    bobReloaded.client.send(JSON.stringify({
      intent: { kind: 'setOrder', order: ['Professor Plum', 'Miss Scarlett'] },
    }));
    await expect(bobReloaded.messages.next()).resolves.toEqual({
      type: 'error', message: 'only the host can perform this lobby action', intentKind: 'setOrder',
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
      type: 'error', message: 'every lobby player must claim a suspect before starting', intentKind: 'start',
    });
    expect(JSON.stringify(storage.lobby)).toBe(beforeStart);
    bob.client.send(JSON.stringify({ intent: { kind: 'start' } }));
    await expect(bob.messages.next()).resolves.toEqual({
      type: 'error', message: 'only the host can perform this lobby action', intentKind: 'start',
    });
    bob.client.send(JSON.stringify({ intent: { kind: 'setOrder', order: ['Miss Scarlett'] } }));
    await expect(bob.messages.next()).resolves.toEqual({
      type: 'error', message: 'only the host can perform this lobby action', intentKind: 'setOrder',
    });
    const beforeInvalid = JSON.stringify(storage.lobby);
    alice.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'invalid' } }));
    await expect(alice.messages.next()).resolves.toEqual({
      type: 'error', message: 'invalid suspect: invalid', intentKind: 'claimSuspect',
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
      type: 'error', message: 'storage unavailable', intentKind: 'start',
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
      isHost: false,
      players: [],
    });
    expect(storage.lobby).toEqual({ hostUserId: null, players: [] });
    connection.client.close();
  });

  it('paces robot actions one alarm step at a time when configured', async () => {
    const { gameRoom, storage } = roomWithStorage(undefined, undefined, undefined, {
      ROBOT_STEP_PACE_MS: '900',
    });
    const alice = await connectJoinedPlayer(gameRoom, 'alice');
    alice.client.send(JSON.stringify({ intent: { kind: 'join', name: 'Alice' } }));
    await alice.messages.next();
    alice.client.send(JSON.stringify({ intent: { kind: 'claimSuspect', suspect: 'Miss Scarlett' } }));
    await alice.messages.next();

    alice.client.send(JSON.stringify({ intent: { kind: 'start' } }));
    await expect(alice.messages.next()).resolves.toMatchObject({ type: 'state', view: { myIndex: 0 } });

    // Alice takes her real turn so the first robot becomes actionable.
    alice.client.send(JSON.stringify({ intent: { kind: 'roll' } }));
    const rolledFrame = await alice.messages.next();
    expect(rolledFrame).toMatchObject({ type: 'state', events: [{ type: 'rolled' }] });
    const destination =
      (rolledFrame as { view: { reachableSpacesHints?: string[] } }).view
        .reachableSpacesHints?.[0];
    expect(destination).toBeDefined();
    alice.client.send(JSON.stringify({ intent: { kind: 'moveTo', destination } }));
    await alice.messages.next();
    alice.client.send(JSON.stringify({ intent: { kind: 'endTurn' } }));
    await alice.messages.next();

    // The handoff performs exactly one paced robot step (the roll), then stops.
    await vi.waitFor(() => {
      const game = hydrateGame(storage.value);
      expect(game.turnIndex).toBe(1);
      expect(game.hasRolledThisTurn).toBe(true);
    });
    let game = hydrateGame(storage.value);
    expect(game.phase).toBe('playing');
    expect(game.turnIndex).toBe(1);
    expect(game.players[1]!.isRobot).toBe(true);
    expect(game.hasMovedThisTurn).toBe(false);
    expect(game.pendingReveal).toBeNull();
    expect(storage.alarm).not.toBeNull();
    // First robot action starts a new phase: base pace + phase bonus.
    const delta = (storage.alarm as number) - Date.now();
    expect(delta).toBeGreaterThan(1_200);
    expect(delta).toBeLessThan(2_200);

    // The next alarm performs the next single action (the move), no further.
    await gameRoom.alarm();
    game = hydrateGame(storage.value);
    expect(game.turnIndex).toBe(1);
    expect(game.hasRolledThisTurn).toBe(true);
    expect(game.hasMovedThisTurn).toBe(true);
    closeConnections(gameRoom);
  });

  it('deduplicates concurrent robot scheduler runs', async () => {
    const { gameRoom, storage } = roomWithStorage(robotTurnGame());

    await Promise.all([gameRoom.maybeRunRobot(), gameRoom.maybeRunRobot()]);

    expect(storage.putCount).toBe(1);
    expect(hydrateGame(storage.value).turnIndex).toBe(1);
  });

  it('logs autonomous failures without sending WebSocket errors or losing state', async () => {
    const { gameRoom, storage } = roomWithStorage(robotTurnGame());
    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    const before = structuredClone(storage.value);
    storage.remainingGamePutFailures = 1;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await gameRoom.maybeRunRobot();
      expect(log).toHaveBeenCalledWith('robot scheduler failed: storage unavailable');
      expect(bob.messages.received).toHaveLength(1);
      expect(storage.value).toEqual(before);
      expect(storage.setAlarmCount).toBe(1);
      expect(storage.alarm).not.toBeNull();
    } finally {
      log.mockRestore();
      closeConnections(gameRoom);
    }
  });

  it('does not run robots for a finished game', async () => {
    const stored = robotTurnGame();
    stored.phase = 'finished';
    stored.winnerIndex = 1;
    stored.finishedAt = 1;
    const { gameRoom, storage } = roomWithStorage(stored);

    await gameRoom.maybeRunRobot();

    expect(storage.putCount).toBe(0);
  });

  it('retries failed robot persistence without partial broadcasts and advances later', async () => {
    const { gameRoom, storage } = roomWithStorage(robotTurnGame());
    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    const before = structuredClone(storage.value);
    storage.remainingGamePutFailures = 2;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await gameRoom.maybeRunRobot();

      expect(storage.value).toEqual(before);
      expect(bob.messages.received).toHaveLength(1);
      expect(storage.setAlarmCount).toBe(1);
      const firstAlarm = storage.alarm;
      expect(firstAlarm).not.toBeNull();

      storage.alarm = null;
      await expect(gameRoom.alarm({ isRetry: false, retryCount: 0, scheduledTime: firstAlarm! }))
        .rejects.toThrow('storage unavailable');

      expect(storage.value).toEqual(before);
      expect(bob.messages.received).toHaveLength(1);
      expect(storage.setAlarmCount).toBe(2);
      const secondAlarm = storage.alarm;
      expect(secondAlarm).not.toBeNull();
      expect(secondAlarm).toBeGreaterThan(firstAlarm!);

      storage.alarm = null;
      await gameRoom.alarm({ isRetry: true, retryCount: 1, scheduledTime: secondAlarm! });

      expect(hydrateGame(storage.value).turnIndex).toBe(1);
      await expect(bob.messages.next()).resolves.toMatchObject({ type: 'state' });
      expect(storage.alarm).toBeNull();
      expect(storage.setAlarmCount).toBe(2);
    } finally {
      log.mockRestore();
      closeConnections(gameRoom);
    }
  });

  it('logs malformed alarms and remains recoverable through a later alarm', async () => {
    const { gameRoom, storage } = roomWithStorage(robotTurnGame());
    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    storage.remainingGamePutFailures = 1;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(gameRoom.alarm({} as AlarmInvocationInfo)).rejects.toThrow('storage unavailable');
      expect(log).toHaveBeenCalledWith('robot alarm received malformed invocation');
      expect(storage.setAlarmCount).toBe(1);
      expect(bob.messages.received).toHaveLength(1);

      storage.alarm = null;
      await gameRoom.alarm({ isRetry: true, retryCount: 1, scheduledTime: Date.now() });

      expect(hydrateGame(storage.value).turnIndex).toBe(1);
      await expect(bob.messages.next()).resolves.toMatchObject({ type: 'state' });
    } finally {
      log.mockRestore();
      closeConnections(gameRoom);
    }
  });

  it('rethrows getAlarm failures without broadcasting and progresses on a later alarm', async () => {
    const { gameRoom, storage } = roomWithStorage(robotTurnGame());
    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    storage.remainingGamePutFailures = 1;
    storage.failGetAlarm = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(gameRoom.alarm({ isRetry: false, retryCount: 0, scheduledTime: Date.now() }))
        .rejects.toThrow('getAlarm unavailable');
      expect(storage.robotAlarmInfo).toEqual({ retryCount: 1 });
      expect(storage.alarm).toBeNull();
      expect(bob.messages.received).toHaveLength(1);

      storage.failGetAlarm = false;
      await gameRoom.alarm({ isRetry: true, retryCount: 1, scheduledTime: Date.now() });

      expect(hydrateGame(storage.value).turnIndex).toBe(1);
      await expect(bob.messages.next()).resolves.toMatchObject({ type: 'state' });
      expect(storage.robotAlarmInfo).toEqual({ retryCount: 0 });
    } finally {
      log.mockRestore();
      closeConnections(gameRoom);
    }
  });

  it('rethrows setAlarm failures without broadcasting and progresses on a later alarm', async () => {
    const { gameRoom, storage } = roomWithStorage(robotTurnGame());
    const bob = await connectJoinedPlayer(gameRoom, 'bob');
    storage.remainingGamePutFailures = 1;
    storage.failSetAlarm = true;

    await expect(gameRoom.alarm({ isRetry: false, retryCount: 0, scheduledTime: Date.now() }))
      .rejects.toThrow('setAlarm unavailable');
    expect(storage.robotAlarmInfo).toEqual({ retryCount: 1 });
    expect(storage.alarm).toBeNull();
    expect(bob.messages.received).toHaveLength(1);

    storage.failSetAlarm = false;
    await gameRoom.alarm({ isRetry: true, retryCount: 1, scheduledTime: Date.now() });

    expect(hydrateGame(storage.value).turnIndex).toBe(1);
    await expect(bob.messages.next()).resolves.toMatchObject({ type: 'state' });
    expect(storage.robotAlarmInfo).toEqual({ retryCount: 0 });
    closeConnections(gameRoom);
  });

  it('hydrates retry backoff in a fresh GameRoom instance', async () => {
    const first = roomWithStorage(robotTurnGame());
    await connectJoinedPlayer(first.gameRoom, 'bob');
    first.storage.remainingGamePutFailures = 1;

    await first.gameRoom.maybeRunRobot();

    const firstAlarm = first.storage.alarm;
    expect(firstAlarm).not.toBeNull();
    expect(first.storage.robotAlarmInfo).toEqual({ retryCount: 1 });
    closeConnections(first.gameRoom);
    const reloaded = roomWithStorage(first.storage.value, first.storage.lobby);
    reloaded.storage.robotAlarmInfo = first.storage.robotAlarmInfo;
    const secondBob = await connectJoinedPlayer(reloaded.gameRoom, 'bob');
    reloaded.storage.remainingGamePutFailures = 1;
    reloaded.storage.alarm = null;

    await expect(reloaded.gameRoom.alarm({
      isRetry: false,
      retryCount: 0,
      scheduledTime: firstAlarm!,
    })).rejects.toThrow('storage unavailable');

    expect(reloaded.storage.robotAlarmInfo).toEqual({ retryCount: 2 });
    const secondAlarm = reloaded.storage.alarm;
    expect(secondAlarm).toBeGreaterThan(firstAlarm!);
    expect(secondBob.messages.received).toHaveLength(1);

    reloaded.storage.alarm = null;
    await reloaded.gameRoom.alarm({
      isRetry: true,
      retryCount: 1,
      scheduledTime: secondAlarm!,
    });

    expect(hydrateGame(reloaded.storage.value).turnIndex).toBe(1);
    await expect(secondBob.messages.next()).resolves.toMatchObject({ type: 'state' });
    expect(reloaded.storage.robotAlarmInfo).toEqual({ retryCount: 0 });
    closeConnections(reloaded.gameRoom);
  });
});

async function signRawClaims(claims: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder();
  const encode = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  };
  const input = `${encode(encoder.encode('{"alg":"HS256","typ":"JWT"}'))}.${encode(encoder.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(input));
  return `${input}.${encode(new Uint8Array(signature))}`;
}
