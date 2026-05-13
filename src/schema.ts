import { z } from 'zod';

/**
 * Contrato del worker (post-pivot).
 *
 * El portal Osiptel realmente funciona por DOCUMENTO (DNI/CE/RUC/Pasaporte) y
 * devuelve la lista de líneas asociadas al documento, con el teléfono
 * parcialmente enmascarado (5 dígitos visibles + 4 con '*').
 *
 * Por eso el contrato es:
 *  - Input: documento + tipo
 *  - Output: lista de líneas (operador + modalidad + prefijo de teléfono)
 *
 * El matching contra los teléfonos concretos del cliente se hace en el
 * backend Java tras recibir esta respuesta.
 */

export const DOCUMENT_TYPES = ['DNI', 'CE', 'PASAPORTE', 'RUC'] as const;
export const OPERATORS = ['CLARO', 'MOVISTAR', 'ENTEL', 'BITEL', 'OTRO'] as const;

export const CheckRequestSchema = z.object({
  requestId: z.string().min(1),
  dni: z.string().regex(/^[A-Za-z0-9]{6,15}$/, 'documento inválido'),
  dniType: z.enum(DOCUMENT_TYPES).default('DNI'),
});

export const OsiptelLineSchema = z.object({
  /** Prefijo visible del número, p.ej. "97851". */
  phonePrefix: z.string(),
  /** Operador normalizado. */
  operator: z.enum(OPERATORS),
  /** Modalidad reportada por el portal (CONTROL, POSTPAGO, etc.). */
  modality: z.string().nullable(),
});

export const CheckResponseSchema = z.object({
  requestId: z.string(),
  dni: z.string(),
  dniType: z.enum(DOCUMENT_TYPES),
  status: z.enum(['OK', 'NOT_FOUND', 'CAPTCHA_FAIL', 'BANNED', 'ERROR']),
  lines: z.array(OsiptelLineSchema).nullable(),
  error: z.string().nullable().optional(),
  latencyMs: z.number().int().nonnegative(),
  captchaAttempts: z.number().int().nonnegative(),
  checkedAt: z.string(),
});

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type OperatorCode = (typeof OPERATORS)[number];
export type CheckRequest = z.infer<typeof CheckRequestSchema>;
export type CheckResponse = z.infer<typeof CheckResponseSchema>;
export type OsiptelLine = z.infer<typeof OsiptelLineSchema>;
