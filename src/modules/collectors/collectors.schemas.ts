import { z } from 'zod';
import { isoDay, objectId } from '../../schemas/common.js';

/**
 * Both collector views default to today. `collectorId` is accepted only from
 * office roles — a collector is always pinned to themselves in the service,
 * so passing someone else's id simply has no effect.
 */
export const collectorDayQuery = z.object({
  date: isoDay.optional(),
  collectorId: objectId.optional(),
});
export type CollectorDayQuery = z.infer<typeof collectorDayQuery>;
