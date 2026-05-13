/**
 * Pool de contextos Playwright.
 *
 * Diseño:
 *  - Un Browser único compartido (Chromium headless).
 *  - N BrowserContext aislados que se prestan a cada check (cookies, storage independientes).
 *  - Cada contexto se recicla después de `recycleAfter` usos o tras un BANNED.
 *  - Si todos los contextos están ocupados, el lease espera en cola FIFO.
 *  - Cierre limpio en SIGTERM.
 */
import { Browser, BrowserContext, chromium } from 'playwright';
import { config } from './config.js';
import { logger } from './logger.js';
import { poolGauge } from './metrics.js';

interface PoolSlot {
  id: number;
  context: BrowserContext;
  usesSinceRecycle: number;
  inUse: boolean;
}

type Waiter = (slot: PoolSlot) => void;

export class BrowserPool {
  private browser: Browser | null = null;
  private slots: PoolSlot[] = [];
  private waiters: Waiter[] = [];
  private started = false;
  private nextSlotId = 0;

  async start(): Promise<void> {
    if (this.started) return;
    this.browser = await chromium.launch({
      headless: config.playwright.headless,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    for (let i = 0; i < config.pool.size; i++) {
      const ctx = await this.createContext();
      this.slots.push({
        id: this.nextSlotId++,
        context: ctx,
        usesSinceRecycle: 0,
        inUse: false,
      });
    }
    this.started = true;
    this.updateGauge();
    logger.info({ poolSize: this.slots.length }, 'browser-pool ready');
  }

  async stop(): Promise<void> {
    for (const slot of this.slots) {
      try { await slot.context.close(); } catch { /* ignore */ }
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
    }
    this.slots = [];
    this.waiters = [];
    this.started = false;
  }

  /**
   * Pide un contexto. Si todos están ocupados, espera.
   * El caller DEBE llamar release() pase lo que pase (try/finally).
   */
  async acquire(): Promise<PoolSlot> {
    if (!this.started) throw new Error('pool-not-started');
    const free = this.slots.find(s => !s.inUse);
    if (free) {
      free.inUse = true;
      this.updateGauge();
      return free;
    }
    return new Promise<PoolSlot>(resolve => this.waiters.push(resolve));
  }

  /**
   * Devuelve un contexto al pool.
   * @param recycle si true, cierra y recrea el contexto antes de devolverlo (ej. tras BANNED).
   */
  async release(slot: PoolSlot, recycle = false): Promise<void> {
    slot.usesSinceRecycle++;
    const shouldRecycle = recycle || slot.usesSinceRecycle >= config.pool.recycleAfter;

    if (shouldRecycle && this.browser) {
      try {
        await slot.context.close();
      } catch (err) {
        logger.warn({ slotId: slot.id, err: errMsg(err) }, 'error closing context during recycle');
      }
      try {
        slot.context = await this.createContext();
        slot.usesSinceRecycle = 0;
        logger.info({ slotId: slot.id }, 'context recycled');
      } catch (err) {
        logger.error({ slotId: slot.id, err: errMsg(err) }, 'failed to recycle context');
      }
    }

    slot.inUse = false;

    // Entregar a un waiter si hay uno esperando
    const waiter = this.waiters.shift();
    if (waiter) {
      slot.inUse = true;
      waiter(slot);
    }
    this.updateGauge();
  }

  private async createContext(): Promise<BrowserContext> {
    if (!this.browser) throw new Error('browser-not-launched');
    // Si hay proxies configurados, asignar uno round-robin
    const proxy = this.pickProxy();
    return this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'es-PE',
      timezoneId: 'America/Lima',
      ...(proxy ? { proxy: { server: proxy } } : {}),
    });
  }

  private proxyIdx = 0;
  private pickProxy(): string | null {
    if (config.proxies.length === 0) return null;
    const proxy = config.proxies[this.proxyIdx % config.proxies.length];
    this.proxyIdx++;
    return proxy;
  }

  private updateGauge(): void {
    const available = this.slots.filter(s => !s.inUse).length;
    poolGauge.set(available);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const browserPool = new BrowserPool();
