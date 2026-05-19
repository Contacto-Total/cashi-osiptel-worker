/**
 * Pull-model poller.
 *
 * Loop:
 *   1. GET {BACKEND_URL}/api/v1/osiptel/queue?limit=N  → items SIN_VALIDAR
 *   2. Para cada item: runCheck(dni) → matching local contra phone
 *   3. POST {BACKEND_URL}/api/v1/osiptel/result → backend actualiza estado_osiptel
 *
 * El worker no necesita ser alcanzable desde EC2 — solo hace conexiones salientes.
 */
import { config } from './config.js';
import { logger } from './logger.js';
import { runCheck } from './check.js';
import type { OsiptelLine } from './schema.js';
import { markOk } from './readiness.js';

interface QueueItem {
  id: number;
  phone: string;
  dni: string;
  dniType: string;
}

interface PollResult {
  id: number;
  status: 'VALIDADO' | 'NO_VALIDADO' | 'ERROR';
  operator: string | null;
}

function matchPhone(phone: string, lines: OsiptelLine[]): { status: 'VALIDADO' | 'NO_VALIDADO'; operator: string | null } {
  const digits = phone.replace(/\D/g, '');
  const normalized = digits.length === 11 && digits.startsWith('51') ? digits.slice(2) : digits;
  if (normalized.length !== 9 || !normalized.startsWith('9')) {
    return { status: 'NO_VALIDADO', operator: null };
  }
  const prefix5 = normalized.slice(0, 5);
  const match = lines.find(l => l.phonePrefix === prefix5);
  return match
    ? { status: 'VALIDADO', operator: match.operator }
    : { status: 'NO_VALIDADO', operator: null };
}

async function fetchQueue(): Promise<QueueItem[]> {
  const url = `${config.backend.url}/api/v1/osiptel/queue?limit=${config.backend.pollBatchSize}`;
  const res = await fetch(url, {
    headers: { 'X-Worker-Token': config.backend.token },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`queue HTTP ${res.status}`);
  return res.json() as Promise<QueueItem[]>;
}

async function postResult(r: PollResult): Promise<void> {
  const url = `${config.backend.url}/api/v1/osiptel/result`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Worker-Token': config.backend.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(r),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`result HTTP ${res.status}`);
}

async function processBatch(): Promise<void> {
  const items = await fetchQueue();
  if (items.length === 0) return;

  logger.info({ count: items.length }, 'poll: batch recibido');

  for (const item of items) {
    const checkReq = {
      requestId: `poll-${item.id}`,
      dni: item.dni,
      dniType: item.dniType as 'DNI' | 'CE' | 'PASAPORTE' | 'RUC',
    };

    const outcome = await runCheck(checkReq);

    let result: PollResult;
    if (outcome.status === 'OK' && outcome.lines) {
      const matched = matchPhone(item.phone, outcome.lines);
      result = { id: item.id, ...matched };
    } else if (outcome.status === 'NOT_FOUND') {
      result = { id: item.id, status: 'NO_VALIDADO', operator: null };
    } else {
      result = { id: item.id, status: 'ERROR', operator: null };
    }

    await postResult(result);
    if (result.status === 'VALIDADO' || result.status === 'NO_VALIDADO') markOk();
    logger.info({ id: item.id, status: result.status, operator: result.operator }, 'poll: resultado enviado');
  }
}

export function startPoller(): void {
  if (!config.backend.url) {
    logger.warn('BACKEND_URL no configurado — poller desactivado');
    return;
  }

  const loop = async (): Promise<void> => {
    try {
      await processBatch();
    } catch (err) {
      logger.error({ err }, 'poll: error en batch');
    }
    setTimeout(() => void loop(), config.backend.pollIntervalMs);
  };

  setTimeout(() => void loop(), 2000); // pequeño delay al arranque
  logger.info(
    { backendUrl: config.backend.url, intervalMs: config.backend.pollIntervalMs, batchSize: config.backend.pollBatchSize },
    'poller iniciado'
  );
}
