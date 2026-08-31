import { DurableObject } from 'cloudflare:workers';
import {
  applyIntent,
  cardMatchesSuggestion,
  begin,
  createGame,
  decideRobotIntent,
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
  isClientIntentKind,
  negotiateJwtProtocol,
  parseIntentEnvelope,
  resolveViewerIndex,
} from './game-room-protocol';
import { currentRobotIndex, hasRobotActionableState, runRobotScheduler } from './robots/scheduler';
import type { RobotPrivateReveal } from './robots/scheduler';
import type { ClientIntentKind, PrivateRevealFrame } from './game-room-protocol';
import { isValidGameId } from './game-id';
import { isValidUserId } from './auth/jwt';
export {
  assertIntentAuthority,
  authenticateJwtProtocol,
  isClientIntentKind,
  negotiateJwtProtocol,
  parseIntentEnvelope,
  resolveViewerIndex,
} from './game-room-protocol';

const STORAGE_KEY = 'game';
const PRIVATE_REVEALS_STORAGE_KEY = 'lastShownCard';
const ROBOT_ALARM_INFO_STORAGE_KEY = 'robot-alarm-info';
const DEADLINE_STORAGE_KEY = 'action-deadline';
const DEFAULT_TURN_TIMEOUT_MS = 60_000;
const ROBOT_RETRY_INITIAL_DELAY_MS = 1_000;
const ROBOT_RETRY_MAX_DELAY_MS = 60_000;
const ROBOT_RETRY_MAX_ATTEMPT = 6;
/** Extra breathing room when the next robot action starts a new phase. */
const ROBOT_PHASE_BONUS_MS = 1_400;
/** Reveal decisions around the table run at triple pace deliberately. */
const ROBOT_REVEAL_PACE_MULTIPLIER = 3;

interface RobotAlarmInfo {
  retryCount: number;
}

interface ActionDeadline {
  at: number;
  playerIndex: number;
  kind: 'turn' | 'reveal';
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
  private deadline: ActionDeadline | null = null;
  /** 0 disables pacing (tests); >0 spaces robot actions via alarms. */
  private readonly robotPaceMs = readPaceMs(this.env.ROBOT_STEP_PACE_MS);
  private lastRobotPhaseKey: string | null = null;
  private lastRobotIntentKind: Intent['kind'] | null = null;
  private readonly connections = new Map<WebSocket, Connection>();
  private gameId = '';

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const internalGameId = url.searchParams.get('gameId');
    if (internalGameId !== null && isValidGameId(internalGameId)) this.gameId = internalGameId;
    if (url.pathname === '/internal/lobby/refresh') {
      if (!isValidGameId(internalGameId)) return new Response('invalid gameId', { status: 400 });
      this.gameId = internalGameId;
      await this.loadGame();
      if (this.lobby === undefined) return new Response('room not loaded', { status: 500 });
      const lobby = await this.loadLobbyFromD1();
      if (lobby !== null && this.game?.phase === 'lobby') {
        this.lobby = lobby;
        await this.ctx.storage.put(LOBBY_STORAGE_KEY, serializeLobby(lobby));
        this.broadcastLobby();
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/internal/lobby/start') {
      const userId = req.headers.get('X-User-ID');
      if (!isValidGameId(internalGameId)) return new Response('invalid gameId', { status: 400 });
      if (!isValidUserId(userId)) return new Response('unauthorized', { status: 401 });
      this.gameId = internalGameId;
      await this.loadGame();
      if (this.game?.phase !== 'lobby' || this.lobby === undefined) return new Response('not in lobby', { status: 409 });
      requireLobbyHost(this.lobby, userId);
      const nextGame = createGame(createStartPlayers(this.lobby));
      begin(nextGame);
      const nextLobby = createLobby(this.lobby.botCount);
      await this.persistStartedGame(this.game, this.lobby, nextGame, nextLobby);
      this.game = nextGame;
      this.lobby = nextLobby;
      this.broadcast([]);
      await this.maybeRunRobot(true);
      return Response.json({ ok: true });
    }
    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
    const requestedGameId = url.searchParams.get('gameId');
    if (!isValidGameId(requestedGameId)) return new Response('invalid gameId', { status: 400 });
    this.gameId = requestedGameId;
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
        if ((typeof data === 'string' && new TextEncoder().encode(data).byteLength > 16_384) ||
            (data instanceof ArrayBuffer && data.byteLength > 16_384)) {
          this.enqueueMessage(connection, null);
          return;
        }
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
      if (this.deadline === null) {
        await this.persistDeadline(deadlineForGame(game));
      }
      await this.maybeArmPacingAlarm();

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
        if (this.game === undefined) return;
        if (this.deadline === null) {
          const nextDeadline = deadlineForGame(this.game);
          if (nextDeadline !== null) await this.persistDeadline(nextDeadline);
        }
        if (this.deadline !== null && this.deadline.at <= Date.now()) {
          await this.resolveExpiredDeadline();
          return;
        }
        if (!hasRobotActionableState(this.game)) {
          await this.resetRobotRetry();
          await this.armNextAlarm();
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
        onAction: intent => {
          this.lastRobotPhaseKey = phaseKeyFor(intent.kind);
          this.lastRobotIntentKind = intent.kind;
        },
        maxSteps: this.robotPaceMs > 0 ? 1 : undefined,
      });
      await this.resetRobotRetry();
      await this.maybeArmPacingAlarm();
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
      this.deadline = hydrateDeadline(await this.ctx.storage.get<unknown>(DEADLINE_STORAGE_KEY), this.game.players.length);
        const storedLobby = await this.ctx.storage.get<unknown>(LOBBY_STORAGE_KEY);
      this.lobby = storedLobby === undefined
        ? await this.loadLobbyFromD1() ?? createLobby()
        : await this.loadLobby(storedLobby);
      return this.game;
    });
    this.gameLoad = this.gameLoad.catch(error => {
      // A transient storage or D1 failure must not poison this DO instance.
      // The next request should retry hydration from durable state.
      this.gameLoad = undefined;
      throw error;
    });
    return this.gameLoad;
  }

  private async loadLobbyFromD1(): Promise<LobbyState | null> {
    const db = this.env.LOBBY_DB;
    if (typeof db?.prepare !== 'function' || this.gameId === '') return null;
    const gameResult = await db.prepare(
      'SELECT host_user_id, bot_count, state FROM games WHERE id = ? LIMIT 1',
    ).bind(this.gameId).all<unknown>();
    const gameRow = gameResult.results[0] as Record<string, unknown> | undefined;
    if (gameRow === undefined || gameRow.state !== 'lobby' || typeof gameRow.host_user_id !== 'string') return null;
    const playersResult = await db.prepare(
      'SELECT user_id, suspect FROM game_players WHERE game_id = ? AND is_bot = 0 ORDER BY player_index',
    ).bind(this.gameId).all<unknown>();
    const players = playersResult.results.map(value => {
      const row = value as Record<string, unknown>;
      return {
        userId: String(row.user_id ?? ''),
        name: String(row.user_id ?? ''),
        suspect: row.suspect === null || row.suspect === undefined ? null : row.suspect as LobbyState['players'][number]['suspect'],
      };
    });
    return {
      hostUserId: gameRow.host_user_id,
      players,
      botCount: typeof gameRow.bot_count === 'number' ? gameRow.bot_count : undefined,
    };
  }

  private async syncLobbyToD1(
    lobby: LobbyState,
    state: 'lobby' | 'playing' = 'lobby',
    hostUserId?: string | null,
    playerCount = lobby.players.length,
    botCount = lobby.botCount ?? 0,
  ): Promise<void> {
    const db = this.env.LOBBY_DB;
    if (typeof db?.batch !== 'function' || typeof db?.prepare !== 'function' || this.gameId === '') return;
    const host = hostUserId ?? lobby.hostUserId ?? lobby.players[0]?.userId;
    if (host === undefined || host === null) return;
    const statements = [
      db.prepare('INSERT OR IGNORE INTO games (id, created_at, state, player_count, bot_count, host_user_id, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(this.gameId, Date.now(), state, playerCount, botCount, host, '{}'),
      db.prepare('UPDATE games SET state = ?, host_user_id = ?, player_count = ?, bot_count = ? WHERE id = ?')
        .bind(state, host, playerCount, botCount, this.gameId),
      db.prepare('DELETE FROM game_players WHERE game_id = ?').bind(this.gameId),
      ...lobby.players.map((player, index) => db.prepare(
        'INSERT INTO game_players (game_id, player_index, user_id, suspect, is_bot) VALUES (?, ?, ?, ?, 0)',
      ).bind(this.gameId, index, player.userId, player.suspect)),
    ];
    await db.batch(statements);
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
      let intentKind: ClientIntentKind | undefined;
      try {
        if (data === null) throw new Error('unsupported WebSocket message');
        const { intent } = parseIntentEnvelope(data);
        intentKind = isClientIntentKind(intent.kind) ? intent.kind : undefined;
        await this.handleMessage(connection, intent);
      } catch (error) {
        this.sendError(connection, error, intentKind);
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

  private async handleMessage(connection: Connection, intent: Intent): Promise<void> {
    const game = await this.loadGame();
    if (game.phase === 'lobby' && isLobbyIntent(intent)) {
      await this.handleLobbyIntent(connection, intent);
      return;
    }
    connection.viewerIndex = resolveViewerIndex(game, connection.userId);
    assertIntentAuthority(game, connection.viewerIndex, intent);

    const previous = serializeGame(game);
    const previousPrivateReveals = serializePrivateReveals(this.privateReveals);
    const previousDeadline = this.deadline;
    const pendingReveal = game.pendingReveal;
    const events = applyIntent(game, connection.viewerIndex!, intent);
    if (intent.kind === 'wait') return;
    this.deadline = deadlineForGame(game);
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
      this.deadline = previousDeadline;
      throw error;
    }
    this.privateReveals = nextPrivateReveals;
    // A mutation can replace a human deadline with a robot turn (or vice versa).
    // Allow the next scheduler pass to overwrite any alarm for the prior state.
    this.robotAlarmScheduled = false;
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
        const nextLobby = createLobby(lobby.botCount);
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
    const previousLobby = serializeLobby(this.lobby ?? createLobby());
    try {
      await this.ctx.storage.put(LOBBY_STORAGE_KEY, serializeLobby(nextLobby));
      await this.syncLobbyToD1(nextLobby, 'lobby', nextLobby.hostUserId);
      this.lobby = nextLobby;
    } catch (error) {
      await this.ctx.storage.put(LOBBY_STORAGE_KEY, previousLobby);
      throw error;
    }
  }

  private async persistStartedGame(
    previousGame: Game,
    previousLobby: LobbyState,
    nextGame: Game,
    nextLobby: LobbyState,
  ): Promise<void> {
    const previousPersistedGame = serializeGame(previousGame);
    const previousPersistedLobby = serializeLobby(previousLobby);
    const previousDeadline = this.deadline;
    const nextDeadline = deadlineForGame(nextGame);
    let durableCommitted = false;
    try {
      await this.ctx.storage.transaction(async transaction => {
        await transaction.put({
          [STORAGE_KEY]: serializeGame(nextGame),
          [LOBBY_STORAGE_KEY]: serializeLobby(nextLobby),
          [DEADLINE_STORAGE_KEY]: nextDeadline,
        });
      });
      durableCommitted = true;
      const humanCount = nextGame.players.filter(player => !player.isRobot).length;
      const robotCount = nextGame.players.filter(player => player.isRobot).length;
      await this.syncLobbyToD1(
        previousLobby,
        'playing',
        previousLobby.hostUserId,
        humanCount,
        robotCount,
      );
      this.deadline = nextDeadline;
    } catch (error) {
      if (durableCommitted) {
        try {
          await this.ctx.storage.transaction(async transaction => {
            await transaction.put({
              [STORAGE_KEY]: previousPersistedGame,
              [LOBBY_STORAGE_KEY]: previousPersistedLobby,
              [DEADLINE_STORAGE_KEY]: previousDeadline,
            });
          });
        } catch (rollbackError) {
          console.error(`start rollback failed: ${errorMessage(rollbackError)}`);
        }
      }
      this.deadline = previousDeadline;
      this.game = hydrateGame(previousPersistedGame);
      this.lobby = hydrateLobby(previousPersistedLobby);
      throw error;
    }
  }

  private async resolveExpiredDeadline(): Promise<void> {
    const game = this.game;
    const deadline = this.deadline;
    if (game === undefined || deadline === null) return;
    if (deadline.kind === 'turn' && game.turnIndex !== deadline.playerIndex) {
      await this.persistDeadline(deadlineForGame(game));
      await this.armNextAlarm();
      return;
    }
    if (deadline.kind === 'reveal' && game.pendingReveal?.revealerIndex !== deadline.playerIndex) {
      await this.persistDeadline(deadlineForGame(game));
      await this.armNextAlarm();
      return;
    }
    const pending = game.pendingReveal;
    let intent: Intent;
    if (deadline.kind === 'reveal' && pending !== null) {
      const revealer = game.players[deadline.playerIndex];
      const matching = revealer?.cards.find(card => cardMatchesSuggestion(card, pending));
      intent = matching === undefined ? { kind: 'declineReveal' } : { kind: 'showCard', card: matching };
    } else {
      intent = { kind: 'endTurn' };
    }
    const previous = serializeGame(game);
    const previousPrivate = serializePrivateReveals(this.privateReveals);
    const previousDeadline = this.deadline;
    const events = applyIntent(game, deadline.playerIndex, intent);
    events.push({ type: 'timedOut', playerIndex: deadline.playerIndex, action: deadline.kind });
    const privateReveal = privateRevealForIntent(pending, deadline.playerIndex, intent);
    const nextPrivate = this.nextPrivateReveals(
      game.players[pending?.suggesterIndex ?? deadline.playerIndex]?.userId ?? '',
      privateReveal,
      false,
    );
    this.deadline = deadlineForGame(game);
    try {
      await this.persistGameMutation(game, nextPrivate, !samePrivateReveals(this.privateReveals, nextPrivate));
    } catch (error) {
      this.game = hydrateGame(previous);
      this.privateReveals = previousPrivate;
      this.deadline = previousDeadline;
      throw error;
    }
    this.privateReveals = nextPrivate;
    this.broadcast(events, privateReveal);
    await this.maybeRunRobot(true);
  }

  private async armNextAlarm(): Promise<void> {
    if (this.robotAlarmScheduled) return;
    const candidates: number[] = [];
    if (this.deadline !== null) candidates.push(this.deadline.at);
    if (this.game !== undefined && hasRobotActionableState(this.game) && this.robotPaceMs > 0) {
      candidates.push(Date.now() + this.robotPaceMs);
    }
    const next = candidates.length === 0 ? null : Math.min(...candidates);
    if (next === null) return;
    await this.ctx.storage.setAlarm(next);
    this.robotAlarmScheduled = true;
  }

  private async maybeArmPacingAlarm(): Promise<void> {
    if (this.robotPaceMs <= 0 && this.deadline === null) return;
    const game = this.game;
    if (game === undefined || (!hasRobotActionableState(game) && this.deadline === null)) return;
    if (this.robotAlarmScheduled) return;
    if (!hasRobotActionableState(game) && this.deadline !== null) {
      await this.armNextAlarm();
      return;
    }

    // Phase boundaries (roll→move→suggest→reveal→next robot) get a longer
    // beat so spectators can keep up with what just happened. The suspense
    // before an unknown reveal decision gets triple pace — but once a player
    // has shown they have nothing, passing to the next query is brisk.
    const nextKey = this.peekNextRobotPhaseKey();
    const declinedLast = this.lastRobotIntentKind === 'declineReveal';
    const multiplier = !declinedLast && nextKey === 'reveal'
      ? ROBOT_REVEAL_PACE_MULTIPLIER
      : 1;
    const boundary = nextKey === null || nextKey !== this.lastRobotPhaseKey;
    const delay = this.robotPaceMs * multiplier +
      (boundary ? ROBOT_PHASE_BONUS_MS * multiplier : 0);
    try {
      await this.ctx.storage.setAlarm(Date.now() + delay);
      this.robotAlarmScheduled = true;
    } catch (error) {
      console.error(`robot pacing alarm failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  /** Kind-only peek at the upcoming action; never mutates game state. */
  private peekNextRobotPhaseKey(): string | null {
    const game = this.game;
    if (game === undefined || game.phase !== 'playing') return null;
    const robotIndex = currentRobotIndex(game);
    if (robotIndex === null) return null;
    try {
      const intent = decideRobotIntent(game, robotIndex, () => 0.5);
      if (intent.kind === 'wait') return null;
      return phaseKeyFor(intent.kind);
    } catch {
      return null;
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
    const previousDeadline = this.deadline;
    this.deadline = deadlineForGame(game);
    try {
      await this.persistGameMutation(game, nextPrivateReveals, !samePrivateReveals(
        this.privateReveals,
        nextPrivateReveals,
      ));
      this.privateReveals = nextPrivateReveals;
    } catch (error) {
      this.deadline = previousDeadline;
      throw error;
    }
  }

  private async persistDeadline(nextDeadline: ActionDeadline | null): Promise<void> {
    const previousDeadline = this.deadline;
    this.deadline = nextDeadline;
    try {
      await this.ctx.storage.put(DEADLINE_STORAGE_KEY, nextDeadline);
    } catch (error) {
      this.deadline = previousDeadline;
      throw error;
    }
  }

  private async persistGameMutation(
    game: Game,
    privateReveals: PersistedPrivateReveals,
    privateRevealsChanged: boolean,
  ): Promise<void> {
    const serializedGame = serializeGame(game);
    const entries: Record<string, unknown> = {
      [STORAGE_KEY]: serializedGame,
      [DEADLINE_STORAGE_KEY]: this.deadline,
    };
    if (privateRevealsChanged) entries[PRIVATE_REVEALS_STORAGE_KEY] = serializePrivateReveals(privateReveals);
    await this.ctx.storage.transaction(async transaction => transaction.put(entries));
  }

  private sendError(
    connection: Connection,
    error: unknown,
    intentKind?: ClientIntentKind,
  ): void {
    this.sendJson(connection, {
      type: 'error',
      message: errorMessage(error),
      ...(intentKind === undefined ? {} : { intentKind }),
    });
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

/** Coarse phase buckets so pacing can sense transitions between them. */
function phaseKeyFor(kind: Intent['kind']): string {
  switch (kind) {
    case 'roll':
      return 'roll';
    case 'moveTo':
    case 'useSecretPassage':
      return 'move';
    case 'suggest':
      return 'suggest';
    case 'showCard':
    case 'declineReveal':
      return 'reveal';
    case 'endTurn':
      return 'handoff';
    default:
      return kind;
  }
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

function deadlineForGame(game: Game): ActionDeadline | null {
  if (game.phase !== 'playing') return null;
  if (game.pendingReveal !== null) {
    const revealer = game.players[game.pendingReveal.revealerIndex];
    return revealer?.isRobot === false
      ? { at: Date.now() + DEFAULT_TURN_TIMEOUT_MS, playerIndex: game.pendingReveal.revealerIndex, kind: 'reveal' }
      : null;
  }
  const player = game.players[game.turnIndex];
  return player?.isRobot === false
    ? { at: Date.now() + DEFAULT_TURN_TIMEOUT_MS, playerIndex: game.turnIndex, kind: 'turn' }
    : null;
}

function hydrateDeadline(value: unknown, playerCount: number): ActionDeadline | null {
  if (value === null || value === undefined) return null;
  // A malformed or legacy alarm record must not make the room unavailable.
  // The current game state remains authoritative and will install a fresh
  // deadline when the room next serves a request or alarm.
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'number' || !Number.isFinite(record.at) || record.at < 0 ||
      !Number.isInteger(record.playerIndex) || (record.playerIndex as number) < 0 ||
      (record.playerIndex as number) >= playerCount || (record.kind !== 'turn' && record.kind !== 'reveal')) {
    return null;
  }
  return { at: record.at, playerIndex: record.playerIndex as number, kind: record.kind };
}

function readPaceMs(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) return 0;
  return parsed;
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
