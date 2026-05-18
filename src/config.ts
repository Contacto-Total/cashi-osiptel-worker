/**
 * Configuración del worker. Lee variables de entorno con defaults razonables.
 * No mantiene secretos en código - todo viene del entorno.
 */

function num(env: string | undefined, fallback: number): number {
  if (!env) return fallback;
  const parsed = Number(env);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(env: string | undefined, fallback: boolean): boolean {
  if (env == null) return fallback;
  return env === 'true' || env === '1';
}

function csv(env: string | undefined): string[] {
  if (!env) return [];
  return env.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

export const config = {
  port: num(process.env.PORT, 8090),
  workerToken: process.env.WORKER_TOKEN ?? '',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  playwright: {
    headless: bool(process.env.PLAYWRIGHT_HEADLESS, true),
    navTimeoutMs: num(process.env.PLAYWRIGHT_NAV_TIMEOUT_MS, 30000),
    perCheckBudgetMs: num(process.env.PLAYWRIGHT_BUDGET_MS, 90000),
  },

  pool: {
    size: num(process.env.WORKER_POOL_SIZE, 3),
    recycleAfter: num(process.env.WORKER_RECYCLE_AFTER, 50),
  },

  circuitBreaker: {
    banThreshold: num(process.env.BAN_THRESHOLD, 5),
    banCooldownMs: num(process.env.BAN_COOLDOWN_MS, 600000),
  },

  proxies: csv(process.env.PROXY_LIST),

  portalUrl: process.env.OSIPTEL_PORTAL_URL ?? 'https://checatuslineas.osiptel.gob.pe/',
};

export type WorkerConfig = typeof config;
