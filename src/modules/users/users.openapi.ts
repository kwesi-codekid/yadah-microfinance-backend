import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { publicUserResponse } from '../auth/auth.schemas.js';
import { createUserBody, listUsersQuery, updateUserBody } from './users.schemas.js';

const userResult = z.object({ user: publicUserResponse });
const userList = z.object({
  items: z.array(publicUserResponse),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
});
const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string().describe('User id (24-char hex)') });

export const userPaths: ZodOpenApiPathsObject = {
  '/users': {
    post: {
      tags: ['Users'],
      summary: 'Create a staff member (admin only)',
      description:
        'Admin sets the initial password and shares it offline. ' +
        'No delete endpoint exists — set status to `disabled` instead.',
      security,
      requestBody: jsonBody(createUserBody),
      responses: {
        '201': jsonResponse('Created', userResult),
        '403': errorResponse('FORBIDDEN — requires admin'),
        '409': errorResponse('USERNAME_TAKEN or PHONE_TAKEN'),
      },
    },
    get: {
      tags: ['Users'],
      summary: 'List staff (admin, manager)',
      security,
      requestParams: { query: listUsersQuery },
      responses: {
        '200': jsonResponse('Paginated staff list', userList),
        '403': errorResponse('FORBIDDEN'),
      },
    },
  },
  '/users/{id}': {
    get: {
      tags: ['Users'],
      summary: 'Get one staff member (admin, manager)',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('The user', userResult),
        '404': errorResponse('NOT_FOUND'),
      },
    },
    patch: {
      tags: ['Users'],
      summary: 'Update profile, role, or status (admin only)',
      description:
        'Role change or disable also revokes all of the user’s refresh sessions; ' +
        'their access token dies within 15 minutes. Admins cannot change their own ' +
        'role or disable themselves.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(updateUserBody),
      responses: {
        '200': jsonResponse('Updated user', userResult),
        '403': errorResponse('FORBIDDEN or CANNOT_MODIFY_SELF'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('PHONE_TAKEN'),
      },
    },
  },
};
