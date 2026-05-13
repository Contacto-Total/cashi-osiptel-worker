/**
 * Orquestación del check Osiptel (post-pivot: query por DNI).
 *
 *  1. Circuit breaker (BANNED consecutivos).
 *  2. Acquire BrowserContext del pool.
 *  3. Page.new -> portal-client.checkDocumentOnPortal(dni, dniType).
 *  4. Release el contexto (recycling tras BANNED).
 *  5. Aplicar timeout duro per-check.
 */
import { browserPool } from './browser-pool.js';
import { checkDocumentOnPortal } from './portal-client.js';
import type { CheckRequest, CheckResponse, OsiptelLine } from './schema.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { banGauge } from './metrics.js';

class BanCircuitBreaker {
  private consecutiveBans = 0;
  private openUntil = 0;

  isOpen(): boolean { return Date.now() < this.openUntil; }

  recordBan(): void {
    this.consecutiveBans++;
    banGauge.set(this.consecutiveBans);
    if (this.consecutiveBans >= config.circuitBreaker.banThreshold) {
      this.openUntil = Date.now() + config.circuitBreaker.banCooldownMs;
      logger.warn(
        { until: new Date(this.openUntil).toISOString(), threshold: config.circuitBreaker.banThreshold },
        'circuit-breaker opened due to consecutive bans'
      );
    }
  }

  recordSuccess(): void {
    if (this.consecutiveBans > 0) {
      this.consecutiveBans = 0;
      banGauge.set(0);
    }
    this.openUntil = 0;
  }
}

const breaker = new BanCircuitBreaker();

export async function runCheck(req: CheckRequest): Promise<CheckResponse> {
  const t0 = Date.now();

  if (breaker.isOpen()) {
    return resp(req, t0, 'BANNED', null, 0, 'circuit-breaker-open');
  }

  const slot = await browserPool.acquire();
  let recycleOnRelease = false;
  let page = null;

  try {
    page = await slot.context.newPage();

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('per-check-budget-exceeded')), config.playwright.perCheckBudgetMs)
    );
    const work = checkDocumentOnPortal(page, req.dni, req.dniType);

    const outcome = await Promise.race([work, timeout]);

    if (outcome.status === 'BANNED') {
      breaker.recordBan();
      recycleOnRelease = true;
    } else if (outcome.status === 'OK' || outcome.status === 'NOT_FOUND') {
      breaker.recordSuccess();
    }

    logger.info(
      {
        requestId: req.requestId,
        dniType: req.dniType,
        status: outcome.status,
        linesCount: outcome.lines?.length ?? 0,
        latencyMs: Date.now() - t0,
        captchaAttempts: outcome.captchaAttempts,
      },
      'osiptel check done'
    );

    return resp(req, t0, outcome.status, outcome.lines, outcome.captchaAttempts, outcome.error);
  } catch (err) {
    const message = errMsg(err);
    logger.warn({ requestId: req.requestId, err: message }, 'osiptel check failed');
    return resp(req, t0, 'ERROR', null, 0, message);
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
    await browserPool.release(slot, recycleOnRelease);
  }
}

function resp(
  req: CheckRequest,
  t0: number,
  status: CheckResponse['status'],
  lines: OsiptelLine[] | null,
  captchaAttempts: number,
  error?: string | null
): CheckResponse {
  return {
    requestId: req.requestId,
    dni: req.dni,
    dniType: req.dniType,
    status,
    lines,
    error: error ?? null,
    latencyMs: Date.now() - t0,
    captchaAttempts,
    checkedAt: new Date().toISOString(),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
