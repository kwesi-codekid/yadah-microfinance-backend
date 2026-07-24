import { createDocument } from 'zod-openapi';
import { authPaths } from '../modules/auth/auth.openapi.js';

/** Modules register their paths here as they land (users, customers, susu…). */
export function buildOpenApiDocument(): ReturnType<typeof createDocument> {
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'Yadah Microfinance API',
      version: '0.1.0',
      description:
        'Susu collection, savings, and loans API for Yadah Dynamic Enterprise.\n\n' +
        '**Conventions**: JSON, camelCase fields. All money values are **integer pesewas** ' +
        '(GHS 10.50 = `1050`). Dates are ISO 8601 UTC. Errors always use the ' +
        '`{ error: { code, message, details? } }` envelope. Authenticate with ' +
        '`Authorization: Bearer <accessToken>`.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [{ name: 'Auth', description: 'Login (username+password or phone OTP), sessions' }],
    paths: { ...authPaths },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  });
}
