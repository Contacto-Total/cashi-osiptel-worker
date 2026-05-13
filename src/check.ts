/**
 * Orquestación del check Osiptel.
 *
 * Flujo:
 *  1. Si el circuit breaker está abierto, retornar BANNED inmediatamente (sin gastar pool ni captcha).
 *  2. Adquirir un slot del browser pool.
 *  3. Crear una page nueva en el contexto.
 *  4. Delegar al portal-client (navegar + captcha + parsear).
 *  5. Cerrar page. Devolver al pool, reciclando si el resultado fue BANNED.
 *  6. Actualizar el circuit breaker.
 *  7. Aplicar timeout total per-check (config.playwright.perCheckBudgetMs).
 *
 * Privacidad:
 *  - No se loggea DNI ni nombre del titular.
 *  - phone se enmascara en logs.
 */
import { browserPool } from './browser-pool.js';
import { checkPhoneOnPortal } from './portal-client.js';
import type { CheckRequest, CheckResponse } from './schema.js';
import { config } from './config.js';
import { logger, maskPhone } from './logger.js';
import { banGauge } from './metrics.js';

// Circuit breaker simple
class BanCircuitBreaker {
  private consecutiveBans = 0;
  private openUntil = 0;

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

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

  reset(): void {
    this.consecutiveBans = 0;
    this.openUntil = 0;
    banGauge.set(0);
  }
}

const breaker = new BanCircuitBreaker();

export async function runCheck(req: CheckRequest): Promise<CheckResponse> {
  const t0 = Date.now();

  if (breaker.isOpen()) {
    return resp(req, t0, 'BANNED', null, null, 0, 'circuit-breaker-open');
  }

  const slot = await browserPool.acquire();
  let recycleOnRelease = false;
  let page = null;

  try {
    page = await slot.context.newPage();

    // Timeout per-check duro
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('per-check-budget-exceeded')), config.playwright.perCheckBudgetMs)
    );
    const work = checkPhoneOnPortal(page, req.phone, req.dni ?? null);

    const outcome = await Promise.race([work, timeout]);

    // Actualizar circuit breaker
    if (outcome.status === 'BANNED') {
      breaker.recordBan();
      recycleOnRelease = true; // forzar nuevo contexto
    } else if (outcome.status === 'OK' || outcome.status === 'NOT_FOUND') {
      breaker.recordSuccess();
    }
    // CAPTCHA_FAIL y ERROR: no afectan el breaker (no son señal de ban)

    logger.info(
      {
        requestId: req.requestId,
        phone: maskPhone(req.phone),
        status: outcome.status,
        operator: outcome.operator,
        latencyMs: Date.now() - t0,
        captchaAttempts: outcome.captchaAttempts,
      },
      'osiptel check done'
    );

    return resp(
      req,
      t0,
      outcome.status,
      outcome.operator,
      outcome.dniMatch,
      outcome.captchaAttempts,
      outcome.error
    );
  } catch (err) {
    const message = errMsg(err);
    logger.warn({ requestId: req.requestId, phone: maskPhone(req.phone), err: message }, 'osiptel check failed');
    return resp(req, t0, 'ERROR', null, null, 0, message);
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
  operator: CheckResponse['operator'],
  dniMatch: boolean | null,
  captchaAttempts: number,
  error?: string | null
): CheckResponse {
  return {
    requestId: req.requestId,
    phone: req.phone,
    operator,
    dniMatch,
    status,
    error: error ?? null,
    latencyMs: Date.now() - t0,
    captchaAttempts,
    checkedAt: new Date().toISOString(),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
