export type Rec = {
  ts: number;        // request start, epoch ms
  op: string;        // students | transcripts | payments
  status: number;    // 0 = transport failure or client timeout
  ok: boolean;       // 2xx or 203 degraded
  degraded: boolean; // 203: served, but from stale data
  abandoned?: boolean; // still in flight when the observation window closed
  ms: number;
  err?: string;
  intent?: string;   // logical payment intent (idempotency key)
  retry?: boolean;   // a client-side resend of the same intent
  rid: string;       // x-request-id sent with the request: <runId>-<n>, greppable in logs/events.jsonl
  rateLimited: boolean;  // 429 from the endterm rate limiter
  payState?: string; // payments: `state` from the response body (a 200 resend can carry pending/rolled_back)
};

export type WorkloadOpts = {
  gateway: string;
  durationMs: number;
  concurrency: number;
  rampAtMs?: number;      // high-load scenario: extra workers join at this offset
  rampConcurrency?: number;
  clientTimeoutMs?: number;
  runId: string;
  token?: string;         // endterm: bearer token sent as Authorization on every request
};

// Endterm: one login per run (POST /auth/token through nginx). Throws on anything but a token.
export async function login(gateway: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${gateway}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !body.access_token) throw new Error(`login as ${username} failed: HTTP ${res.status}`);
  return body.access_token;
}

const OPS = [
  { name: 'students', weight: 0.6 },
  { name: 'transcripts', weight: 0.2 },
  { name: 'payments', weight: 0.2 },
];

const pickOp = () => {
  let r = Math.random();
  for (const o of OPS) if ((r -= o.weight) <= 0) return o.name;
  return 'students';
};

export async function runWorkload(opts: WorkloadOpts): Promise<Rec[]> {
  const { gateway, durationMs, concurrency, runId } = opts;
  const clientTimeoutMs = opts.clientTimeoutMs ?? 10_000;
  const deadline = Date.now() + durationMs;
  const recs: Rec[] = [];
  let intentCounter = 0;
  let requestCounter = 0;
  const auth: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};

  const windowOver = new AbortController();
  const stopTimer = setTimeout(() => windowOver.abort(), durationMs);

  const randomStudent = (): string => `s${1 + Math.floor(Math.random() * 200)}`;

  // `student` is fixed per payment intent: a client re-send of an intent repeats the same request body
  // under the same Idempotency-Key. (Up to the endterm campaign the re-send drew a new student; the
  // endterm payment service now answers a key re-used for a different payment with 409, REPORT.md §5.5.)
  async function once(op: string, intent?: string, retry = false, student: string = randomStudent()): Promise<void> {
    const started = Date.now();
    let url = `${gateway}/api/students/${student}`;
    const signal = AbortSignal.any([AbortSignal.timeout(clientTimeoutMs), windowOver.signal]);
    const rid = `${runId}-${requestCounter++}`;
    let init: RequestInit = { signal, headers: { 'x-request-id': rid, ...auth } };

    if (op === 'transcripts') url = `${gateway}/api/transcripts/${student}`;
    if (op === 'payments') {
      url = `${gateway}/api/payments`;
      init = {
        ...init,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': intent!, 'x-request-id': rid, ...auth },
        body: JSON.stringify({ studentId: student, amount: 100 }),
      };
    }

    try {
      const res = await fetch(url, init);
      const text = await res.text();
      let payState: string | undefined;
      if (op === 'payments') {
        try {
          const st = (JSON.parse(text) as { state?: unknown }).state;
          if (typeof st === 'string') payState = st;
        } catch { /* not JSON: no state */ }
      }
      recs.push({
        ts: started, op, status: res.status, ok: res.status < 400,
        degraded: res.status === 203, ms: Date.now() - started, intent, retry,
        rid, rateLimited: res.status === 429,
        ...(payState !== undefined ? { payState } : {}),
      });
    } catch (e) {
      const abandoned = windowOver.signal.aborted && Date.now() - started < clientTimeoutMs;
      recs.push({
        ts: started, op, status: 0, ok: false, degraded: false, abandoned,
        ms: Date.now() - started,
        err: abandoned ? 'abandoned_at_window_close'
          : (e as Error).name === 'TimeoutError' ? 'client_timeout' : (e as Error).message,
        intent, retry, rid, rateLimited: false,
      });
    }
  }

  async function worker(): Promise<void> {
    while (Date.now() < deadline && !windowOver.signal.aborted) {
      const op = pickOp();
      if (op === 'payments') {
        const intent = `${runId}-${intentCounter++}`;
        const student = randomStudent();
        await once(op, intent, false, student);
        if (Math.random() < 0.2) await once(op, intent, true, student);
      } else {
        await once(op);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const workers = Array.from({ length: concurrency }, worker);

  if (opts.rampAtMs != null && opts.rampConcurrency) {
    setTimeout(() => {
      for (let i = 0; i < opts.rampConcurrency!; i++) workers.push(worker());
    }, opts.rampAtMs).unref();
  }

  await new Promise((r) => setTimeout(r, durationMs + 500));
  await Promise.race([Promise.allSettled(workers), new Promise((r) => setTimeout(r, 3000))]);
  clearTimeout(stopTimer);
  return recs.filter((r) => r.ts < deadline).sort((a, b) => a.ts - b.ts);
}
