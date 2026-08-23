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

function addGame(db: Database, id: string): void {
  db.query(
    'INSERT INTO games (id, created_at, state, player_count, bot_count, host_user_id, config_json) VALUES (?, 1, ?, 1, 0, ?, ?)',
  ).run(id, 'lobby', 'host', '{}');
}

function addPlayer(db: Database, gameId: string, userId: string, suspect: string): void {
  db.query(
    'INSERT INTO game_players (game_id, user_id, suspect, is_bot) VALUES (?, ?, ?, 0)',
  ).run(gameId, userId, suspect);
}

function expectFailure(action: () => void, message: string): void {
  assert.throws(action, message);
}

function verifyFreshSchema(): void {
  const db = new Database(':memory:');
  db.exec(freshSchema);
  addGame(db, 'clue-game:fresh');
  db.query(
    'INSERT INTO game_players (game_id, player_index, user_id, suspect, is_bot) VALUES (?, 0, ?, NULL, 0)',
  ).run('clue-game:fresh', 'alice');
  apply(db, migration);
  assert.deepEqual(db.query(
    'SELECT game_id, player_index, user_id, suspect FROM game_players',
  ).all(), [{ game_id: 'clue-game:fresh', player_index: 0, user_id: 'alice', suspect: null }]);
  apply(db, migration);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM game_players').get<{ count: number }>()?.count, 1);
  db.close();
}

function verifyBackfillAndConstraints(): void {
  const db = new Database(':memory:');
  oldRegistry(db);
  addGame(db, 'clue-game:backfill');
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

function verifyAtomicFailure(message: string, players: string[][]): void {
  const db = new Database(':memory:');
  oldRegistry(db);
  addGame(db, 'clue-game:invalid');
  for (const [userId, suspect] of players) addPlayer(db, 'clue-game:invalid', userId!, suspect!);
  expectFailure(() => apply(db, migration), new RegExp(message));
  assert.equal(db.query(
    "SELECT COUNT(*) AS count FROM pragma_table_info('game_players') WHERE name = 'player_index'",
  ).get<{ count: number }>()?.count, 0);
  assert.equal(db.query('SELECT COUNT(*) AS count FROM game_players').get<{ count: number }>()?.count, players.length);
  db.close();
}

verifyFreshSchema();
verifyBackfillAndConstraints();
verifyAtomicFailure('d1_lobby_membership_max_six', [
  ['a', 'Miss Scarlett'], ['b', 'Professor Plum'], ['c', 'Mrs. Peacock'],
  ['d', 'Mr. Green'], ['e', 'Mrs. White'], ['f', 'Colonel Mustard'], ['g', 'Miss Scarlett'],
]);
verifyAtomicFailure('d1_lobby_membership_unique_suspect', [
  ['a', 'Miss Scarlett'], ['b', 'Miss Scarlett'],
]);
console.log('schema migration verification passed: fresh, backfill, repeat, constraints, atomic failures');
