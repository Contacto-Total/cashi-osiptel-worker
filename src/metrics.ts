/**
 * Métricas Prometheus expuestas en GET /metrics.
 * Convención: prefijo `osiptel_worker_`.
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const checkCounter = new Counter({
  name: 'osiptel_worker_checks_total',
  help: 'Total de checks ejecutados, por status final',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const checkLatency = new Histogram({
  name: 'osiptel_worker_check_latency_seconds',
  help: 'Latencia de un check completo',
  labelNames: ['status'] as const,
  buckets: [1, 3, 5, 10, 20, 30, 60, 90, 120],
  registers: [registry],
});

export const captchaCounter = new Counter({
  name: 'osiptel_worker_captcha_total',
  help: 'Outcomes de la generacion de token reCAPTCHA v3 nativo (solved|failed)',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const banGauge = new Gauge({
  name: 'osiptel_worker_recent_bans',
  help: 'Conteo de bans consecutivos (resetea al primer éxito)',
  registers: [registry],
});

export const poolGauge = new Gauge({
  name: 'osiptel_worker_pool_available',
  help: 'Contextos Playwright disponibles en el pool',
  registers: [registry],
});
