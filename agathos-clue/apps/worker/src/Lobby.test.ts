import { describe, expect, it } from 'vitest';
import type { Env } from './index';
import { handleLobby } from './Lobby';

interface GameRow {
  id: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  host_user_id: string;
  state: string;
  player_count: number;
  bot_count: number;
  winner_user_id: string | null;
  config_json: string;
}

class FakeD1 {
  readonly games = new Map<string, GameRow>();
  readonly players = new Map<string, { userId: string; suspect: string }>();

  prepare(query: string) {
    return new FakeStatement(this, query);
  }
}

class FakeGameRoomNamespace {
  fetchCalls = 0;
}

class FakeStatement {
  private args: unknown[] = [];

  constructor(private readonly db: FakeD1, private readonly query: string) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async run(): Promise<{ success: true }> {
    if (this.query.startsWith('INSERT INTO games')) {
      const [id, createdAt, state, playerCount, botCount, hostUserId, configJson] = this.args;
      this.db.games.set(String(id), {
        id: String(id),
        created_at: Number(createdAt),
        started_at: null,
        finished_at: null,
        host_user_id: String(hostUserId),
        state: String(state),
        player_count: Number(playerCount),
        bot_count: Number(botCount),
        winner_user_id: null,
        config_json: String(configJson),
      });
    } else if (this.query.startsWith('INSERT OR REPLACE INTO game_players')) {
      const [gameId, userId, suspect] = this.args;
      this.db.players.set(`${String(gameId)}:${String(userId)}`, {
        userId: String(userId),
        suspect: String(suspect),
      });
    }
    return { success: true };
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.query.includes('WHERE state = ?')) {
      const state = String(this.args[0]);
      return {
        results: [...this.db.games.values()].filter(game => game.state === state).map(game => ({
          id: game.id,
          created_at: game.created_at,
          host_user_id: game.host_user_id,
          state: game.state,
          player_count: game.player_count,
          bot_count: game.bot_count,
        })) as T[],
      };
    }
    const game = this.db.games.get(String(this.args[0]));
    return { results: game === undefined ? [] : [game as T] };
  }
}

function environment(db: FakeD1, gameRoom = new FakeGameRoomNamespace()): Env {
  return { LOBBY_DB: db, GAME_ROOM: gameRoom } as unknown as Env;
}

function request(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  userId?: string,
): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(userId === undefined ? {} : { Authorization: `Bearer dev-token-${userId}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('D1 lobby HTTP registry', () => {
  it('creates with the Authorization identity and returns only the id', async () => {
    const db = new FakeD1();
    const response = await handleLobby(
      request('/api/games', 'POST', {
        hostUserId: 'attacker',
        botCount: 2,
        config: { timerSeconds: 60 },
      }, 'alice'),
      environment(db),
    );
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual(['id']);
    const game = [...db.games.values()][0]!;
    expect(game.host_user_id).toBe('alice');
    expect(game.bot_count).toBe(2);
    expect(game.state).toBe('lobby');
  });

  it('requires authentication for mutations and ignores body userId on join', async () => {
    const db = new FakeD1();
    const unauthorized = await handleLobby(request('/api/games', 'POST', {}), environment(db));
    expect(unauthorized.status).toBe(401);

    const gameId = 'clue-game:test-game';
    db.games.set(gameId, {
      id: gameId,
      created_at: 1,
      started_at: null,
      finished_at: null,
      host_user_id: 'alice',
      state: 'lobby',
      player_count: 1,
      bot_count: 0,
      winner_user_id: null,
      config_json: '{}',
    });
    const joined = await handleLobby(
      request(`/api/games/${gameId}/join`, 'POST', { userId: 'attacker', suspect: 'Miss Scarlett' }, 'bob'),
      environment(db),
    );
    expect(joined.status).toBe(200);
    expect(await responseBody(joined)).toEqual({ ok: true });
    expect(db.players.get(`${gameId}:bob`)).toEqual({ userId: 'bob', suspect: 'Miss Scarlett' });
    expect(db.players.has(`${gameId}:attacker`)).toBe(false);
  });

  it('lists lobby public fields without config or private game data', async () => {
    const db = new FakeD1();
    db.games.set('clue-game:public', {
      id: 'clue-game:public',
      created_at: 10,
      started_at: null,
      finished_at: null,
      host_user_id: 'alice',
      state: 'lobby',
      player_count: 1,
      bot_count: 3,
      winner_user_id: null,
      config_json: JSON.stringify({ solution: 'secret', cards: ['private'] }),
    });
    db.games.set('clue-game:playing', { ...db.games.get('clue-game:public')!, id: 'clue-game:playing', state: 'playing' });
    const response = await handleLobby(request('/api/games', 'GET'), environment(db));
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect(body).toEqual({ games: [{
      id: 'clue-game:public',
      created_at: 10,
      host_user_id: 'alice',
      state: 'lobby',
      player_count: 1,
      bot_count: 3,
    }] });
  });

  it('validates game state and leaves D1 unchanged at the DO start boundary', async () => {
    const db = new FakeD1();
    const gameId = 'clue-game:start-boundary';
    const row: GameRow = {
      id: gameId,
      created_at: 1,
      started_at: null,
      finished_at: null,
      host_user_id: 'alice',
      state: 'lobby',
      player_count: 1,
      bot_count: 0,
      winner_user_id: null,
      config_json: '{}',
    };
    db.games.set(gameId, row);
    const before = JSON.stringify(row);
    const gameRoom = new FakeGameRoomNamespace();
    const response = await handleLobby(
      request(`/api/games/${gameId}/start`, 'POST', undefined, 'alice'),
      environment(db, gameRoom),
    );
    expect(response.status).toBe(409);
    expect((await responseBody(response)).error).toContain('D1 state is unchanged');
    expect(JSON.stringify(db.games.get(gameId))).toBe(before);
    expect(gameRoom.fetchCalls).toBe(0);

    const notHost = await handleLobby(request(`/api/games/${gameId}/start`, 'POST', undefined, 'bob'), environment(db));
    expect(notHost.status).toBe(403);
  });

  it('rejects malformed and out-of-bounds input', async () => {
    const db = new FakeD1();
    expect((await handleLobby(
      request('/api/games', 'POST', { botCount: 6 }, 'alice'),
      environment(db),
    )).status).toBe(400);
    expect((await handleLobby(
      request('/api/games', 'POST', { config: [] }, 'alice'),
      environment(db),
    )).status).toBe(400);
    expect((await handleLobby(
      request('/api/games/clue-game:not%20valid/join', 'POST', {}, 'alice'),
      environment(db),
    )).status).toBe(400);
  });
});
