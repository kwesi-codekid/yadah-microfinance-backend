import { createDocument } from 'zod-openapi';
import { authPaths } from '../modules/auth/auth.openapi.js';
import { userPaths } from '../modules/users/users.openapi.js';
import { customerPaths } from '../modules/customers/customers.openapi.js';
import { susuPaths } from '../modules/susu/susu.openapi.js';
import { savingsPaths } from '../modules/savings/savings.openapi.js';
import { uploadPaths } from '../modules/uploads/uploads.openapi.js';

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
    tags: [
      { name: 'Auth', description: 'Login (username+password or phone OTP), sessions' },
      { name: 'Users', description: 'Staff management and role assignment (office roles)' },
      { name: 'Customers', description: 'Customer registration, profile, collector assignment' },
      {
        name: 'Susu',
        description: 'Daily-deposit cycles: 31 deposits, catch-up, collect-all, closure',
      },
      {
        name: 'Savings',
        description:
          'Min GHS 10 deposits, 1 withdrawal/day with flat GHS 10 fee, GHS 50 min balance',
      },
      {
        name: 'Uploads',
        description: 'Image upload/delete — URLs are submitted in later form posts',
      },
    ],
    paths: {
      ...authPaths,
      ...userPaths,
      ...customerPaths,
      ...susuPaths,
      ...savingsPaths,
      ...uploadPaths,
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  });
}
