-- Users of the auth service (app/services/auth.py). Synthetic data only.
-- The table starts empty: on start-up the auth service seeds the demo users (admin, bursar, s7, s8)
-- with DEMO_PASSWORD from .env, so no password or hash is ever committed to the repository.
CREATE TABLE app_users (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,                     -- scrypt$<salt_b64>$<hash_b64>, never a plaintext
  role          TEXT NOT NULL CHECK (role IN ('student','staff','admin')),
  student_id    TEXT NULL REFERENCES students (id),
  -- a student account is bound to exactly one student record; staff and admin are bound to none
  CHECK ((role = 'student') = (student_id IS NOT NULL))
);
