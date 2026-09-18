import { Router } from 'express';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { listAuditLogsQuery, type ListAuditLogsQuery } from './audit-logs.schemas.js';
import * as auditLogs from './audit-logs.service.js';

/**
 * The trail, read-only. There is no POST here and never will be: entries are
 * written by the services alongside the change they record (see lib/audit.ts),
 * inside the same transaction, and an entry written from a route would be an
 * entry with no change behind it.
 *
 * Office only. The trail names who did what across every module, including
 * staff accounts and the company's own books, none of which the counter reads.
 */
export const auditLogsRouter = Router();
auditLogsRouter.use(requireAuth, requireOffice);

auditLogsRouter.get('/', validate({ query: listAuditLogsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListAuditLogsQuery }>(req);
  auditLogs
    // An export is the whole filtered set, not whichever page was on screen.
    .listAuditLogs(query.format === 'json' ? query : { ...query, page: 1, limit: EXPORT_MAX_ROWS })
    .then((list) =>
      sendExport(res, {
        format: query.format,
        filename: 'audit-log',
        payload: list,
        rows: list.items.map(auditLogs.toAuditExportRow),
        moneyKeys: ['amountBefore', 'amountAfter'],
        sheet: 'Audit log',
      }),
    )
    .catch(next);
});
