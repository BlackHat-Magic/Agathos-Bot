import { DurableObject } from 'cloudflare:workers';
import {
  applyIntent,
  toView,
} from '@agathos/game';
import type { Game } from '@agathos/game';
import type { Env } from './index';
import {
  createInitialGame,
  hydrateGame,
  serializeGame,
} from './game-storage';
import {
  assertIntentAuthority,
  authenticateDevProtocol,
  parseIntentEnvelope,
  resolveViewerIndex,
} from './game-room-protocol';
export {
  assertIntentAuthority,
  authenticateDevProtocol,
  parseIntentEnvelope,
  resolveViewerIndex,
} from './game-room-protocol';

const STORAGE_KEY = 'game';

interface Connection {
  ws: WebSocket;
  userId: string;
  viewerIndex: number | null;
}

export class GameRoom extends DurableObject<Env> {
  private game: Game | undefined;
  private gameLoad: Promise<Game> | undefined;
  private messageQueue: Promise<void> = Promise.resolve();
  private readonly connections = new Map<WebSocket, Connection>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
    if (url.searchParams.get('gameId') === null || url.searchParams.get('gameId') === '') {
      return new Response('gameId is required', { status: 400 });
    }
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const userId = authenticateDevProtocol(req.headers.get('Sec-WebSocket-Protocol'));
    if (userId === null) return new Response('Unauthorized', { status: 401 });

    try {
      const game = await this.loadGame();
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const connection: Connection = {
        ws: server,
        userId,
        viewerIndex: resolveViewerIndex(game, userId),
      };

      this.connections.set(server, connection);
      server.accept();
      server.addEventListener('message', event => {
        const data = event.data;
        if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
          this.enqueueMessage(connection, null);
          return;
        }
        this.enqueueMessage(connection, data);
      });
      server.addEventListener('close', () => this.removeConnection(server));
      server.addEventListener('error', () => this.removeConnection(server));

      if (connection.viewerIndex === null) {
        this.sendJson(connection, { type: 'ready' });
      } else {
        this.sendState(connection, []);
      }

      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      return new Response(errorMessage(error), { status: 500 });
    }
  }

  /** Task 15 will implement the robot scheduler behind this hook. */
  async maybeRunRobot(): Promise<void> {
    return;
  }

  private async loadGame(): Promise<Game> {
    if (this.game !== undefined) return this.game;
    this.gameLoad ??= this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<unknown>(STORAGE_KEY);
      this.game = stored === undefined ? createInitialGame() : hydrateGame(stored);
      return this.game;
    });
    return this.gameLoad;
  }

  private enqueueMessage(connection: Connection, data: string | ArrayBuffer | null): void {
    this.messageQueue = this.messageQueue.then(async () => {
      try {
        if (data === null) throw new Error('unsupported WebSocket message');
        await this.handleMessage(connection, data);
      } catch (error) {
        this.sendError(connection, error);
      }
    });
  }

  private async handleMessage(connection: Connection, data: string | ArrayBuffer): Promise<void> {
    const { intent } = parseIntentEnvelope(data);
    const game = await this.loadGame();
    connection.viewerIndex = resolveViewerIndex(game, connection.userId);
    assertIntentAuthority(game, connection.viewerIndex, intent);

    const previous = serializeGame(game);
    const events = applyIntent(game, connection.viewerIndex!, intent);
    if (intent.kind === 'wait') return;
    try {
      await this.ctx.storage.put(STORAGE_KEY, serializeGame(game));
    } catch (error) {
      this.game = hydrateGame(previous);
      throw error;
    }
    this.broadcast(events);
  }

  private broadcast(events: ReturnType<typeof applyIntent>): void {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'internal error';
}
