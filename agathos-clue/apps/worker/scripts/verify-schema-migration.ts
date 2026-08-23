import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';

const migration = await Bun.file(
  `${import.meta.dir}/../migrations/0001_lobby_membership_schema.sql`,
).text();
const freshSchema = await Bun.file(`${import.meta.dir}/../src/schema.sql`).text();

function apply(db: Database, sql: string): void {
  const statements = sql.split(';').map(statement => statement.trim()).filter(Boolean);
  db.transaction(() => {
    for (const statement of statements) db.exec(statement);
  })();
}

function oldRegistry(db: Database): void {
  db.exec(`
    CREATE TABLE games (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER,
      host_user_id TEXT NOT NULL, state TEXT NOT NULL,
      player_count INTEGER NOT NULL, bot_count INTEGER NOT NULL,
      winner_user_id TEXT, config_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE game_players (
      game_id TEXT NOT NULL REFERENCES games(id),
      user_id TEXT NOT NULL, suspect TEXT NOT NULL,
      is_bot INTEGER NOT NULL DEFAULT 0, finished_rank INTEGER,
      PRIMARY KEY (game_id, user_id)
    );
  `);
}

interface GameOptions {
  createdAt?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  hostUserId?: string;
  state?: string;
  playerCount?: number;
  botCount?: number;
  winnerUserId?: string | null;
  configJson?: string;
}

function addGame(db: Database, id: string, options: GameOptions = {}): void {
  db.query(
    `INSERT INTO games
      (id, created_at, started_at, finished_at, state, player_count, bot_count,
       host_user_id, winner_user_id, config_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    options.createdAt ?? 1,
    options.startedAt ?? null,
    options.finishedAt ?? null,
    options.state ?? 'lobby',
    options.playerCount ?? 1,
    options.botCount ?? 0,
    options.hostUserId ?? 'host',
    options.winnerUserId ?? null,
    options.configJson ?? '{}',
  );
}

function addPlayer(db: Database, gameId: string, userId: string, suspect: string, isBot = 0): void {
  db.query(
    'INSERT INTO game_players (game_id, user_id, suspect, is_bot) VALUES (?, ?, ?, ?)',
  ).run(gameId, userId, suspect, isBot);
}

function expectFailure(action: () => void, message: string): void {
  assert.throws(action, message);
}

function verifyFreshSchema(): void {
  const db = new Database(':memory:');
  db.exec(freshSchema);
  addGame(db, 'clue-game:fresh', { hostUserId: 'alice' });
  db.query(
    'INSERT INTO game_players (game_id, player_index, user_id, suspect, is_bot) VALUES (?, 0, ?, NULL, 0)',
  ).run('clue-game:fresh', 'alice');
  apply(db, migration);
  assert.deepEqual(db.query(
    'SELECT game_id, player_index, user_id, suspect FROM game_players',
  ).all(), [{ game_id: 'clue-game:fresh', player_index: 0, user_id: 'alice', suspect: null }]);
  assert.equal(db.query('SELECT player_count FROM games WHERE id = ?').get<{ player_count: number }>('clue-game:fresh')?.player_count, 1);
  apply(db, migration);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM game_players').get<{ count: number }>()?.count, 1);
  assert.equal(db.query('SELECT player_count FROM games WHERE id = ?').get<{ player_count: number }>('clue-game:fresh')?.player_count, 1);
  db.close();
}

function verifyBackfillAndConstraints(): void {
  const db = new Database(':memory:');
  oldRegistry(db);
  addGame(db, 'clue-game:backfill', { hostUserId: 'alice' });
  addPlayer(db, 'clue-game:backfill', 'charlie', 'Colonel Mustard');
  addPlayer(db, 'clue-game:backfill', 'alice', 'Miss Scarlett');
  addPlayer(db, 'clue-game:backfill', 'bob', 'Professor Plum');
  apply(db, migration);

  assert.deepEqual(db.query(
    'SELECT game_id, player_index, user_id, suspect FROM game_players ORDER BY player_index',
  ).all(), [
    { game_id: 'clue-game:backfill', player_index: 0, user_id: 'alice', suspect: 'Miss Scarlett' },
    { game_id: 'clue-game:backfill', player_index: 1, user_id: 'bob', suspect: 'Professor Plum' },
    { game_id: 'clue-game:backfill', player_index: 2, user_id: 'charlie', suspect: 'Colonel Mustard' },
  ]);
  assert.equal(db.query(
    "SELECT \"notnull\" FROM pragma_table_info('game_players') WHERE name = 'player_index'",
  ).get<{ notnull: number }>()?.notnull, 1);
  expectFailure(() => db.query(
    'INSERT INTO game_players (game_id, player_index, user_id, suspect) VALUES (?, 0, ?, NULL)',
  ).run('clue-game:backfill', 'dave'), /UNIQUE/);
  expectFailure(() => db.query(
    'INSERT INTO game_players (game_id, player_index, user_id, suspect) VALUES (?, 3, ?, ?)',
  ).run('clue-game:backfill', 'dave', 'Miss Scarlett'), /UNIQUE/);
  db.query(
    'INSERT INTO game_players (game_id, player_index, user_id, suspect) VALUES (?, 3, ?, NULL)',
  ).run('clue-game:backfill', 'dave');
  db.close();
}

function verifyRepairOfLegacyRows(): void {
  const db = new Database(':memory:');
  oldRegistry(db);
  addGame(db, 'clue-game:repair', {
    createdAt: 42,
    startedAt: 100,
    finishedAt: 200,
    hostUserId: 'host',
    state: 'finished',
    playerCount: 99,
    botCount: 2,
    winnerUserId: 'winner',
    configJson: '{"timerSeconds":60,"private":true}',
  });
  addPlayer(db, 'clue-game:repair', 'alice', '', 0);
  addPlayer(db, 'clue-game:repair', 'robot', 'Professor Plum', 1);
  addPlayer(db, 'clue-game:repair', 'zulu', 'Miss Scarlett', 0);

  apply(db, migration);

  assert.deepEqual(db.query(
    'SELECT game_id, player_index, user_id, suspect, is_bot FROM game_players ORDER BY player_index',
  ).all(), [
    { game_id: 'clue-game:repair', player_index: 0, user_id: 'alice', suspect: null, is_bot: 0 },
    { game_id: 'clue-game:repair', player_index: 1, user_id: 'robot', suspect: 'Professor Plum', is_bot: 1 },
    { game_id: 'clue-game:repair', player_index: 2, user_id: 'zulu', suspect: 'Miss Scarlett', is_bot: 0 },
    { game_id: 'clue-game:repair', player_index: 3, user_id: 'host', suspect: null, is_bot: 0 },
  ]);
  assert.deepEqual(db.query(
    'SELECT created_at, started_at, finished_at, host_user_id, state, player_count, bot_count, winner_user_id, config_json FROM games WHERE id = ?',
  ).get('clue-game:repair'), {
    created_at: 42,
    started_at: 100,
    finished_at: 200,
    host_user_id: 'host',
    state: 'finished',
    player_count: 3,
    bot_count: 2,
    winner_user_id: 'winner',
    config_json: '{"timerSeconds":60,"private":true}',
  });

  apply(db, migration);
  assert.equal(db.query(
    'SELECT COUNT(*) AS count FROM game_players WHERE game_id = ? AND user_id = ?',
  ).get<{ count: number }>('clue-game:repair', 'host')?.count, 1);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM game_players WHERE game_id = ?').get<{ count: number }>('clue-game:repair')?.count, 4);
  assert.equal(db.query('SELECT player_count FROM games WHERE id = ?').get<{ player_count: number }>('clue-game:repair')?.player_count, 3);
  db.close();
}

function verifyAtomicFailure(message: string, players: string[][], playerCount = 1): void {
  const db = new Database(':memory:');
  oldRegistry(db);
  addGame(db, 'clue-game:invalid', { playerCount, configJson: '{"keep":"this"}' });
  for (const [userId, suspect] of players) addPlayer(db, 'clue-game:invalid', userId!, suspect!);
  const beforeGame = db.query('SELECT * FROM games WHERE id = ?').get('clue-game:invalid');
  const beforePlayers = db.query(
    'SELECT game_id, user_id, suspect, is_bot, finished_rank FROM game_players ORDER BY user_id',
  ).all();
  expectFailure(() => apply(db, migration), new RegExp(message));
  assert.equal(db.query(
    "SELECT COUNT(*) AS count FROM pragma_table_info('game_players') WHERE name = 'player_index'",
  ).get<{ count: number }>()?.count, 0);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM game_players').get<{ count: number }>()?.count, players.length);
  assert.deepEqual(db.query('SELECT * FROM games WHERE id = ?').get('clue-game:invalid'), beforeGame);
  assert.deepEqual(db.query(
    'SELECT game_id, user_id, suspect, is_bot, finished_rank FROM game_players ORDER BY user_id',
  ).all(), beforePlayers);
  db.close();
}

verifyFreshSchema();
verifyBackfillAndConstraints();
verifyRepairOfLegacyRows();
verifyAtomicFailure('d1_lobby_membership_max_six', [
  ['a', 'Miss Scarlett'], ['b', 'Professor Plum'], ['c', 'Mrs. Peacock'],
  ['d', 'Mr. Green'], ['e', 'Mrs. White'], ['f', 'Colonel Mustard'], ['g', 'Miss Scarlett'],
]);
verifyAtomicFailure('d1_lobby_membership_unique_suspect', [
  ['a', 'Miss Scarlett'], ['b', 'Miss Scarlett'],
]);
verifyAtomicFailure('d1_lobby_membership_valid_suspect', [
  ['a', 'Unknown Suspect'],
]);
verifyAtomicFailure('d1_lobby_membership_host_slot_available', [
  ['a', 'Miss Scarlett'], ['b', 'Professor Plum'], ['c', 'Mrs. Peacock'],
  ['d', 'Mr. Green'], ['e', 'Mrs. White'], ['f', 'Colonel Mustard'],
], 1);
console.log('schema migration verification passed: fresh, legacy repair, repeat, constraints, atomic failures');
