CREATE TABLE players (
  id TEXT PRIMARY KEY,          -- uuid, generated at registration
  name TEXT NOT NULL,
  contact TEXT,                 -- optional, per current entry gate
  avatar TEXT NOT NULL,         -- shape+color combo or 'photo:<r2_key>'
  created_at INTEGER NOT NULL   -- unix timestamp, server-side
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,          -- uuid
  player_id TEXT NOT NULL REFERENCES players(id),
  prompt_id TEXT NOT NULL,      -- matches R02-R34 from the prompt pool
  round INTEGER NOT NULL,       -- 1, 2, or 3
  points INTEGER NOT NULL,
  media_url TEXT,               -- R2 key/URL, null for text-proof prompts
  created_at INTEGER NOT NULL   -- server timestamp -- needed for tie-break later
);

CREATE INDEX idx_submissions_player_id ON submissions(player_id);
CREATE INDEX idx_submissions_round ON submissions(round);
