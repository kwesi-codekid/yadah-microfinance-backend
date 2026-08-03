import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { transferBody } from './transfers.schemas.js';

export const transferPaths: ZodOpenApiPathsObject = {
  '/transfers': {
    post: {
      tags: ['Transfers'],
      summary: 'Move money between a customer’s accounts (office only, atomic)',
      description:
        'Supported: susu → savings/loan/hire-purchase · savings → susu/loan/hire-purchase. ' +
        'Each side keeps its own rules: a savings source is a real withdrawal ' +
        '(GHS 10 fee, one per day, available-balance limits); a susu source stops ' +
        'the account with normal commission (or draws a pending-payout balance — ' +
        'the only case where a partial amount is allowed). Loan/HP destinations ' +
        'receive at most their remaining balance; a susu-source excess stays in ' +
        'the account pending withdrawal. Internal savings credits skip the GHS 10 ' +
        'minimum-deposit rule. One SMS summarizes the move.',
      security: [{ bearerAuth: [] }],
      requestBody: jsonBody(transferBody),
      responses: {
        '201': jsonResponse(
          'Transferred',
          z.object({
            transfer: z.object({
              id: z.string(),
              fromType: z.string(),
              toType: z.string(),
              amountMoved: z.number().int(),
              fee: z.number().int(),
              amountCredited: z.number().int(),
              excessPending: z.number().int(),
            }),
            replayed: z.boolean(),
          }),
        ),
        '409': errorResponse('WITHDRAWAL_LIMIT, ALREADY_CLOSED, or CONFLICT'),
        '422': errorResponse(
          'CUSTOMER_MISMATCH, EXCEEDS_AVAILABLE, EXCEEDS_PAYOUT, AMOUNT_MISMATCH, EXCEEDS_REMAINING, LOAN_NOT_OPEN, AGREEMENT_NOT_OPEN, or NO_PAYOUT',
        ),
      },
    },
  },
};
