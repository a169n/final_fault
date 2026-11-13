
CREATE TABLE rooms (
  id       TEXT PRIMARY KEY,
  capacity INT  NOT NULL
);

CREATE TABLE courses (
  id       TEXT PRIMARY KEY,
  teacher  TEXT NOT NULL,
  students INT  NOT NULL
);

CREATE TABLE timetable_jobs (
  term         TEXT PRIMARY KEY,
  state        TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','done')),
  owner        TEXT NOT NULL,
  checkpoint   JSONB NOT NULL DEFAULT '{}',
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX timetable_jobs_lease_idx ON timetable_jobs (state, heartbeat_at);

INSERT INTO rooms (id, capacity) VALUES
  ('R101', 25), ('R102', 25), ('R201', 40), ('R202', 40), ('R203', 40),
  ('R301', 60), ('R302', 60), ('R401', 80), ('HALL-A', 100), ('HALL-B', 150);

INSERT INTO courses (id, teacher, students)
SELECT 'C' || lpad(i::text, 3, '0'), 'T' || (i % 40), 10 + (i * 37) % 90
FROM generate_series(1, 120) AS i;
