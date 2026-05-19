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
import { logger } from './logger.js';
import { registry } from './metrics.js';
import { browserPool } from './browser-pool.js';
import { startPoller } from './poller.js';
import { getLastOkAt } from './readiness.js';

const app = Fastify({
  logger: false,  // usamos pino directo desde ./logger.ts
  bodyLimit: 1024 * 64,
});

// ----- Routes -----

app.get('/healthz', async () => {
  return {
    status: 'ok',
    uptimeSec: Math.floor(process.uptime()),
    captchaMode: 'native-grecaptcha-v3',
    poolSize: config.pool.size,
  };
});

app.get('/readyz', async (_req, reply) => {
  const lastOkAt = getLastOkAt();
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  if (lastOkAt && lastOkAt > fiveMinAgo) {
    return { status: 'ready', lastCheckOkAt: new Date(lastOkAt).toISOString() };
  }
  await reply.code(503).send({ status: 'not-ready', reason: 'no recent successful check' });
  return;
});

app.get('/metrics', async (_req, reply) => {
  reply
    .header('Content-Type', registry.contentType)
    .send(await registry.metrics());
});

// ----- Startup -----
const start = async () => {
  try {
    await browserPool.start();
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ port: config.port }, 'cashi-osiptel-worker started');
    startPoller();
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
