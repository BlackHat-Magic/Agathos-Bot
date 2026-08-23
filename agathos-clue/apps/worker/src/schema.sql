CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER,
  host_user_id TEXT NOT NULL, state TEXT NOT NULL,
  player_count INTEGER NOT NULL, bot_count INTEGER NOT NULL,
  winner_user_id TEXT, config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL REFERENCES games(id),
  player_index INTEGER NOT NULL CHECK (player_index >= 0 AND player_index < 6),
  user_id TEXT NOT NULL, suspect TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0, finished_rank INTEGER,
  PRIMARY KEY (game_id, user_id),
  UNIQUE (game_id, player_index)
);

CREATE TABLE IF NOT EXISTS game_events (
  game_id TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, event_json TEXT NOT NULL,
  PRIMARY KEY (game_id, seq)
);

CREATE INDEX IF NOT EXISTS games_host ON games(host_user_id);
CREATE INDEX IF NOT EXISTS games_state ON games(state);
CREATE UNIQUE INDEX IF NOT EXISTS game_players_suspect
  ON game_players(game_id, suspect) WHERE suspect IS NOT NULL;
