CREATE TABLE students (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  credits INT  NOT NULL DEFAULT 0,
  balance NUMERIC(10,2) NOT NULL DEFAULT 0
);

CREATE TABLE payments (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,  -- S5: no double charge
  student_id      TEXT NOT NULL,
  amount          NUMERIC(10,2) NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending','completed','failed','rolled_back')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_state_idx ON payments (state);

CREATE TABLE grades (
  student_id TEXT NOT NULL,
  course     TEXT NOT NULL,
  grade      NUMERIC(3,1) NOT NULL,
  PRIMARY KEY (student_id, course)
);

INSERT INTO students (id, name, credits) SELECT 's' || i, 'Student ' || i, (i * 7) % 180
FROM generate_series(1, 200) AS i;

INSERT INTO grades (student_id, course, grade)
SELECT 's' || i, 'COURSE-' || c, 2.0 + ((i + c) % 3)
FROM generate_series(1, 200) AS i, generate_series(1, 5) AS c;
