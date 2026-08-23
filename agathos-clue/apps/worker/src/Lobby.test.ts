import { describe, expect, it } from 'vitest';
import type { Env } from './index';
import { handleLobby } from './Lobby';
import { mintJwt } from './auth/jwt';

const JWT_SECRET = 'test-secret';

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

interface PlayerRow {
  game_id: string;
  player_index: number;
  user_id: string;
  suspect: string | null;
  is_bot: number;
}

class FakeD1 {
  readonly games = new Map<string, GameRow>();
  readonly players = new Map<string, PlayerRow>();
  failNext = false;

  prepare(query: string) {
    return new FakeStatement(this, query);
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('D1 unavailable: private SQL details');
    }
    for (const statement of statements) await statement.run();
    return [];
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
    } else if (this.query.startsWith('INSERT INTO game_players')) {
      const [gameId, playerIndex, userId, suspect] = this.args;
      const key = `${String(gameId)}:${String(userId)}`;
      const existing = this.db.players.get(key);
      this.db.players.set(key, {
        game_id: String(gameId),
        player_index: existing?.player_index ?? Number(playerIndex),
        user_id: String(userId),
        suspect: suspect === null ? null : String(suspect),
        is_bot: 0,
      });
    } else if (this.query.startsWith('UPDATE games SET player_count')) {
      const gameId = String(this.args[1]);
      const game = this.db.games.get(gameId);
      if (game !== undefined) {
        game.player_count = [...this.db.players.values()]
          .filter(player => player.game_id === gameId && player.is_bot === 0).length;
      }
    }
    return { success: true };
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.db.failNext) {
      this.db.failNext = false;
      throw new Error('D1 unavailable: private SQL details');
    }
    if (this.query.includes('FROM game_players')) {
      const gameId = String(this.args[0]);
      return {
        results: [...this.db.players.values()]
          .filter(player => player.game_id === gameId)
          .sort((a, b) => a.player_index - b.player_index) as T[],
      };
    }
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
  return { LOBBY_DB: db, GAME_ROOM: gameRoom, JWT_SECRET } as unknown as Env;
}

async function request(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  userId?: string,
): Promise<Request> {
  const token = userId === undefined ? undefined : await mintJwt({ userId }, JWT_SECRET, 60);
  return new Request(`https://example.test${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function malformedRequest(path: string, rawBody: string, userId: string): Promise<Request> {
  const token = await mintJwt({ userId }, JWT_SECRET, 60);
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: rawBody,
  });
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function game(id: string, botCount = 0): GameRow {
  return {
    id,
    created_at: 1,
    started_at: null,
    finished_at: null,
    host_user_id: 'alice',
    state: 'lobby',
    player_count: 1,
    bot_count: botCount,
    winner_user_id: null,
    config_json: '{}',
  };
}

describe('D1 lobby HTTP registry', () => {
  it('uses the bounded Authorization identity and creates the indexed host', async () => {
    const db = new FakeD1();
    const response = await handleLobby(
      await request('/api/games', 'POST', {
        hostUserId: 'attacker',
        botCount: 2,
        config: { timerSeconds: 60 },
      }, 'alice'),
      environment(db),
    );
    const body = await responseBody(response);
    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual(['id']);
    const created = [...db.games.values()][0]!;
    expect(created.host_user_id).toBe('alice');
    expect(created.player_count).toBe(1);
    expect(created.bot_count).toBe(2);
    expect([...db.players.values()]).toEqual([{
      game_id: created.id,
      player_index: 0,
      user_id: 'alice',
      suspect: null,
      is_bot: 0,
    }]);

    const acceptedBoundary = await handleLobby(
      await request('/api/games', 'POST', {}, 'x'.repeat(128)),
      environment(new FakeD1()),
    );
    expect(acceptedBoundary.status).toBe(200);
    const rejectedBoundary = await handleLobby(
      new Request('https://example.test/api/games', {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid' },
        body: '{}',
      }),
      environment(new FakeD1()),
    );
    expect(rejectedBoundary.status).toBe(401);
  });

  it('requires valid Authorization and ignores body identity on join', async () => {
    const db = new FakeD1();
    expect((await handleLobby(await request('/api/games', 'POST', {}), environment(db))).status).toBe(401);
    expect((await handleLobby(
      new Request('https://example.test/api/games', { method: 'POST', headers: { Authorization: 'Bearer dev-token-attacker' }, body: '{}' }),
      environment(db),
    )).status).toBe(401);

    const gameId = 'clue-game:test-game';
    db.games.set(gameId, game(gameId));
    db.players.set(`${gameId}:alice`, {
      game_id: gameId,
      player_index: 0,
      user_id: 'alice',
      suspect: null,
      is_bot: 0,
    });
    const joined = await handleLobby(
      await request(`/api/games/${gameId}/join`, 'POST', { userId: 'attacker' }, 'bob'),
      environment(db),
    );
    expect(joined.status).toBe(200);
    expect(db.players.get(`${gameId}:bob`)).toMatchObject({
      user_id: 'bob',
      player_index: 1,
      suspect: null,
    });
    expect(db.players.has(`${gameId}:attacker`)).toBe(false);
    expect(db.games.get(gameId)?.player_count).toBe(2);
  });

  it('accepts only omitted/null unclaimed suspects and rejects invalid or duplicate claims', async () => {
    const db = new FakeD1();
    const gameId = 'clue-game:suspects';
    db.games.set(gameId, game(gameId));
    db.players.set(`${gameId}:alice`, {
      game_id: gameId,
      player_index: 0,
      user_id: 'alice',
      suspect: null,
      is_bot: 0,
    });

    const omitted = await handleLobby(await request(`/api/games/${gameId}/join`, 'POST', {}, 'bob'), environment(db));
    expect(omitted.status).toBe(200);
    expect(db.players.get(`${gameId}:bob`)?.suspect).toBeNull();
    const explicitNull = await handleLobby(
      await request(`/api/games/${gameId}/join`, 'POST', { suspect: null }, 'bob'),
      environment(db),
    );
    expect(explicitNull.status).toBe(200);
    expect(db.games.get(gameId)?.player_count).toBe(2);

    const invalid = await handleLobby(
      await request(`/api/games/${gameId}/join`, 'POST', { suspect: '' }, 'carol'),
      environment(db),
    );
    expect(invalid.status).toBe(400);
    const claimed = await handleLobby(
      await request(`/api/games/${gameId}/join`, 'POST', { suspect: 'Miss Scarlett' }, 'carol'),
      environment(db),
    );
    expect(claimed.status).toBe(200);
    const duplicate = await handleLobby(
      await request(`/api/games/${gameId}/join`, 'POST', { suspect: 'Miss Scarlett' }, 'dave'),
      environment(db),
    );
    expect(duplicate.status).toBe(409);
  });

  it('fills six indexed players, keeps duplicate joins at one count, and rejects a seventh', async () => {
    const db = new FakeD1();
    const create = await handleLobby(await request('/api/games', 'POST', {}, 'alice'), environment(db));
    const gameId = String((await responseBody(create)).id);
    for (const userId of ['bob', 'carol', 'dave', 'erin', 'frank']) {
      expect((await handleLobby(
        await request(`/api/games/${gameId}/join`, 'POST', {}, userId),
        environment(db),
      )).status).toBe(200);
    }
    expect(db.games.get(gameId)?.player_count).toBe(6);
    expect([...db.players.values()].map(player => player.player_index)).toEqual([0, 1, 2, 3, 4, 5]);

    const duplicate = await handleLobby(
      await request(`/api/games/${gameId}/join`, 'POST', { suspect: null }, 'frank'),
      environment(db),
    );
    expect(duplicate.status).toBe(200);
    expect(db.games.get(gameId)?.player_count).toBe(6);
    expect((await handleLobby(
      await request(`/api/games/${gameId}/join`, 'POST', {}, 'grace'),
      environment(db),
    )).status).toBe(409);
  });

  it('reserves bot slots when enforcing the six-player limit', async () => {
    const db = new FakeD1();
    const create = await handleLobby(await request('/api/games', 'POST', { botCount: 5 }, 'alice'), environment(db));
    const gameId = String((await responseBody(create)).id);
    const join = await handleLobby(await request(`/api/games/${gameId}/join`, 'POST', {}, 'bob'), environment(db));
    expect(join.status).toBe(409);
    expect(db.games.get(gameId)?.player_count).toBe(1);
  });

  it('lists lobby public fields without config or private game data', async () => {
    const db = new FakeD1();
    db.games.set('clue-game:public', {
      ...game('clue-game:public'),
      created_at: 10,
      bot_count: 3,
      config_json: JSON.stringify({ solution: 'secret', cards: ['private'] }),
    });
    db.games.set('clue-game:playing', { ...game('clue-game:playing'), state: 'playing' });
    const response = await handleLobby(await request('/api/games', 'GET'), environment(db));
    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({ games: [{
      id: 'clue-game:public',
      created_at: 10,
      host_user_id: 'alice',
      state: 'lobby',
      player_count: 1,
      bot_count: 3,
    }] });
  });

  it('rejects malformed JSON and invalid object shapes', async () => {
    const db = new FakeD1();
    expect((await handleLobby(
      await malformedRequest('/api/games', '{', 'alice'),
      environment(db),
    )).status).toBe(400);
    expect((await handleLobby(
      await request('/api/games', 'POST', [], 'alice'),
      environment(db),
    )).status).toBe(400);
    expect((await handleLobby(
      await request('/api/games', 'POST', { botCount: 6 }, 'alice'),
      environment(db),
    )).status).toBe(400);
  });

  it('maps D1 failures to safe internal errors', async () => {
    const db = new FakeD1();
    db.failNext = true;
    const create = await handleLobby(await request('/api/games', 'POST', {}, 'alice'), environment(db));
    expect(create.status).toBe(500);
    expect(await responseBody(create)).toEqual({ error: 'internal server error' });

    db.failNext = true;
    const list = await handleLobby(await request('/api/games', 'GET'), environment(db));
    expect(list.status).toBe(500);
    expect(await responseBody(list)).toEqual({ error: 'internal server error' });
  });

  it('preserves the index-only start 409 without changing D1', async () => {
    const db = new FakeD1();
    const gameId = 'clue-game:start-boundary';
    const row = game(gameId);
    db.games.set(gameId, row);
    db.players.set(`${gameId}:alice`, {
      game_id: gameId,
      player_index: 0,
      user_id: 'alice',
      suspect: null,
      is_bot: 0,
    });
    const before = JSON.stringify(row);
    const gameRoom = new FakeGameRoomNamespace();
    const response = await handleLobby(
      await request(`/api/games/${gameId}/start`, 'POST', undefined, 'alice'),
      environment(db, gameRoom),
    );
    expect(response.status).toBe(409);
    expect((await responseBody(response)).error).toContain('D1 state is unchanged');
    expect(JSON.stringify(db.games.get(gameId))).toBe(before);
    expect(gameRoom.fetchCalls).toBe(0);

    const notHost = await handleLobby(await request(`/api/games/${gameId}/start`, 'POST', undefined, 'bob'), environment(db));
    expect(notHost.status).toBe(403);
  });
});
