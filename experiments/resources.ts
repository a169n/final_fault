// Resource capture: `docker stats --no-stream` every 2 s while an experiment runs, limited to this
// compose project's containers. Parsing and the per-container summary are pure so they are tested.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sleepUnless } from './alerts.ts';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE_MS = 2_000;

export type ResSample = { ts: number; name: string; cpuPct: number; memMiB: number };
export type ResSummary = { name: string; maxCpuPct: number; maxMemMiB: number; samples: number };

const UNIT_MIB: Record<string, number> = {
  B: 1 / 1024 ** 2, KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1024 ** 2,
  kB: 1e3 / 1024 ** 2, KB: 1e3 / 1024 ** 2, MB: 1e6 / 1024 ** 2, GB: 1e9 / 1024 ** 2, TB: 1e12 / 1024 ** 2,
};

function toMiB(text: string): number | null {
  const m = /^\s*([\d.]+)\s*([A-Za-z]+)\s*$/.exec(text);
  if (!m || !(m[2] in UNIT_MIB)) return null;
  return Number(m[1]) * UNIT_MIB[m[2]];
}

// One line of `docker stats --format '{{json .}}'` -> a sample, or null if it cannot be read.
export function parseStatsLine(line: string, ts: number): ResSample | null {
  let row: { Name?: string; CPUPerc?: string; MemUsage?: string };
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  const cpuPct = Number.parseFloat(String(row.CPUPerc ?? '').replace('%', ''));
  const memMiB = toMiB(String(row.MemUsage ?? '').split('/')[0]);
  if (!row.Name || !Number.isFinite(cpuPct) || memMiB == null) return null;
  return { ts, name: row.Name, cpuPct, memMiB };
}

export function summarizeResources(samples: ResSample[]): ResSummary[] {
  const by = new Map<string, ResSummary>();
  for (const s of samples) {
    const cur = by.get(s.name) ?? { name: s.name, maxCpuPct: 0, maxMemMiB: 0, samples: 0 };
    cur.maxCpuPct = Math.max(cur.maxCpuPct, s.cpuPct);
    cur.maxMemMiB = Math.max(cur.maxMemMiB, s.memMiB);
    cur.samples++;
    by.set(s.name, cur);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Every container of this compose project, running or not (so one that dies mid-run is still matched).
async function projectContainers(): Promise<Set<string>> {
  const { stdout } = await exec('docker', ['compose', 'ps', '-a', '--format', '{{.Name}}'], { cwd: ROOT });
  return new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
}

// Samples until `signal` aborts. A failed `docker stats` call is skipped, never fatal to the run.
export async function sampleResources(signal: AbortSignal): Promise<ResSample[]> {
  const out: ResSample[] = [];
  const names = await projectContainers().catch(() => new Set<string>());
  while (!signal.aborted) {
    const started = Date.now();
    try {
      const { stdout } = await exec('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 10_000 });
      for (const line of stdout.split('\n')) {
        const s = line.trim() ? parseStatsLine(line, started) : null;
        if (s && (names.size === 0 || names.has(s.name))) out.push(s);
      }
    } catch {
      // docker stats can fail while a container is being killed; the next sample covers it
    }
    await sleepUnless(Math.max(0, SAMPLE_MS - (Date.now() - started)), signal);
  }
  return out;
}

// ---- container identity, for "no instance went down or was restarted" (E10) ----
// A container restarted by its restart policy (unless-stopped) is back up by the time anything checks
// /health, so a later health probe cannot tell. Its RestartCount or StartedAt can: snapshot both before
// the fault and again after, and diff.

export type ContainerState = { name: string; restartCount: number; startedAt: string; running: boolean };

export const INSPECT_FORMAT = '{{.Name}} {{.RestartCount}} {{.State.StartedAt}} {{.State.Running}}';

// `docker inspect -f INSPECT_FORMAT` output -> one state per line; unreadable lines are dropped.
export function parseInspect(stdout: string): ContainerState[] {
  const out: ContainerState[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [name, rc, startedAt, running] = parts;
    const restartCount = Number(rc);
    if (!name || !Number.isInteger(restartCount) || !startedAt || (running !== 'true' && running !== 'false')) continue;
    out.push({ name: name.replace(/^\//, ''), restartCount, startedAt, running: running === 'true' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The containers that restarted, stopped or disappeared between two snapshots (sorted). A container
// that was not running before (e.g. a finished one-shot job) only counts if it was started since.
export function restartedBetween(before: ContainerState[], after: ContainerState[]): string[] {
  const now = new Map(after.map((c) => [c.name, c]));
  const changed: string[] = [];
  for (const b of before) {
    const a = now.get(b.name);
    if (!a) {
      changed.push(b.name);
      continue;
    }
    if (a.restartCount !== b.restartCount || a.startedAt !== b.startedAt || (b.running && !a.running)) changed.push(b.name);
  }
  return changed.sort();
}

// Every container of this compose project, as `docker inspect` sees it now; null if docker cannot be
// asked (missing evidence, so the criterion that reads it fails).
export async function snapshotContainers(): Promise<ContainerState[] | null> {
  try {
    const { stdout: ids } = await exec('docker', ['compose', 'ps', '-a', '-q'], { cwd: ROOT, timeout: 10_000 });
    const list = ids.split('\n').map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) return null;
    const { stdout } = await exec('docker', ['inspect', '-f', INSPECT_FORMAT, ...list], { timeout: 10_000 });
    const states = parseInspect(stdout);
    return states.length > 0 ? states : null;
  } catch {
    return null;
  }
}
