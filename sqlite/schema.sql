-- TABLE poker app — SQLite schema
-- Currency is non-redeemable Poker Dollars (PD), not Japanese yen.
-- The unused normalized game tables retain legacy *_yen column names to avoid
-- destructive schema changes. Live app_state entries/payout values are PD.
-- Passwords must be stored as Argon2id/bcrypt hashes by the server, never plaintext.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_path TEXT,
  play_style TEXT NOT NULL DEFAULT 'エンジョイ勢',
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('admin', 'player')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (length(account_id) BETWEEN 3 AND 20)
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Cash Game',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'running', 'finished', 'cancelled')),
  starts_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  small_blind INTEGER NOT NULL DEFAULT 100 CHECK (small_blind > 0),
  big_blind INTEGER NOT NULL DEFAULT 200 CHECK (big_blind >= small_blind),
  starting_stack INTEGER NOT NULL DEFAULT 1000 CHECK (starting_stack > 0),
  dealer_interval_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (dealer_interval_seconds > 0),
  timer_remaining_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (timer_remaining_seconds >= 0),
  timer_started_at TEXT,
  timer_paused INTEGER NOT NULL DEFAULT 1 CHECK (timer_paused IN (0, 1)),
  current_dealer_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES users(id),
  initial_buy_in_yen INTEGER NOT NULL DEFAULT 0 CHECK (initial_buy_in_yen >= 0),
  total_buy_in_yen INTEGER NOT NULL DEFAULT 0 CHECK (total_buy_in_yen >= 0),
  bust_count INTEGER NOT NULL DEFAULT 0 CHECK (bust_count >= 0),
  cashout_chips INTEGER NOT NULL DEFAULT 0 CHECK (cashout_chips >= 0),
  payout_yen INTEGER NOT NULL DEFAULT 0 CHECK (payout_yen >= 0),
  placement INTEGER CHECK (placement IS NULL OR placement > 0),
  checked_in_at TEXT,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (game_id, player_id)
);

CREATE TABLE IF NOT EXISTS cashout_reports (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  starting_stack INTEGER NOT NULL CHECK (starting_stack > 0),
  bust_count INTEGER NOT NULL DEFAULT 0 CHECK (bust_count >= 0),
  cashout_chips INTEGER NOT NULL CHECK (cashout_chips >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES users(id),
  FOREIGN KEY (game_id, player_id) REFERENCES game_players(game_id, player_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS cashout_reports_one_pending_per_player
  ON cashout_reports(game_id, player_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS game_rebuys (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  amount_yen INTEGER NOT NULL CHECK (amount_yen > 0),
  chips_added INTEGER NOT NULL CHECK (chips_added > 0),
  recorded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (game_id, player_id) REFERENCES game_players(game_id, player_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_chip_settings (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  color TEXT NOT NULL,
  denomination INTEGER NOT NULL CHECK (denomination > 0),
  quantity_per_player INTEGER NOT NULL CHECK (quantity_per_player >= 0),
  UNIQUE (game_id, color, denomination)
);

CREATE INDEX IF NOT EXISTS games_starts_at_idx ON games(starts_at DESC);
CREATE INDEX IF NOT EXISTS game_players_player_idx ON game_players(player_id);
CREATE INDEX IF NOT EXISTS cashout_reports_game_idx ON cashout_reports(game_id, status);
