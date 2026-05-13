import pino from 'pino';
import { config } from './config.js';

/**
 * Logger estructurado JSON.
 * En desarrollo opcional usa pino-pretty (LOG_PRETTY=true).
 *
 * Reglas de privacidad:
 *  - NUNCA loggear DNI plaintext.
 *  - phone se enmascara mostrando solo los últimos 3 dígitos.
 */
const transport = process.env.LOG_PRETTY === 'true'
  ? { target: 'pino-pretty', options: { colorize: true } }
  : undefined;

export const logger = pino({
  level: config.logLevel,
  base: { service: 'cashi-osiptel-worker' },
  transport,
});

export function maskPhone(phone: string): string {
  if (!phone || phone.length < 3) return '***';
  return '******' + phone.slice(-3);
}
