import { z } from 'zod';

/** The wire format every error uses: { error: { code, message, details? } } */
export const errorEnvelope = z
  .object({
    error: z.object({
      code: z.string().describe('Stable machine-readable code, e.g. VALIDATION_ERROR'),
      message: z.string(),
      details: z.unknown().optional().describe('Present on VALIDATION_ERROR: array of issues'),
    }),
  })
  .meta({ id: 'ErrorEnvelope' });

export function errorResponse(description: string): {
  description: string;
  content: { 'application/json': { schema: typeof errorEnvelope } };
} {
  return {
    description,
    content: { 'application/json': { schema: errorEnvelope } },
  };
}

export function jsonBody<T extends z.ZodType>(
  schema: T,
): { content: { 'application/json': { schema: T } } } {
  return { content: { 'application/json': { schema } } };
}

export function jsonResponse<T extends z.ZodType>(
  description: string,
  schema: T,
): { description: string; content: { 'application/json': { schema: T } } } {
  return { description, content: { 'application/json': { schema } } };
}
