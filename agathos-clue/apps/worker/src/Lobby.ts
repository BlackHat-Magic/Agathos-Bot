import { isSuspect } from '@agathos/game';
import type { Env } from './index';
import { verifyJwt } from './auth/jwt';

const MAX_GAME_ID_LENGTH = 80;
const MAX_CONFIG_BYTES = 4_096;
const MAX_BOT_COUNT = 5;
const MAX_PLAYERS = 6;
const MAX_DEV_ID_LENGTH = 128;
const GAME_ID_PATTERN = /^clue-game:[A-Za-z0-9_-]{1,64}$/;
const LOBBY_STATE = 'lobby';

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

interface PublicGame {
  id: string;
  created_at: number;
  host_user_id: string;
  state: 'lobby';
  player_count: number;
  bot_count: number;
}

interface PlayerRow {
  game_id: string;
  player_index: number;
  user_id: string;
  suspect: string | null;
  is_bot: number;
}

class LobbyHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function handleLobby(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const gamePath = /^\/api\/games\/([^/]+)\/(join|start)$/.exec(url.pathname);
  const isMutation = req.method === 'POST';

  try {
    if (url.pathname === '/api/games' && req.method === 'GET') {
      return await listGames(env);
    }
    if (url.pathname === '/api/games' && req.method === 'POST') {
      const userId = await requireIdentity(req, env);
      return await createGame(req, env, userId);
    }
    if (gamePath !== null && isMutation) {
      const userId = await requireIdentity(req, env);
      const gameId = parseGameId(gamePath[1]);
      if (gamePath[2] === 'join') return await joinGame(req, env, gameId, userId);
      return await startGame(env, gameId, userId);
    }
    if (isMutation && url.pathname.startsWith('/api/')) await requireIdentity(req, env);
    return json({ error: 'not found' }, 404);
  } catch (error) {
    if (error instanceof LobbyHttpError) return json({ error: error.message }, error.status);
    console.error('lobby request failed');
    return json({ error: 'internal server error' }, 500);
  }
}

async function createGame(req: Request, env: Env, hostUserId: string): Promise<Response> {
  const body = await readObject(req);
  requireAllowedKeys(body, ['hostUserId', 'botCount', 'config']);
  const botCount = body.botCount === undefined ? 0 : parseBotCount(body.botCount);
  const config = body.config === undefined ? {} : parseConfig(body.config);
  const id = `clue-game:${crypto.randomUUID()}`;
  const configJson = JSON.stringify(config);

  await env.LOBBY_DB.batch([
    env.LOBBY_DB.prepare(
      'INSERT INTO games (id, created_at, state, player_count, bot_count, host_user_id, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, Date.now(), LOBBY_STATE, 1, botCount, hostUserId, configJson),
    env.LOBBY_DB.prepare(
      'INSERT INTO game_players (game_id, player_index, user_id, suspect, is_bot) VALUES (?, ?, ?, ?, 0)',
    ).bind(id, 0, hostUserId, null),
    countPlayersStatement(env, id),
  ]);
  return json({ id });
}

async function listGames(env: Env): Promise<Response> {
  const result = await env.LOBBY_DB.prepare(
    'SELECT id, created_at, host_user_id, state, player_count, bot_count FROM games WHERE state = ? ORDER BY created_at DESC',
  ).bind(LOBBY_STATE).all<unknown>();
  const games = result.results.map(value => toPublicGame(value));
  return json({ games });
}

async function joinGame(
  req: Request,
  env: Env,
  gameId: string,
  userId: string,
): Promise<Response> {
  const game = await findGame(env, gameId);
  if (game === null) throw new LobbyHttpError(404, 'game not found');
  if (game.state !== LOBBY_STATE) throw new LobbyHttpError(409, 'game is not in the lobby');

  const body = await readObject(req);
  requireAllowedKeys(body, ['userId', 'suspect']);
  const suspect = body.suspect === undefined || body.suspect === null
    ? null
    : parseSuspect(body.suspect);
  const players = await findPlayers(env, gameId);
  const existing = players.find(player => player.user_id === userId);
  if (existing === undefined) {
    const humanCount = players.filter(player => player.is_bot === 0).length;
    if (humanCount + game.bot_count >= MAX_PLAYERS) {
      throw new LobbyHttpError(409, 'game is full');
    }
  }
  if (suspect !== null && players.some(player =>
    player.user_id !== userId && player.suspect === suspect,
  )) {
    throw new LobbyHttpError(409, 'suspect is already claimed');
  }

  const playerIndex = existing?.player_index ?? findPlayerIndex(players, game.bot_count);
  await env.LOBBY_DB.batch([
    env.LOBBY_DB.prepare(
      'INSERT INTO game_players (game_id, player_index, user_id, suspect, is_bot) VALUES (?, ?, ?, ?, 0) ON CONFLICT(game_id, user_id) DO UPDATE SET suspect = excluded.suspect',
    ).bind(gameId, playerIndex, userId, suspect),
    countPlayersStatement(env, gameId),
  ]);
  return json({ ok: true });
}

async function startGame(env: Env, gameId: string, userId: string): Promise<Response> {
  const game = await findGame(env, gameId);
  if (game === null) throw new LobbyHttpError(404, 'game not found');
  if (game.state !== LOBBY_STATE) throw new LobbyHttpError(409, 'game is not in the lobby');
  if (game.host_user_id !== userId) throw new LobbyHttpError(403, 'only the host can start the game');

  // GameRoom owns lifecycle and game state. This Worker path cannot synchronously
  // establish a WebSocket start, so D1 must remain lobby until that authoritative
  // transition exists rather than pretending the index started the game.
  throw new LobbyHttpError(
    409,
    'authoritative GameRoom start requires the WebSocket lifecycle; D1 state is unchanged',
  );
}

async function findGame(env: Env, gameId: string): Promise<GameRow | null> {
  const result = await env.LOBBY_DB.prepare(
    'SELECT id, created_at, started_at, finished_at, host_user_id, state, player_count, bot_count, winner_user_id, config_json FROM games WHERE id = ? LIMIT 1',
  ).bind(gameId).all<unknown>();
  const value = result.results[0];
  return value === undefined ? null : parseGameRow(value);
}

async function requireIdentity(req: Request, env: Env): Promise<string> {
  const authorization = req.headers.get('Authorization');
  const match = authorization === null ? null : /^Bearer ([^\s]+)$/i.exec(authorization);
  const claims = match === null ? null : await verifyJwt(match[1]!, env.JWT_SECRET);
  const userId = claims?.userId;
  if (typeof userId !== 'string' || !isValidDevId(userId)) {
    throw new LobbyHttpError(401, 'unauthorized');
  }
  return userId;
}

async function readObject(req: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    throw new LobbyHttpError(400, 'request body must be valid JSON');
  }
  if (!isPlainObject(value)) throw new LobbyHttpError(400, 'request body must be a JSON object');
  return value;
}

function parseGameId(raw: string): string {
  let gameId: string;
  try {
    gameId = decodeURIComponent(raw);
  } catch {
    throw new LobbyHttpError(400, 'invalid game id');
  }
  if (gameId.length > MAX_GAME_ID_LENGTH || !GAME_ID_PATTERN.test(gameId)) {
    throw new LobbyHttpError(400, 'invalid game id');
  }
  return gameId;
}

function parseBotCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_BOT_COUNT) {
    throw new LobbyHttpError(400, `botCount must be an integer from 0 to ${MAX_BOT_COUNT}`);
  }
  return value;
}

function parseConfig(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new LobbyHttpError(400, 'config must be a JSON object');
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new LobbyHttpError(400, 'config must be JSON serializable');
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONFIG_BYTES) {
    throw new LobbyHttpError(400, `config must be at most ${MAX_CONFIG_BYTES} bytes`);
  }
  return value;
}

function parseSuspect(value: unknown): string {
  if (typeof value !== 'string' || !isSuspect(value)) {
    throw new LobbyHttpError(400, 'suspect is invalid');
  }
  return value;
}

function countPlayersStatement(env: Env, gameId: string): D1PreparedStatement {
  return env.LOBBY_DB.prepare(
    'UPDATE games SET player_count = (SELECT COUNT(*) FROM game_players WHERE game_id = ? AND is_bot = 0) WHERE id = ?',
  ).bind(gameId, gameId);
}

function findPlayerIndex(players: PlayerRow[], botCount: number): number {
  const occupied = new Set(players.map(player => player.player_index));
  const humanLimit = MAX_PLAYERS - botCount;
  for (let playerIndex = 0; playerIndex < humanLimit; playerIndex += 1) {
    if (!occupied.has(playerIndex)) return playerIndex;
  }
  throw new LobbyHttpError(409, 'game is full');
}

async function findPlayers(env: Env, gameId: string): Promise<PlayerRow[]> {
  const result = await env.LOBBY_DB.prepare(
    'SELECT game_id, player_index, user_id, suspect, is_bot FROM game_players WHERE game_id = ? ORDER BY player_index',
  ).bind(gameId).all<unknown>();
  return result.results.map(value => parsePlayerRow(value));
}

function requireAllowedKeys(body: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(body).some(key => !allowedKeys.has(key))) {
    throw new LobbyHttpError(400, 'request body contains an unsupported field');
  }
}

function parseGameRow(value: unknown): GameRow {
  if (!isPlainObject(value) ||
      typeof value.id !== 'string' || value.id.length > MAX_GAME_ID_LENGTH || !GAME_ID_PATTERN.test(value.id) ||
      typeof value.created_at !== 'number' || !Number.isFinite(value.created_at) ||
      (value.started_at !== null && typeof value.started_at !== 'number') ||
      (value.finished_at !== null && typeof value.finished_at !== 'number') ||
      typeof value.host_user_id !== 'string' || !isValidDevId(value.host_user_id) ||
      typeof value.state !== 'string' ||
      typeof value.player_count !== 'number' || !Number.isInteger(value.player_count) || value.player_count < 0 || value.player_count > MAX_PLAYERS ||
      typeof value.bot_count !== 'number' || !Number.isInteger(value.bot_count) || value.bot_count < 0 ||
      value.bot_count > MAX_BOT_COUNT || value.player_count + value.bot_count > MAX_PLAYERS ||
      (value.winner_user_id !== null && typeof value.winner_user_id !== 'string') ||
      typeof value.config_json !== 'string') {
    throw new Error('invalid game row');
  }
  if (value.state !== 'lobby' && value.state !== 'playing' && value.state !== 'finished') {
    throw new Error('invalid game state');
  }
  return value as unknown as GameRow;
}

function toPublicGame(value: unknown): PublicGame {
  if (!isPlainObject(value) ||
      typeof value.id !== 'string' || value.id.length > MAX_GAME_ID_LENGTH || !GAME_ID_PATTERN.test(value.id) ||
      typeof value.created_at !== 'number' || !Number.isFinite(value.created_at) ||
      typeof value.host_user_id !== 'string' || !isValidDevId(value.host_user_id) ||
      value.state !== LOBBY_STATE ||
      typeof value.player_count !== 'number' || !Number.isInteger(value.player_count) || value.player_count < 0 || value.player_count > MAX_PLAYERS ||
      typeof value.bot_count !== 'number' || !Number.isInteger(value.bot_count) ||
      value.bot_count < 0 || value.bot_count > MAX_BOT_COUNT || value.player_count + value.bot_count > MAX_PLAYERS) {
    throw new Error('invalid lobby query result');
  }
  return {
    id: value.id,
    created_at: value.created_at,
    host_user_id: value.host_user_id,
    state: LOBBY_STATE,
    player_count: value.player_count,
    bot_count: value.bot_count,
  };
}

function parsePlayerRow(value: unknown): PlayerRow {
  if (!isPlainObject(value) ||
      typeof value.game_id !== 'string' || !GAME_ID_PATTERN.test(value.game_id) ||
      typeof value.player_index !== 'number' || !Number.isInteger(value.player_index) ||
      value.player_index < 0 || value.player_index >= MAX_PLAYERS ||
      typeof value.user_id !== 'string' || !isValidDevId(value.user_id) ||
      (value.suspect !== null && !isSuspect(value.suspect)) ||
      (value.is_bot !== 0 && value.is_bot !== 1)) {
    throw new Error('invalid game player row');
  }
  return value as unknown as PlayerRow;
}

function isValidDevId(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_DEV_ID_LENGTH && !/\s/.test(value);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
