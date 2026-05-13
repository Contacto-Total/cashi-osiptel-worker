/**
 * Cliente del portal Osiptel.
 *
 * IMPORTANTE - SELECTORES POR CONFIRMAR:
 *  Los selectores CSS de abajo están marcados con `// SELECTOR:` y deben validarse
 *  contra la versión actual del portal antes de salir a producción.
 *  El parser está diseñado para que un cambio de selector se detecte rápido
 *  (la función parsePortalResponse retorna 'PARSER_BROKEN' explícito).
 *
 * Flujo por check:
 *  1. Navegar a portal.
 *  2. Detectar tipo de captcha (recaptcha v2 / hcaptcha) y siteKey.
 *  3. Enviar a 2Captcha y esperar token.
 *  4. Inyectar token en el form.
 *  5. Ingresar phone, submit.
 *  6. Esperar resultado (selector configurable).
 *  7. Parsear titular y operador. Calcular dniMatch.
 *  8. DESCARTAR nombre del titular del retorno.
 *
 * Detección de ban:
 *  - URL del portal contiene "captcha-blocked" o similar.
 *  - HTML contiene heurística de "demasiados intentos".
 *  - Status HTTP 403/429 en alguna navegación.
 */
import type { BrowserContext, Page } from 'playwright';
import { config } from './config.js';
import { logger, maskPhone } from './logger.js';
import { captchaSolver, CaptchaError } from './captcha-solver.js';
import type { CheckResponse } from './schema.js';

// ============================
// Selectores - REVISAR contra portal vivo antes de prod
// ============================
const SEL = {
  phoneInput: '#numero_telefono',                    // SELECTOR: input de número
  submitButton: 'button[type="submit"]',             // SELECTOR: botón enviar
  recaptchaIframe: 'iframe[src*="recaptcha"]',       // SELECTOR: detectar recaptcha
  hcaptchaIframe: 'iframe[src*="hcaptcha"]',         // SELECTOR: detectar hcaptcha
  recaptchaResponse: '#g-recaptcha-response',        // SELECTOR: textarea oculto
  hcaptchaResponse: '[name="h-captcha-response"]',   // SELECTOR: textarea oculto
  resultContainer: '#resultado, .resultado, [data-result]',  // SELECTOR: contenedor de respuesta
  operatorField: '[data-field="operador"], .operador',       // SELECTOR: operador
  titularField: '[data-field="titular"], .titular',          // SELECTOR: nombre titular (NO se persiste)
  dniField: '[data-field="dni"], .dni',                      // SELECTOR: DNI titular
  notFoundIndicator: '.no-encontrado, [data-result="not-found"]',
  banIndicator: '.captcha-blocked, .acceso-bloqueado',
};

export interface PortalCheckOutcome {
  status: 'OK' | 'NOT_FOUND' | 'CAPTCHA_FAIL' | 'BANNED' | 'ERROR';
  operator: CheckResponse['operator'];
  dniMatch: boolean | null;
  captchaAttempts: number;
  error?: string;
}

/**
 * Ejecuta un check en una página específica (que vive en un BrowserContext del pool).
 */
export async function checkPhoneOnPortal(
  page: Page,
  phone: string,
  dni: string | null | undefined
): Promise<PortalCheckOutcome> {
  let captchaAttempts = 0;
  const navTimeout = config.playwright.navTimeoutMs;
  page.setDefaultTimeout(navTimeout);

  try {
    await page.goto(config.portalUrl, { waitUntil: 'domcontentloaded' });

    // Detección temprana de ban
    if (await isBanned(page)) {
      return { status: 'BANNED', operator: null, dniMatch: null, captchaAttempts, error: 'banned-on-load' };
    }

    // Resolver captcha (máx 3 intentos)
    let captchaInjected = false;
    for (let attempt = 1; attempt <= 3 && !captchaInjected; attempt++) {
      captchaAttempts = attempt;
      try {
        await injectCaptchaToken(page);
        captchaInjected = true;
      } catch (err) {
        if (err instanceof CaptchaError && err.detail === 'no-api-key') {
          return { status: 'ERROR', operator: null, dniMatch: null, captchaAttempts, error: 'no-captcha-api-key' };
        }
        logger.warn({ attempt, err: errMsg(err) }, 'captcha attempt failed');
        if (attempt === 3) {
          return { status: 'CAPTCHA_FAIL', operator: null, dniMatch: null, captchaAttempts, error: errMsg(err) };
        }
      }
    }

    // Submit
    await page.fill(SEL.phoneInput, phone);
    await page.click(SEL.submitButton);

    // Esperar respuesta o indicador de ban
    await Promise.race([
      page.waitForSelector(SEL.resultContainer, { timeout: navTimeout }),
      page.waitForSelector(SEL.notFoundIndicator, { timeout: navTimeout }),
      page.waitForSelector(SEL.banIndicator, { timeout: navTimeout }),
    ]).catch(() => null);

    if (await isBanned(page)) {
      return { status: 'BANNED', operator: null, dniMatch: null, captchaAttempts, error: 'banned-after-submit' };
    }

    if (await isNotFound(page)) {
      return { status: 'NOT_FOUND', operator: null, dniMatch: null, captchaAttempts };
    }

    // Parsear resultado
    const parsed = await parsePortalResponse(page, dni);
    return { ...parsed, captchaAttempts };
  } catch (err) {
    logger.warn({ phone: maskPhone(phone), err: errMsg(err) }, 'portal check unexpected error');
    return { status: 'ERROR', operator: null, dniMatch: null, captchaAttempts, error: errMsg(err) };
  }
}

async function injectCaptchaToken(page: Page): Promise<void> {
  const hasRecaptcha = await page.locator(SEL.recaptchaIframe).count() > 0;
  const hasHcaptcha = await page.locator(SEL.hcaptchaIframe).count() > 0;

  if (!hasRecaptcha && !hasHcaptcha) {
    return; // No captcha en esta página
  }

  let siteKey: string | null = null;
  let solverFn: (sk: string, url: string) => Promise<string>;
  let responseSelector: string;

  if (hasRecaptcha) {
    siteKey = await readSiteKey(page, 'data-sitekey', '.g-recaptcha');
    solverFn = captchaSolver.solveRecaptchaV2.bind(captchaSolver);
    responseSelector = SEL.recaptchaResponse;
  } else {
    siteKey = await readSiteKey(page, 'data-sitekey', '.h-captcha');
    solverFn = captchaSolver.solveHcaptcha.bind(captchaSolver);
    responseSelector = SEL.hcaptchaResponse;
  }

  if (!siteKey) {
    throw new CaptchaError('site-key-not-found');
  }

  const token = await solverFn(siteKey, page.url());

  // Inyectar el token en el textarea oculto
  await page.evaluate(
    ({ selector, token }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement | null;
      if (el) {
        el.style.display = 'block';
        el.value = token;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    { selector: responseSelector, token }
  );
}

async function readSiteKey(page: Page, attr: string, fallbackSelector: string): Promise<string | null> {
  // 1. Atributo data-sitekey en cualquier elemento
  const elements = page.locator(`[${attr}]`);
  if (await elements.count() > 0) {
    return elements.first().getAttribute(attr);
  }
  // 2. Fallback a contenedor conocido
  const fb = page.locator(fallbackSelector);
  if (await fb.count() > 0) {
    return fb.first().getAttribute(attr);
  }
  return null;
}

async function isBanned(page: Page): Promise<boolean> {
  if (await page.locator(SEL.banIndicator).count() > 0) return true;
  const url = page.url();
  return /captcha-blocked|acceso-bloqueado|forbidden/i.test(url);
}

async function isNotFound(page: Page): Promise<boolean> {
  return (await page.locator(SEL.notFoundIndicator).count()) > 0;
}

async function parsePortalResponse(page: Page, dni: string | null | undefined): Promise<Omit<PortalCheckOutcome, 'captchaAttempts'>> {
  // Operador
  const operatorRaw = (await safeText(page, SEL.operatorField)) ?? '';
  const operator = normalizeOperator(operatorRaw);

  // dni_match - solo si el caller proporcionó dni
  let dniMatch: boolean | null = null;
  if (dni && dni.trim().length > 0) {
    const portalDni = (await safeText(page, SEL.dniField)) ?? '';
    const cleanedPortal = portalDni.replace(/\D/g, '');
    const cleanedInput = dni.replace(/\D/g, '');
    if (cleanedPortal.length > 0) {
      dniMatch = cleanedPortal === cleanedInput;
    }
  }

  // Validar que parseo encontró algo (defensa contra cambio de HTML)
  const titularPresent = ((await safeText(page, SEL.titularField)) ?? '').trim().length > 0;
  if (!operator && !titularPresent) {
    return { status: 'ERROR', operator: null, dniMatch: null, error: 'PARSER_BROKEN' };
  }

  // El nombre del titular NUNCA se retorna. Aquí termina su scope.
  return { status: 'OK', operator, dniMatch };
}

async function safeText(page: Page, selector: string): Promise<string | null> {
  try {
    const loc = page.locator(selector);
    if (await loc.count() === 0) return null;
    return (await loc.first().innerText()).trim();
  } catch {
    return null;
  }
}

function normalizeOperator(raw: string): CheckResponse['operator'] {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  if (upper.includes('CLARO')) return 'CLARO';
  if (upper.includes('MOVISTAR')) return 'MOVISTAR';
  if (upper.includes('ENTEL')) return 'ENTEL';
  if (upper.includes('BITEL')) return 'BITEL';
  return 'OTRO';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
