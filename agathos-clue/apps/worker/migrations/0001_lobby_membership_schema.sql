CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER,
  host_user_id TEXT NOT NULL, state TEXT NOT NULL,
  player_count INTEGER NOT NULL, bot_count INTEGER NOT NULL,
  winner_user_id TEXT, config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS game_events (
  game_id TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, event_json TEXT NOT NULL,
  PRIMARY KEY (game_id, seq)
);

-- This placeholder also makes the migration usable on a new D1 database. It
-- is replaced below so old NOT NULL suspect columns become nullable.
CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL REFERENCES games(id),
  user_id TEXT NOT NULL, suspect TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0, finished_rank INTEGER,
  PRIMARY KEY (game_id, user_id)
);

CREATE INDEX IF NOT EXISTS games_host ON games(host_user_id);
CREATE INDEX IF NOT EXISTS games_state ON games(state);

-- D1 runs a migration atomically. A named CHECK gives overflow a useful
-- failure while rolling back every preceding schema/data change.
CREATE TABLE _d1_lobby_migration_overflow_guard (
  ok INTEGER NOT NULL,
  CONSTRAINT d1_lobby_membership_max_six CHECK (ok = 1)
);
INSERT INTO _d1_lobby_migration_overflow_guard (ok)
SELECT 0
FROM game_players
GROUP BY game_id
HAVING COUNT(*) > 6;
DROP TABLE _d1_lobby_migration_overflow_guard;

-- Existing registries did not enforce suspect uniqueness. Validate before
-- rebuilding so conflicting claims fail as part of the same transaction.
CREATE TABLE _d1_lobby_migration_suspect_guard (
  ok INTEGER NOT NULL,
  CONSTRAINT d1_lobby_membership_unique_suspect CHECK (ok = 1)
);
INSERT INTO _d1_lobby_migration_suspect_guard (ok)
SELECT 0
FROM game_players
WHERE suspect IS NOT NULL
GROUP BY game_id, suspect
HAVING COUNT(*) > 1;
DROP TABLE _d1_lobby_migration_suspect_guard;

CREATE TABLE game_players_migration (
  game_id TEXT NOT NULL REFERENCES games(id),
  player_index INTEGER NOT NULL CHECK (player_index >= 0 AND player_index < 6),
  user_id TEXT NOT NULL, suspect TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0, finished_rank INTEGER,
  PRIMARY KEY (game_id, user_id),
  UNIQUE (game_id, player_index)
);

-- user_id is unique within a game, so this count assigns stable indexes in
-- binary user_id order without depending on insertion order or rowid.
INSERT INTO game_players_migration
  (game_id, player_index, user_id, suspect, is_bot, finished_rank)
SELECT player.game_id,
       (
         SELECT COUNT(*)
         FROM game_players AS prior
         WHERE prior.game_id = player.game_id
           AND prior.user_id < player.user_id
       ),
       player.user_id, player.suspect, player.is_bot, player.finished_rank
FROM game_players AS player
ORDER BY player.game_id, player.user_id;

DROP TABLE game_players;
ALTER TABLE game_players_migration RENAME TO game_players;

CREATE UNIQUE INDEX IF NOT EXISTS game_players_suspect
  ON game_players(game_id, suspect) WHERE suspect IS NOT NULL;
