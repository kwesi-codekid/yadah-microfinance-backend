import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';
import { AppError } from '../lib/errors.js';

interface ValidationSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

interface ValidationIssue {
  in: 'body' | 'query' | 'params';
  path: string;
  message: string;
}

/**
 * Validates request parts against Zod schemas and stores the PARSED values on
 * req.validated. Handlers must read via getValidated() — never req.body/query
 * directly, so money fields etc. are always the coerced, typed versions.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const issues: ValidationIssue[] = [];
    const validated: Record<string, unknown> = {};

    for (const part of ['body', 'query', 'params'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
      } else {
        issues.push(
          ...result.error.issues.map((i) => ({
            in: part,
            path: i.path.join('.'),
            message: i.message,
          })),
        );
      }
    }

    if (issues.length > 0) {
      next(new AppError('VALIDATION_ERROR', 'Request validation failed', 400, issues));
      return;
    }

    (req as Request & { validated: unknown }).validated = validated;
    next();
  };
}

/** Typed accessor for the parsed request parts set by validate(). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is the caller-declared shape of req.validated; a cast helper is the point.
export function getValidated<T>(req: Request): T {
  const v = (req as Request & { validated?: unknown }).validated;
  if (v === undefined) {
    throw new AppError('INTERNAL_ERROR', 'getValidated called on a route without validate()', 500);
  }
  return v as T;
}
