import { z } from 'zod';
import { CORRECTION_KINDS, CORRECTION_STATUSES } from '../../models/index.js';
import { objectId, pagination, positiveMoneyPesewas } from '../../schemas/common.js';

/**
 * The office correcting a transaction outright. Each module's own PATCH takes
 * this body; the rules on the amount are the module's, checked in the service.
 */
export const correctionBody = z.object({
  /** The corrected amount, pesewas. */
  amount: positiveMoneyPesewas,
});
export type CorrectionBody = z.infer<typeof correctionBody>;

/**
 * A teller asking the office to correct a transaction. The same amount as a
 * direct correction, plus a reason: the office decides on that line, so it
 * is not optional the way a trash reason is.
 */
export const proposeCorrectionBody = correctionBody.extend({
  reason: z.string().min(3).max(300).trim(),
});
export type ProposeCorrectionBody = z.infer<typeof proposeCorrectionBody>;

export const correctionIdParams = z.object({ correctionId: objectId });
export type CorrectionIdParams = z.infer<typeof correctionIdParams>;

export const listCorrectionsQuery = pagination.extend({
  status: z.enum(CORRECTION_STATUSES).optional(),
  kind: z.enum(CORRECTION_KINDS).optional(),
  /** The account, loan or agreement whose requests to list. */
  targetId: objectId.optional(),
});
export type ListCorrectionsQuery = z.infer<typeof listCorrectionsQuery>;

export const rejectCorrectionBody = z.object({
  /** Why not, in words the teller will read. */
  reason: z.string().min(3).max(300).trim(),
});
export type RejectCorrectionBody = z.infer<typeof rejectCorrectionBody>;
