/**
 * Worker Node.js: HTTP server con Fastify.
 *
 * Endpoints:
 *  POST /check       - valida 1 número (síncrono, ≤90s)
 *  GET  /healthz     - liveness
 *  GET  /readyz      - readiness (último check exitoso reciente)
 *  GET  /metrics     - Prometheus exposition
 *
 * Auth: header X-Worker-Token (shared secret con el backend Java).
 */
import Fastify from 'fastify';
import { config } from './config.js';
import { logger, maskPhone } from './logger.js';
import { CheckRequestSchema } from './schema.js';
import { runCheck } from './check.js';
import { registry, checkCounter, checkLatency } from './metrics.js';
import { browserPool } from './browser-pool.js';
import { captchaSolver } from './captcha-solver.js';

const app = Fastify({
  logger: false,  // usamos pino directo desde ./logger.ts
  bodyLimit: 1024 * 64,
});

// State para readiness
let lastCheckOkAt: number | null = null;

// ----- Auth middleware -----
app.addHook('preHandler', async (request, reply) => {
  const url = request.url ?? '';
  const isPublic = url.startsWith('/healthz') || url.startsWith('/readyz') || url.startsWith('/metrics');
  if (isPublic) return;

  if (!config.workerToken) {
    return; // dev mode sin token
  }
  const headerToken = request.headers['x-worker-token'];
  if (headerToken !== config.workerToken) {
    await reply.code(401).send({ error: 'invalid-worker-token' });
    return;
  }
});

// ----- Routes -----

app.get('/healthz', async () => {
  const balance = config.twoCaptcha.apiKey ? await captchaSolver.getBalance() : null;
  return {
    status: 'ok',
    uptimeSec: Math.floor(process.uptime()),
    twoCaptchaConfigured: Boolean(config.twoCaptcha.apiKey),
    twoCaptchaBalanceUsd: balance,
    poolSize: config.pool.size,
  };
});

app.get('/readyz', async (_req, reply) => {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  if (lastCheckOkAt && lastCheckOkAt > fiveMinAgo) {
    return { status: 'ready', lastCheckOkAt: new Date(lastCheckOkAt).toISOString() };
  }
  reply.code(503).send({ status: 'not-ready', reason: 'no recent successful check' });
});

app.get('/metrics', async (_req, reply) => {
  reply
    .header('Content-Type', registry.contentType)
    .send(await registry.metrics());
});

app.post('/check', async (request, reply) => {
  const parsed = CheckRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'invalid-request',
      details: parsed.error.flatten(),
    });
  }
  const req = parsed.data;
  const end = checkLatency.startTimer({ status: 'pending' });
  try {
    const result = await runCheck(req);
    end({ status: result.status });
    checkCounter.inc({ status: result.status });
    if (result.status === 'OK' || result.status === 'NOT_FOUND') {
      lastCheckOkAt = Date.now();
    }
    return result;
  } catch (err: unknown) {
    end({ status: 'ERROR' });
    checkCounter.inc({ status: 'ERROR' });
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ requestId: req.requestId, phone: maskPhone(req.phone), err: message }, 'osiptel check crashed');
    return reply.code(500).send({
      requestId: req.requestId,
      phone: req.phone,
      status: 'ERROR',
      error: message,
      latencyMs: 0,
      captchaAttempts: 0,
      checkedAt: new Date().toISOString(),
    });
  }
});

// ----- Startup -----
const start = async () => {
  try {
    await browserPool.start();
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ port: config.port }, 'cashi-osiptel-worker started');
  } catch (err) {
    logger.error({ err }, 'failed to start worker');
    process.exit(1);
  }
};

// graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
    await browserPool.stop();
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
  }
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start();
