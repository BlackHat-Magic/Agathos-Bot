import { DurableObject } from 'cloudflare:workers';
import {
  applyIntent,
  begin,
  createGame,
  toView,
} from '@agathos/game';
import type { Game, Intent } from '@agathos/game';
import { assertCard } from '@agathos/game';
import type { Card } from '@agathos/game';
import type { Env } from './index';
import {
  createInitialGame,
  hydratePrivateReveals,
  hydrateGame,
  serializePrivateReveals,
  serializeGame,
} from './game-storage';
import type { PersistedPrivateReveals } from './game-storage';
import {
  LOBBY_STORAGE_KEY,
  claimLobbySuspect,
  createLobby,
  createStartPlayers,
  hydrateLobby,
  joinLobby,
  leaveLobby,
  lobbyView,
  requireLobbyHost,
  serializeLobby,
  setLobbyOrder,
} from './lobbies';
import type { LobbyState } from './lobbies';
import {
  assertIntentAuthority,
  authenticateJwtProtocol,
  negotiateJwtProtocol,
  parseIntentEnvelope,
  resolveViewerIndex,
} from './game-room-protocol';
import { hasRobotActionableState, runRobotScheduler } from './robots/scheduler';
import type { RobotPrivateReveal } from './robots/scheduler';
import type { PrivateRevealFrame } from './game-room-protocol';
export {
  assertIntentAuthority,
  authenticateJwtProtocol,
  negotiateJwtProtocol,
  parseIntentEnvelope,
  resolveViewerIndex,
} from './game-room-protocol';

const STORAGE_KEY = 'game';
const PRIVATE_REVEALS_STORAGE_KEY = 'lastShownCard';
const ROBOT_ALARM_INFO_STORAGE_KEY = 'robot-alarm-info';
const ROBOT_RETRY_INITIAL_DELAY_MS = 1_000;
const ROBOT_RETRY_MAX_DELAY_MS = 60_000;
const ROBOT_RETRY_MAX_ATTEMPT = 6;

interface RobotAlarmInfo {
  retryCount: number;
}

interface Connection {
  ws: WebSocket;
  userId: string;
  viewerIndex: number | null;
}

export class GameRoom extends DurableObject<Env> {
  private game: Game | undefined;
  private privateReveals: PersistedPrivateReveals = {};
  private lobby: LobbyState | undefined;
  private gameLoad: Promise<Game> | undefined;
  private messageQueue: Promise<void> = Promise.resolve();
  private robotRun: Promise<void> | undefined;
  private robotRetryAttempt = 0;
  private robotAlarmScheduled = false;
  private readonly connections = new Map<WebSocket, Connection>();
  private gameId = '';

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
    if (url.searchParams.get('gameId') === null || url.searchParams.get('gameId') === '') {
      return new Response('gameId is required', { status: 400 });
    }
    this.gameId = url.searchParams.get('gameId')!;
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const negotiated = await negotiateJwtProtocol(
      req.headers.get('Sec-WebSocket-Protocol'),
      this.env.JWT_SECRET,
    );
    if (negotiated === null) return new Response('Unauthorized', { status: 401 });

    let server: WebSocket | undefined;
    try {
      const game = await this.loadGame();
      const pair = new WebSocketPair();
      const client = pair[0];
      const serverSocket = pair[1];
      server = serverSocket;
      const connection: Connection = {
        ws: serverSocket,
        userId: negotiated.userId,
        viewerIndex: game.phase === 'lobby' ? null : resolveViewerIndex(game, negotiated.userId),
      };
      const initialPayload = game.phase === 'lobby'
        ? lobbyView(this.lobby!, this.gameId, connection.userId)
          : connection.viewerIndex === null
          ? { type: 'ready' as const }
          : {
            type: 'state' as const,
            view: toView(game, connection.viewerIndex),
            events: [],
          };

      this.connections.set(serverSocket, connection);
      serverSocket.accept();
      serverSocket.addEventListener('message', event => {
        const data = event.data;
        if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
          this.enqueueMessage(connection, null);
          return;
        }
        this.enqueueMessage(connection, data);
      });
      serverSocket.addEventListener('close', () => this.removeConnection(serverSocket));
      serverSocket.addEventListener('error', () => this.removeConnection(serverSocket));

      this.sendJson(connection, initialPayload);
      if (connection.viewerIndex !== null) this.sendPrivateReveal(connection);

      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { 'Sec-WebSocket-Protocol': negotiated.protocol },
      });
    } catch (error) {
      if (server !== undefined) {
        this.removeConnection(server);
        try {
          server.close(1011, 'connection setup failed');
        } catch {
          // The socket may not have been accepted; removal above is authoritative.
        }
      }
      return new Response('internal server error', { status: 500 });
    }
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    if (alarmInfo !== undefined && !isAlarmInvocationInfo(alarmInfo)) {
      console.error('robot alarm received malformed invocation');
    }
    this.robotAlarmScheduled = false;
    try {
      await this.enqueueRoomTask(async () => {
        await this.loadGame();
        await this.applyAlarmRetryCount(alarmInfo);
        if (this.game === undefined || !hasRobotActionableState(this.game)) {
          await this.resetRobotRetry();
          return;
        }
        await this.runRobotIfNeededWithFailurePolicy(true);
      });
    } catch (error) {
      console.error(`robot alarm failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  async maybeRunRobot(alreadyQueued = false): Promise<void> {
    if (alreadyQueued) {
      await this.runRobotIfNeeded();
      return;
    }
    await this.enqueueRoomTask(() => this.runRobotIfNeeded());
  }

  private async runRobotIfNeeded(): Promise<void> {
    return this.runRobotIfNeededWithFailurePolicy(false);
  }

  private async runRobotIfNeededWithFailurePolicy(propagateFailure: boolean): Promise<void> {
    if (this.robotRun !== undefined) return this.robotRun;

    const run = this.runRobotScheduler();
    this.robotRun = run;
    try {
      await run;
    } catch (error) {
      console.error(`robot scheduler failed: ${errorMessage(error)}`);
      if (propagateFailure) throw error;
    } finally {
      if (this.robotRun === run) this.robotRun = undefined;
    }
  }

  private async runRobotScheduler(): Promise<void> {
    await this.loadGame();
    try {
      await runRobotScheduler({
        getGame: () => {
          if (this.game === undefined) throw new Error('game state is not loaded');
          return this.game;
        },
        snapshot: serializeGame,
        restore: snapshot => { this.game = hydrateGame(snapshot); },
        persist: (game, privateReveal) => this.persistRobotMutation(game, privateReveal),
        broadcast: (events, privateReveal) => this.broadcast(events, privateReveal),
      });
      await this.resetRobotRetry();
    } catch (error) {
      if (this.game !== undefined && hasRobotActionableState(this.game)) {
        try {
          await this.scheduleRobotRetry();
        } catch (scheduleError) {
          console.error(`robot retry scheduling failed: ${errorMessage(scheduleError)}`);
          throw scheduleError;
        }
      } else {
        await this.resetRobotRetry();
      }
      throw error;
    }
  }

  private async loadGame(): Promise<Game> {
    if (this.game !== undefined && this.lobby !== undefined) return this.game;
    this.gameLoad ??= this.ctx.blockConcurrencyWhile(async () => {
      const storedGame = await this.ctx.storage.get<unknown>(STORAGE_KEY);
      this.game = storedGame === undefined ? createInitialGame() : hydrateGame(storedGame);
      const storedPrivateReveals = await this.ctx.storage.get<unknown>(PRIVATE_REVEALS_STORAGE_KEY);
      this.privateReveals = hydratePrivateReveals(storedPrivateReveals, this.game.players.length);
      const storedRobotAlarmInfo = await this.ctx.storage.get<unknown>(
        ROBOT_ALARM_INFO_STORAGE_KEY,
      );
      this.robotRetryAttempt = readRetryCount(storedRobotAlarmInfo);
      const storedLobby = await this.ctx.storage.get<unknown>(LOBBY_STORAGE_KEY);
      this.lobby = storedLobby === undefined ? createLobby() : await this.loadLobby(storedLobby);
      return this.game;
    });
    return this.gameLoad;
  }

  private async loadLobby(storedLobby: unknown): Promise<LobbyState> {
    try {
      return hydrateLobby(storedLobby);
    } catch (error) {
      const lobby = createLobby();
      console.warn(`invalid persisted lobby; resetting to empty lobby: ${errorMessage(error)}`);
      try {
        await this.ctx.storage.put(LOBBY_STORAGE_KEY, serializeLobby(lobby));
      } catch (repairError) {
        console.error(`failed to repair persisted lobby: ${errorMessage(repairError)}`);
      }
      return lobby;
    }
  }

  private enqueueMessage(connection: Connection, data: string | ArrayBuffer | null): void {
    void this.enqueueRoomTask(async () => {
      try {
        if (data === null) throw new Error('unsupported WebSocket message');
        await this.handleMessage(connection, data);
      } catch (error) {
        this.sendError(connection, error);
      }
    });
  }

  private enqueueRoomTask(task: () => Promise<void>): Promise<void> {
    const queued = this.messageQueue.then(task);
    this.messageQueue = queued.catch(error => {
      console.error(`room queue failed: ${errorMessage(error)}`);
    });
    return queued;
  }

  private async handleMessage(connection: Connection, data: string | ArrayBuffer): Promise<void> {
    const { intent } = parseIntentEnvelope(data);
    const game = await this.loadGame();
    if (game.phase === 'lobby' && isLobbyIntent(intent)) {
      await this.handleLobbyIntent(connection, intent);
      return;
    }
    connection.viewerIndex = resolveViewerIndex(game, connection.userId);
    assertIntentAuthority(game, connection.viewerIndex, intent);

    const previous = serializeGame(game);
    const previousPrivateReveals = serializePrivateReveals(this.privateReveals);
    const pendingReveal = game.pendingReveal;
    const events = applyIntent(game, connection.viewerIndex!, intent);
    if (intent.kind === 'wait') return;
    const privateReveal = privateRevealForIntent(pendingReveal, connection.viewerIndex!, intent);
    const nextPrivateReveals = this.nextPrivateReveals(
      connection.userId,
      privateReveal,
      intent.kind === 'suggest',
    );
    try {
      await this.persistGameMutation(game, nextPrivateReveals, !samePrivateReveals(
        this.privateReveals,
        nextPrivateReveals,
      ));
    } catch (error) {
      this.game = hydrateGame(previous);
      this.privateReveals = previousPrivateReveals;
      throw error;
    }
    this.privateReveals = nextPrivateReveals;
    this.broadcast(events, privateReveal);
    await this.maybeRunRobot(true);
  }

  private async handleLobbyIntent(
    connection: Connection,
    intent: Extract<Parameters<typeof applyIntent>[2], { kind: 'join' | 'claimSuspect' | 'start' | 'setOrder' | 'leave' }>,
  ): Promise<void> {
    const lobby = this.lobby;
    const game = this.game;
    if (lobby === undefined || game === undefined) throw new Error('room state is not loaded');

    switch (intent.kind) {
      case 'join': {
        const nextLobby = joinLobby(lobby, connection.userId, intent.name);
        await this.persistLobby(nextLobby);
        this.broadcastLobby();
        return;
      }
      case 'claimSuspect': {
        const nextLobby = claimLobbySuspect(lobby, connection.userId, intent.suspect);
        await this.persistLobby(nextLobby);
        this.broadcastLobby();
        return;
      }
      case 'setOrder': {
        const nextLobby = setLobbyOrder(lobby, connection.userId, intent.order);
        await this.persistLobby(nextLobby);
        this.broadcastLobby();
        return;
      }
      case 'leave': {
        const nextLobby = leaveLobby(lobby, connection.userId);
        await this.persistLobby(nextLobby);
        this.broadcastLobby();
        return;
      }
      case 'start': {
        requireLobbyHost(lobby, connection.userId);
        const nextGame = createGame(createStartPlayers(lobby));
        begin(nextGame);
        const nextLobby = createLobby();
        await this.persistStartedGame(game, lobby, nextGame, nextLobby);
        this.game = nextGame;
        this.lobby = nextLobby;
        this.broadcast([]);
        await this.maybeRunRobot(true);
        return;
      }
    }
  }

  private async persistLobby(nextLobby: LobbyState): Promise<void> {
    const persisted = serializeLobby(nextLobby);
    await this.ctx.storage.put(LOBBY_STORAGE_KEY, persisted);
    this.lobby = nextLobby;
  }

  private async persistStartedGame(
    previousGame: Game,
    previousLobby: LobbyState,
    nextGame: Game,
    nextLobby: LobbyState,
  ): Promise<void> {
    const previousPersistedGame = serializeGame(previousGame);
    const previousPersistedLobby = serializeLobby(previousLobby);
    try {
      await this.ctx.storage.transaction(async transaction => {
        await transaction.put({
          [STORAGE_KEY]: serializeGame(nextGame),
          [LOBBY_STORAGE_KEY]: serializeLobby(nextLobby),
        });
      });
    } catch (error) {
      this.game = hydrateGame(previousPersistedGame);
      this.lobby = hydrateLobby(previousPersistedLobby);
      throw error;
    }
  }

  private async scheduleRobotRetry(): Promise<void> {
    if (this.game === undefined || !hasRobotActionableState(this.game)) {
      await this.resetRobotRetry();
      return;
    }
    if (this.robotAlarmScheduled) return;

    const nextRetryAttempt = Math.min(this.robotRetryAttempt + 1, ROBOT_RETRY_MAX_ATTEMPT);
    await this.persistRetryCount(nextRetryAttempt);
    this.robotRetryAttempt = nextRetryAttempt;

    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm !== null) {
      this.robotAlarmScheduled = true;
      return;
    }

    const delay = Math.min(
      ROBOT_RETRY_INITIAL_DELAY_MS * 2 ** (nextRetryAttempt - 1),
      ROBOT_RETRY_MAX_DELAY_MS,
    );
    await this.ctx.storage.setAlarm(Date.now() + delay);
    this.robotAlarmScheduled = true;
  }

  private async resetRobotRetry(): Promise<void> {
    if (this.robotRetryAttempt === 0) return;
    await this.persistRetryCount(0);
    this.robotRetryAttempt = 0;
  }

  private async applyAlarmRetryCount(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    if (!isAlarmInvocationInfo(alarmInfo)) return;
    const retryCount = Math.min(alarmInfo.retryCount, ROBOT_RETRY_MAX_ATTEMPT);
    if (retryCount <= this.robotRetryAttempt) return;
    await this.persistRetryCount(retryCount);
    this.robotRetryAttempt = retryCount;
  }

  private async persistRetryCount(retryCount: number): Promise<void> {
    const info: RobotAlarmInfo = { retryCount };
    await this.ctx.storage.put(ROBOT_ALARM_INFO_STORAGE_KEY, info);
  }

  private broadcast(
    events: ReturnType<typeof applyIntent>,
    privateReveal?: RobotPrivateReveal,
  ): void {
    const game = this.game;
    if (game === undefined) return;
    for (const connection of [...this.connections.values()]) {
      try {
        connection.viewerIndex = resolveViewerIndex(game, connection.userId);
        if (connection.viewerIndex === null) {
          this.sendJson(connection, { type: 'ready' });
        } else {
          this.sendState(connection, events);
        }
      } catch (error) {
        this.sendError(connection, error);
      }
    }
    if (privateReveal !== undefined) this.deliverPrivateReveal(privateReveal.recipientIndex);
  }

  private broadcastLobby(): void {
    if (this.lobby === undefined) return;
    for (const connection of [...this.connections.values()]) {
      try {
        connection.viewerIndex = null;
        this.sendJson(connection, lobbyView(this.lobby, this.gameId, connection.userId));
      } catch (error) {
        this.sendError(connection, error);
      }
    }
  }

  private sendState(connection: Connection, events: ReturnType<typeof applyIntent>): void {
    if (connection.viewerIndex === null || this.game === undefined) {
      this.sendJson(connection, { type: 'ready' });
      return;
    }
    this.sendJson(connection, {
      type: 'state',
      view: toView(this.game, connection.viewerIndex),
      events,
    });
  }

  private sendPrivateReveal(connection: Connection): void {
    // This durable map stores each recipient's latest private reveal: reconnecting
    // the same authenticated recipient replays it, while other identities cannot read it.
    // A later suggestion clears that recipient's entry; a later reveal replaces it.
    if (connection.viewerIndex === null || this.game === undefined) return;
    const player = this.game.players[connection.viewerIndex];
    if (player?.userId !== connection.userId) return;
    const reveal = this.privateReveals[connection.userId];
    if (reveal === undefined) return;
    this.sendJson(connection, privateRevealFrame(reveal));
  }

  private deliverPrivateReveal(recipientIndex: number): void {
    if (this.game === undefined) return;
    const recipient = this.game.players[recipientIndex];
    if (recipient?.userId === undefined) return;
    for (const connection of [...this.connections.values()]) {
      if (connection.userId !== recipient.userId) continue;
      connection.viewerIndex = recipientIndex;
      this.sendPrivateReveal(connection);
    }
  }

  private nextPrivateReveals(
    suggesterUserId: string,
    privateReveal: RobotPrivateReveal | undefined,
    clearSuggester: boolean,
  ): PersistedPrivateReveals {
    const next = serializePrivateReveals(this.privateReveals);
    if (clearSuggester) delete next[suggesterUserId];
    if (privateReveal !== undefined && this.game !== undefined) {
      const recipient = this.game.players[privateReveal.recipientIndex];
      if (recipient?.userId !== undefined) {
        next[recipient.userId] = {
          fromIndex: privateReveal.fromIndex,
          ...(privateReveal.card === undefined ? {} : {
            card: canonicalCard(privateReveal.card),
          }),
        };
      }
    }
    return next;
  }

  private async persistRobotMutation(
    game: Game,
    privateReveal?: RobotPrivateReveal,
  ): Promise<void> {
    const nextPrivateReveals = this.nextPrivateReveals(
      '',
      privateReveal,
      false,
    );
    await this.persistGameMutation(game, nextPrivateReveals, !samePrivateReveals(
      this.privateReveals,
      nextPrivateReveals,
    ));
    this.privateReveals = nextPrivateReveals;
  }

  private async persistGameMutation(
    game: Game,
    privateReveals: PersistedPrivateReveals,
    privateRevealsChanged: boolean,
  ): Promise<void> {
    const serializedGame = serializeGame(game);
    if (!privateRevealsChanged) {
      await this.ctx.storage.put(STORAGE_KEY, serializedGame);
      return;
    }
    await this.ctx.storage.transaction(async transaction => {
      await transaction.put({
        [STORAGE_KEY]: serializedGame,
        [PRIVATE_REVEALS_STORAGE_KEY]: serializePrivateReveals(privateReveals),
      });
    });
  }

  private sendError(connection: Connection, error: unknown): void {
    this.sendJson(connection, { type: 'error', message: errorMessage(error) });
  }

  private sendJson(connection: Connection, payload: unknown): void {
    if (!this.connections.has(connection.ws)) return;
    if (connection.ws.readyState !== 1) {
      this.removeConnection(connection.ws);
      return;
    }
    try {
      connection.ws.send(JSON.stringify(payload));
    } catch {
      try {
        connection.ws.close(1011, 'socket send failed');
      } catch {
        // The socket may already be broken; removal below is still authoritative.
      }
      this.removeConnection(connection.ws);
    }
  }

  private removeConnection(ws: WebSocket): void {
    this.connections.delete(ws);
  }
}

function isLobbyIntent(
  intent: Intent,
): intent is Extract<Intent, { kind: 'join' | 'claimSuspect' | 'start' | 'setOrder' | 'leave' }> {
  return intent.kind === 'join' || intent.kind === 'claimSuspect' || intent.kind === 'start' ||
    intent.kind === 'setOrder' || intent.kind === 'leave';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'internal error';
}

function isAlarmInvocationInfo(value: unknown): value is AlarmInvocationInfo {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  return typeof info.isRetry === 'boolean' && Number.isInteger(info.retryCount) &&
    (info.retryCount as number) >= 0 && typeof info.scheduledTime === 'number' &&
    Number.isFinite(info.scheduledTime);
}

function readRetryCount(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const retryCount = (value as Record<string, unknown>).retryCount;
  if (!Number.isInteger(retryCount) || (retryCount as number) < 0) return 0;
  return Math.min(retryCount as number, ROBOT_RETRY_MAX_ATTEMPT);
}

function privateRevealForIntent(
  pendingReveal: Game['pendingReveal'],
  fromIndex: number,
  intent: Intent,
): RobotPrivateReveal | undefined {
  if (pendingReveal === null || (intent.kind !== 'showCard' && intent.kind !== 'declineReveal')) {
    return undefined;
  }
  return {
    recipientIndex: pendingReveal.suggesterIndex,
    fromIndex,
    ...(intent.kind === 'showCard' ? { card: canonicalCard(intent.card) } : {}),
  };
}

function canonicalCard(value: unknown): Card {
  assertCard(value);
  if (value.type === 'suspect') return { type: 'suspect', suspect: value.suspect };
  if (value.type === 'weapon') return { type: 'weapon', weapon: value.weapon };
  return { type: 'room', room: value.room };
}

function privateRevealFrame(reveal: { fromIndex: number; card?: Card }): PrivateRevealFrame {
  return reveal.card === undefined
    ? { type: 'private', reveal: { fromIndex: reveal.fromIndex } }
    : {
      type: 'private',
      reveal: { fromIndex: reveal.fromIndex, card: canonicalCard(reveal.card) },
    };
}

function samePrivateReveals(
  left: PersistedPrivateReveals,
  right: PersistedPrivateReveals,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
