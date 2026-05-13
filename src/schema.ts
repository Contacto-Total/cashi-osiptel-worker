import { z } from 'zod';

/**
 * Contrato del worker. Compartido entre cliente Java y este worker.
 * Cualquier cambio aquí requiere sincronizar OsiptelWorkerClient en el backend.
 */

export const CheckRequestSchema = z.object({
  requestId: z.string().min(1),
  phone: z.string().regex(/^9\d{8}$/, 'Esperado móvil PE 9XXXXXXXX'),
  dni: z.string().nullable().optional(),
});

export const CheckResponseSchema = z.object({
  requestId: z.string(),
  phone: z.string(),
  operator: z.enum(['CLARO', 'MOVISTAR', 'ENTEL', 'BITEL', 'OTRO']).nullable(),
  dniMatch: z.boolean().nullable(),
  status: z.enum(['OK', 'NOT_FOUND', 'CAPTCHA_FAIL', 'BANNED', 'ERROR']),
  error: z.string().nullable().optional(),
  latencyMs: z.number().int().nonnegative(),
  captchaAttempts: z.number().int().nonnegative(),
  checkedAt: z.string(),
});

export type CheckRequest = z.infer<typeof CheckRequestSchema>;
export type CheckResponse = z.infer<typeof CheckResponseSchema>;
