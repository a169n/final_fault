// Saves a PNG of the Grafana "university" dashboard over one run's time window, for the report figures.
// Reads t0/t1 from reports/endterm/runs/<tag>/metrics.json and writes reports/endterm/figures/<tag>.png
// (1600x1000 viewport at deviceScaleFactor 2). Needs the stack (Grafana on :3000) still holding that
// window in Prometheus, so run it after the campaign of that mode and before `docker compose down -v`.
// Usage: node --experimental-strip-types experiments/snapshot.ts <scenario>__<mode>__r<N> [<tag> ...]
//          [--grafana http://localhost:3000] [--pad-ms 0] [--out reports/endterm/figures] [--full]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DASHBOARD_UID = 'university';
export const VIEWPORT = { width: 1600, height: 1000 };
export const SCALE = 2;
// The 1600x1000 shot shows the top three dashboard rows (traffic, latency, upstreams, health,
// ejection). --full also saves <tag>-full.png from a viewport tall enough for all 47 grid rows
// (30 px + 8 px margin each in kiosk mode), so circuit breakers, auth denials, the database and the
// alert timeline are in the figure too.
export const FULL_HEIGHT = 2000;

export function captureSpec(tag: string, full: boolean): { file: string; viewport: { width: number; height: number } } {
  return full
    ? { file: `${tag}-full.png`, viewport: { width: VIEWPORT.width, height: FULL_HEIGHT } }
    : { file: `${tag}.png`, viewport: VIEWPORT };
}

// kiosk hides Grafana's menus for the PNG; the live demo (demo.ts) links without it, so the time
// picker stays usable.
export function dashboardUrl(grafana: string, from: number, to: number, kiosk = true): string {
  return `${grafana.replace(/\/+$/, '')}/d/${DASHBOARD_UID}?from=${from}&to=${to}${kiosk ? '&kiosk' : ''}`;
}

export function timeWindow(run: { t0: number; t1: number }, padMs: number): { from: number; to: number } {
  return { from: run.t0 - padMs, to: run.t1 + padMs };
}

// The run directory name; also used as the PNG name, so only this exact shape is accepted.
export function parseTag(tag: string): { scenario: string; mode: string; rep: number } | null {
  const m = /^([a-z0-9]+(?:-[a-z0-9]+)*)__([a-z]+)__r(\d+)$/.exec(tag);
  return m ? { scenario: m[1], mode: m[2], rep: Number(m[3]) } : null;
}

// Playwright is installed globally (not a repo dependency): try the local resolution first, then the
// global node_modules.
function loadPlaywright(): any {
  const req = createRequire(import.meta.url);
  try {
    return req('playwright');
  } catch {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return req(join(root, 'playwright'));
  }
}

function args(argv: string[]) {
  const opts: Record<string, string> = {};
  const tags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--full') opts.full = '1';
    else if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i];
    else tags.push(argv[i]);
  }
  return { opts, tags };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const { opts, tags } = args(process.argv.slice(2));
  const grafana = opts.grafana ?? 'http://localhost:3000';
  const padMs = Number(opts['pad-ms'] ?? 0);
  const outDir = resolve(opts.out ?? join(ROOT, 'reports/endterm/figures'));
  const bad = tags.filter((t) => !parseTag(t));
  if (tags.length === 0 || bad.length || !Number.isFinite(padMs) || padMs < 0) {
    console.log('usage: node --experimental-strip-types experiments/snapshot.ts <scenario>__<mode>__r<N> [...] ' +
      '[--grafana URL] [--pad-ms N] [--out DIR] [--full]');
    if (bad.length) console.log(`not a run tag: ${bad.join(', ')}`);
    process.exit(1);
  }

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  let failed = 0;
  try {
    const shots = opts.full ? [false, true] : [false];
    mkdirSync(outDir, { recursive: true });
    for (const tag of tags) {
      const file = join(ROOT, 'reports/endterm/runs', tag, 'metrics.json');
      if (!existsSync(file)) {
        console.log(`!! ${tag}: no ${file}`);
        failed++;
        continue;
      }
      const run = JSON.parse(readFileSync(file, 'utf8')) as { t0: number; t1: number };
      const { from, to } = timeWindow(run, padMs);
      const url = dashboardUrl(grafana, from, to);
      for (const full of shots) {
        const spec = captureSpec(tag, full);
        const context = await browser.newContext({ viewport: spec.viewport, deviceScaleFactor: SCALE });
        try {
          const page = await context.newPage();
          await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
          // panels render after their queries return; give the last ones a moment after the network is idle
          await page.waitForTimeout(2_000);
          const png = join(outDir, spec.file);
          await page.screenshot({ path: png });
          console.log(`${tag}: ${url} -> ${png}`);
        } catch (e) {
          console.log(`!! ${tag}: ${(e as Error).message.split('\n')[0]}`);
          failed++;
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
}
