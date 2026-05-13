/**
 * Cliente del portal Osiptel - https://checatuslineas.osiptel.gob.pe/
 *
 * Selectores REALES extraídos del DOM del portal (2026-05-13).
 *
 * Flujo:
 *  1. Navegar al portal.
 *  2. Seleccionar tipo de documento en #IdTipoDoc.
 *  3. Llenar #NumeroDocumento.
 *  4. Resolver reCAPTCHA v3 (sitekey desde script captcha + action desde #hiddenAction).
 *  5. Inyectar token en #GoogleCaptchaToken.
 *  6. Click en #btnBuscar (submit del form).
 *  7. Esperar a que #GridConsulta tenga filas.
 *  8. Parsear filas: Modalidad | Número Telefónico | Empresa Operadora.
 *  9. El número viene parcialmente enmascarado: "97851****" (5 visibles + 4 con '*').
 */
import type { Page } from 'playwright';
import { config } from './config.js';
import { logger, maskPhone } from './logger.js';
import { captchaSolver, CaptchaError } from './captcha-solver.js';
import type { DocumentType, OperatorCode, OsiptelLine } from './schema.js';

// ============================
// Selectores confirmados contra el portal real
// ============================
const SEL = {
  docTypeSelect: '#IdTipoDoc',
  docNumberInput: '#NumeroDocumento',
  submitButton: '#btnBuscar',

  captchaTokenHidden: '#GoogleCaptchaToken',
  captchaActionHidden: '#hiddenAction',
  captchaSitekeyHidden: '#hiddenRecaptchaKey',

  resultLabel: '#strResultado',
  resultTable: '#GridConsulta',
  resultTableBody: '#GridConsulta tbody',
  resultTableRows: '#GridConsulta tbody tr',
  // El portal muestra el bloque ctrlistado siempre que hay respuesta (con o sin lineas)
  resultBlock: '#strResult',

  // Heuristicas de banear / no encontrado
  banIndicator: '.captcha-blocked, .acceso-bloqueado, .alert-danger',
};

// Mapa de valores del select #IdTipoDoc. Confirmar contra el HTML real del portal:
//  - El option de DNI suele tener value="1" o "DNI"; ajustar si difiere.
const DOC_TYPE_VALUE: Record<DocumentType, string> = {
  DNI: '1',
  CE: '2',
  PASAPORTE: '3',
  RUC: '4',
};

export interface PortalCheckOutcome {
  status: 'OK' | 'NOT_FOUND' | 'CAPTCHA_FAIL' | 'BANNED' | 'ERROR';
  lines: OsiptelLine[] | null;
  captchaAttempts: number;
  error?: string;
}

export async function checkDocumentOnPortal(
  page: Page,
  dni: string,
  dniType: DocumentType
): Promise<PortalCheckOutcome> {
  let captchaAttempts = 0;
  const navTimeout = config.playwright.navTimeoutMs;
  page.setDefaultTimeout(navTimeout);

  try {
    await page.goto(config.portalUrl, { waitUntil: 'domcontentloaded' });

    if (await isBanned(page)) {
      return { status: 'BANNED', lines: null, captchaAttempts, error: 'banned-on-load' };
    }

    // 1. Tipo de documento + número
    await page.selectOption(SEL.docTypeSelect, { value: DOC_TYPE_VALUE[dniType] });
    await page.fill(SEL.docNumberInput, dni);

    // 2. Resolver reCAPTCHA v3 con hasta 3 intentos
    let captchaInjected = false;
    for (let attempt = 1; attempt <= 3 && !captchaInjected; attempt++) {
      captchaAttempts = attempt;
      try {
        await injectRecaptchaV3Token(page);
        captchaInjected = true;
      } catch (err) {
        if (err instanceof CaptchaError && err.detail === 'no-api-key') {
          return { status: 'ERROR', lines: null, captchaAttempts, error: 'no-captcha-api-key' };
        }
        logger.warn({ attempt, err: errMsg(err) }, 'captcha attempt failed');
        if (attempt === 3) {
          return { status: 'CAPTCHA_FAIL', lines: null, captchaAttempts, error: errMsg(err) };
        }
      }
    }

    // 3. Submit
    await page.click(SEL.submitButton);

    // 4. Esperar a la respuesta (tabla con filas o mensaje de error/no encontrado)
    try {
      await page.waitForFunction(
        () => {
          const tableVisible = document.querySelector('#GridConsulta tbody tr') !== null;
          const banVisible = document.querySelector('.captcha-blocked, .acceso-bloqueado, .alert-danger') !== null;
          const noResults = document.querySelector('#GridConsulta_wrapper .dataTables_empty') !== null;
          return tableVisible || banVisible || noResults;
        },
        { timeout: navTimeout }
      );
    } catch {
      // Timeout: el portal no respondio en el tiempo esperado
      return { status: 'ERROR', lines: null, captchaAttempts, error: 'response-timeout' };
    }

    if (await isBanned(page)) {
      return { status: 'BANNED', lines: null, captchaAttempts, error: 'banned-after-submit' };
    }

    // 5. Parsear resultado
    const lines = await parseGridConsulta(page);
    if (lines === null) {
      return { status: 'ERROR', lines: null, captchaAttempts, error: 'PARSER_BROKEN' };
    }
    if (lines.length === 0) {
      return { status: 'NOT_FOUND', lines: [], captchaAttempts };
    }
    return { status: 'OK', lines, captchaAttempts };
  } catch (err) {
    logger.warn({ doc: maskPhone(dni), err: errMsg(err) }, 'portal check unexpected error');
    return { status: 'ERROR', lines: null, captchaAttempts, error: errMsg(err) };
  }
}

// ============================
// Helpers
// ============================

async function injectRecaptchaV3Token(page: Page): Promise<void> {
  // Leer sitekey y action desde hidden inputs / scripts de la pagina
  const meta = await page.evaluate(({ keyId, actionId }) => {
    const keyEl = document.getElementById(keyId) as HTMLInputElement | null;
    const actionEl = document.getElementById(actionId) as HTMLInputElement | null;
    let sitekey: string | null = keyEl?.value ?? null;

    // Fallback: extraer sitekey del src del script de google
    if (!sitekey) {
      const script = Array.from(document.querySelectorAll('script[src]'))
        .map(s => (s as HTMLScriptElement).src)
        .find(s => s.includes('recaptcha/api.js?render='));
      if (script) {
        const m = script.match(/render=([^&]+)/);
        if (m) sitekey = m[1];
      }
    }

    const action = actionEl?.value ?? 'submit';
    const pageUrl = location.href;
    return { sitekey, action, pageUrl };
  }, { keyId: SEL.captchaSitekeyHidden.slice(1), actionId: SEL.captchaActionHidden.slice(1) });

  if (!meta.sitekey) {
    throw new CaptchaError('site-key-not-found');
  }

  const token = await captchaSolver.solveRecaptchaV3(meta.sitekey, meta.pageUrl, meta.action);

  // Inyectar token en el hidden
  await page.evaluate(
    ({ selector, token }) => {
      const el = document.querySelector(selector) as HTMLInputElement | null;
      if (el) {
        el.value = token;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    { selector: SEL.captchaTokenHidden, token }
  );
}

async function parseGridConsulta(page: Page): Promise<OsiptelLine[] | null> {
  try {
    const rows = await page.$$eval(SEL.resultTableRows, (trs) => {
      return trs.map(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.textContent ?? '').trim());
        return cells;
      });
    });

    // Tabla con cabecera "Modalidad | Número | Empresa", filas con esos 3 campos.
    // dataTables a veces inserta una fila vacía "No se encontraron datos" en tbody.
    const parsed: OsiptelLine[] = [];
    for (const cells of rows) {
      if (cells.length < 3) continue;
      const modality = cells[0] || null;
      const phoneRaw = cells[1] || '';
      const operatorRaw = cells[2] || '';

      // Mensaje vacío típico de dataTables ("No se encontraron registros...") cae aquí
      if (!/\d/.test(phoneRaw)) continue;

      // Extraer prefijo visible (eliminar caracteres no numericos como '*' o espacios)
      const visibleDigits = phoneRaw.replace(/[^0-9]/g, '');
      if (visibleDigits.length === 0) continue;
      const phonePrefix = visibleDigits.slice(0, 5);

      parsed.push({
        phonePrefix,
        operator: normalizeOperator(operatorRaw),
        modality: modality || null,
      });
    }

    return parsed;
  } catch (err) {
    logger.warn({ err: errMsg(err) }, 'parser failed reading GridConsulta');
    return null;
  }
}

async function isBanned(page: Page): Promise<boolean> {
  if (await page.locator(SEL.banIndicator).count() > 0) {
    const text = (await page.locator(SEL.banIndicator).first().innerText().catch(() => '')) ?? '';
    // El portal a veces muestra alert-danger por validación, no por ban; filtramos
    if (/bloque|prohibi|forbid|too many|límite|abuso/i.test(text)) return true;
  }
  const url = page.url();
  return /captcha-blocked|acceso-bloqueado|forbidden|429/i.test(url);
}

function normalizeOperator(raw: string): OperatorCode {
  if (!raw) return 'OTRO';
  const upper = raw.trim().toUpperCase();
  if (upper.includes('CLARO') || upper.includes('AMERICA MOVIL')) return 'CLARO';
  if (upper.includes('MOVISTAR') || upper.includes('TELEFONICA') || upper.includes('TELEFÓNICA')) return 'MOVISTAR';
  if (upper.includes('ENTEL')) return 'ENTEL';
  if (upper.includes('BITEL') || upper.includes('VIETTEL')) return 'BITEL';
  return 'OTRO';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
