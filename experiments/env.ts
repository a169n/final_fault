// Builds the .env that docker compose reads: the deployable mode plus the secrets.
// Pure (no I/O) so it is unit-tested; up.ts does the reading and writing.
import { randomBytes } from 'node:crypto';

export type Mode = 'baseline' | 'midterm' | 'endterm' | 'final';

// baseline = no fault tolerance; midterm = the midterm FT system; endterm = midterm + new behaviour;
// final = endterm + automatic DB failover, backups and nested timeouts (the improved configuration)
const MODES: Record<Mode, Record<string, string>> = {
  baseline: { FT_ENABLED: '0', ENDTERM_ENABLED: '0', FINAL_ENABLED: '0', RESTART_POLICY: 'no', NGINX_PROFILE: 'single' },
  midterm: { FT_ENABLED: '1', ENDTERM_ENABLED: '0', FINAL_ENABLED: '0', RESTART_POLICY: 'unless-stopped', NGINX_PROFILE: 'single' },
  endterm: { FT_ENABLED: '1', ENDTERM_ENABLED: '1', FINAL_ENABLED: '0', RESTART_POLICY: 'unless-stopped', NGINX_PROFILE: 'redundant' },
  final: { FT_ENABLED: '1', ENDTERM_ENABLED: '1', FINAL_ENABLED: '1', RESTART_POLICY: 'unless-stopped', NGINX_PROFILE: 'redundant' },
};

export const SECRET_KEYS = [
  'POSTGRES_PASSWORD',
  'APP_DB_PASSWORD',
  'REPL_PASSWORD',
  'MONITOR_DB_PASSWORD',
  'FAILOVER_DB_PASSWORD',
  'BACKUP_DB_PASSWORD',
  'JWT_SECRET',
  'CHAOS_TOKEN',
  'DEMO_PASSWORD',
  'GRAFANA_ADMIN_PASSWORD',
] as const;

export const isMode = (m: string): m is Mode => Object.hasOwn(MODES, m);

// Mode keys always win (switching mode must not keep the old flags);
// secrets already in .env are kept so data volumes keep working; missing ones are generated.
export function buildEnv(mode: Mode, existing: Record<string, string>): Record<string, string> {
  if (!isMode(mode)) throw new Error(`unknown mode: ${mode}`);
  const env: Record<string, string> = { ...existing, ...MODES[mode] };
  for (const k of SECRET_KEYS) {
    if (!env[k]) env[k] = randomBytes(24).toString('base64url'); // 32 chars, no '#', '=', quotes or spaces
  }
  return env;
}

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).replace(/\s+#.*$/, '').trim(); // drop trailing "  # comment"
    env[key] = value;
  }
  return env;
}

export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

// Header for the services' /chaos endpoints. In endterm they answer only to x-chaos-token == CHAOS_TOKEN
// (app/fault_injection.py); baseline and midterm ignore it, so sending it is harmless there.
export function chaosHeaders(env: Record<string, string>): Record<string, string> {
  return env.CHAOS_TOKEN ? { 'x-chaos-token': env.CHAOS_TOKEN } : {};
}
