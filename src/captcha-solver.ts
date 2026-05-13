/**
 * Cliente 2Captcha.
 *
 * Maneja los dos tipos más comunes que se encuentran en portales gubernamentales PE:
 *  - reCAPTCHA v2 (siteKey + pageUrl)
 *  - hCaptcha (siteKey + pageUrl)
 *
 * NOTA: el tipo real de captcha del portal Osiptel se confirma con inspección manual.
 * Este módulo expone ambos solvers; el portal-client elige.
 *
 * Manejo de errores:
 *  - Si la API key no está configurada, retorna CaptchaError con detail='no-api-key'.
 *  - Timeouts y errores se propagan como excepciones - el caller decide reintento.
 */
import { Solver } from '2captcha-ts';
import { config } from './config.js';
import { logger } from './logger.js';
import { captchaCounter } from './metrics.js';

export class CaptchaError extends Error {
  constructor(public readonly detail: string, message?: string) {
    super(message ?? detail);
    this.name = 'CaptchaError';
  }
}

class CaptchaSolver {
  private solver: Solver | null = null;

  private getSolver(): Solver {
    if (!this.solver) {
      if (!config.twoCaptcha.apiKey) {
        throw new CaptchaError('no-api-key', '2Captcha API key no configurada');
      }
      this.solver = new Solver(config.twoCaptcha.apiKey);
    }
    return this.solver;
  }

  /**
   * Resuelve un reCAPTCHA v2. Devuelve el token g-recaptcha-response listo para inyectar.
   */
  async solveRecaptchaV2(siteKey: string, pageUrl: string): Promise<string> {
    const t0 = Date.now();
    try {
      const res = await this.getSolver().recaptcha({
        googlekey: siteKey,
        pageurl: pageUrl,
      });
      logger.info({ ms: Date.now() - t0, type: 'recaptchaV2' }, 'captcha solved');
      captchaCounter.inc({ result: 'solved' });
      return res.data;
    } catch (err) {
      captchaCounter.inc({ result: 'failed' });
      throw new CaptchaError('solver-failed', errMsg(err));
    }
  }

  /**
   * Resuelve hCaptcha. Devuelve el token h-captcha-response.
   */
  async solveHcaptcha(siteKey: string, pageUrl: string): Promise<string> {
    const t0 = Date.now();
    try {
      const res = await this.getSolver().hcaptcha({
        sitekey: siteKey,
        pageurl: pageUrl,
      });
      logger.info({ ms: Date.now() - t0, type: 'hcaptcha' }, 'captcha solved');
      captchaCounter.inc({ result: 'solved' });
      return res.data;
    } catch (err) {
      captchaCounter.inc({ result: 'failed' });
      throw new CaptchaError('solver-failed', errMsg(err));
    }
  }

  /**
   * Consulta balance de saldo. Si <0.5 USD aprox, /readyz puede degradar.
   */
  async getBalance(): Promise<number | null> {
    try {
      const balance = await this.getSolver().balance();
      return Number(balance);
    } catch (err) {
      logger.warn({ err: errMsg(err) }, 'failed to fetch 2captcha balance');
      return null;
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const captchaSolver = new CaptchaSolver();
