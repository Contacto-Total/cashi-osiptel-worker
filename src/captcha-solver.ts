/**
 * Cliente 2Captcha. El portal Osiptel usa reCAPTCHA v3 (invisible).
 *
 * v3 requiere: pageurl + googlekey + action + min_score.
 * El token resultante se inyecta en el campo oculto del form.
 *
 * También se mantiene el método v2 por si alguna otra integración lo necesita.
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
   * Resuelve reCAPTCHA v3 (invisible). Es el modo que usa Osiptel.
   *
   * @param sitekey sitekey publico del site
   * @param pageurl URL exacta donde corre el captcha
   * @param action action declarada en el grecaptcha.execute(sitekey, { action })
   * @param minScore score mínimo aceptado (0.3 por default es lo más usado)
   */
  async solveRecaptchaV3(sitekey: string, pageurl: string, action: string, minScore = 0.3): Promise<string> {
    const t0 = Date.now();
    try {
      const res = await this.getSolver().recaptcha({
        pageurl,
        googlekey: sitekey,
        version: 'v3',
        action,
        min_score: minScore,
      });
      logger.info({ ms: Date.now() - t0, type: 'recaptchaV3', action }, 'captcha solved');
      captchaCounter.inc({ result: 'solved' });
      return res.data;
    } catch (err) {
      captchaCounter.inc({ result: 'failed' });
      throw new CaptchaError('solver-failed', errMsg(err));
    }
  }

  /** reCAPTCHA v2 (checkbox). Se mantiene por compatibilidad futura. */
  async solveRecaptchaV2(sitekey: string, pageurl: string): Promise<string> {
    const t0 = Date.now();
    try {
      const res = await this.getSolver().recaptcha({
        googlekey: sitekey,
        pageurl,
      });
      logger.info({ ms: Date.now() - t0, type: 'recaptchaV2' }, 'captcha solved');
      captchaCounter.inc({ result: 'solved' });
      return res.data;
    } catch (err) {
      captchaCounter.inc({ result: 'failed' });
      throw new CaptchaError('solver-failed', errMsg(err));
    }
  }

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
