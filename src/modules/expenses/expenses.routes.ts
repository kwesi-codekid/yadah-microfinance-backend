import { Router } from 'express';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireCounter, requireOffice } from '../../middleware/rbac.js';
import { getAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { trashBody, type TrashBody } from '../../schemas/common.js';
import {
  attachReceiptBody,
  createExpenseBody,
  expenseIdParams,
  expenseSummaryQuery,
  listExpensesQuery,
  payExpenseBody,
  rejectExpenseBody,
  trashListQuery,
  updateExpenseBody,
  type AttachReceiptBody,
  type CreateExpenseBody,
  type ExpenseIdParams,
  type ExpenseSummaryQuery,
  type ListExpensesQuery,
  type PayExpenseBody,
  type RejectExpenseBody,
  type TrashListQuery,
  type UpdateExpenseBody,
} from './expenses.schemas.js';
import * as expenses from './expenses.service.js';

export const expensesRouter = Router();

/**
 * The counter records what it spends; the office decides and pays.
 *
 * Petty cash leaves the drawer in ones and twos all day, and a book only the
 * office can open is a book written up on Friday from a pocketful of receipts.
 * So recording, reading and correcting one's own pending entry sit at the
 * counter, and every route that DECIDES — approve, reject, pay, and the bin —
 * says `requireOffice` on its own line.
 */
expensesRouter.use(requireAuth, requireCounter);

expensesRouter.post('/', validate({ body: createExpenseBody }), (req, res, next) => {
  const { body } = getValidated<{ body: CreateExpenseBody }>(req);
  expenses
    .recordExpense(getAuth(req), body, req.id as string)
    .then((expense) => res.status(201).json({ expense }))
    .catch(next);
});

expensesRouter.get('/', validate({ query: listExpensesQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListExpensesQuery }>(req);
  expenses
    // An export is the whole filtered set, not whichever page happened to be
    // on screen when somebody pressed the button.
    .listExpenses(query.format === 'json' ? query : { ...query, page: 1, limit: EXPORT_MAX_ROWS })
    .then((list) =>
      sendExport(res, {
        format: query.format,
        filename: 'expenses',
        payload: list,
        rows: list.items.map(expenses.toExpenseExportRow),
        moneyKeys: ['amount'],
      }),
    )
    .catch(next);
});

// Registered before /:id so neither word is ever read as an id.
expensesRouter.get('/summary', validate({ query: expenseSummaryQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ExpenseSummaryQuery }>(req);
  expenses
    .expenseSummary(query)
    .then((summary) => res.json(summary))
    .catch(next);
});

expensesRouter.get('/:id', validate({ params: expenseIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: ExpenseIdParams }>(req);
  expenses
    .getExpense(params.id)
    .then((expense) => res.json({ expense }))
    .catch(next);
});

expensesRouter.patch(
  '/:id',
  validate({ params: expenseIdParams, body: updateExpenseBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: ExpenseIdParams; body: UpdateExpenseBody }>(
      req,
    );
    expenses
      .updateExpense(getAuth(req), params.id, body, req.id as string)
      .then((expense) => res.json({ expense }))
      .catch(next);
  },
);

expensesRouter.post(
  '/:id/receipt',
  validate({ params: expenseIdParams, body: attachReceiptBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: ExpenseIdParams; body: AttachReceiptBody }>(
      req,
    );
    expenses
      .attachReceipt(getAuth(req), params.id, body, req.id as string)
      .then((expense) => res.json({ expense }))
      .catch(next);
  },
);

// Deciding and paying are the office's, and so is the bin. They are grouped
// here, apart from the counter's routes above, because the access tests read a
// few lines past each route for its guard: a `requireOffice` sitting directly
// under a counter route would read as belonging to it.
//
expensesRouter.get(
  '/trash',
  requireOffice,
  validate({ query: trashListQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: TrashListQuery }>(req);
    expenses
      .listExpenseTrash(query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

expensesRouter.post(
  '/:id/approve',
  requireOffice,
  validate({ params: expenseIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: ExpenseIdParams }>(req);
    expenses
      .approveExpense(getAuth(req), params.id, req.id as string)
      .then((expense) => res.json({ expense }))
      .catch(next);
  },
);

expensesRouter.post(
  '/:id/reject',
  requireOffice,
  validate({ params: expenseIdParams, body: rejectExpenseBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: ExpenseIdParams; body: RejectExpenseBody }>(
      req,
    );
    expenses
      .rejectExpense(getAuth(req), params.id, body.reason, req.id as string)
      .then((expense) => res.json({ expense }))
      .catch(next);
  },
);

expensesRouter.post(
  '/:id/pay',
  requireOffice,
  validate({ params: expenseIdParams, body: payExpenseBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: ExpenseIdParams; body: PayExpenseBody }>(req);
    expenses
      .payExpense(getAuth(req), params.id, body, req.id as string)
      .then((expense) => res.json({ expense }))
      .catch(next);
  },
);

expensesRouter.delete(
  '/:id',
  requireOffice,
  validate({ params: expenseIdParams, body: trashBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: ExpenseIdParams; body: TrashBody }>(req);
    expenses
      .trashExpense(getAuth(req), params.id, body.reason, req.id as string)
      .then((expense) => res.json({ expense }))
      .catch(next);
  },
);

expensesRouter.post(
  '/:id/restore',
  requireOffice,
  validate({ params: expenseIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: ExpenseIdParams }>(req);
    expenses
      .restoreExpense(getAuth(req), params.id, req.id as string)
      .then((expense) => res.json({ expense }))
      .catch(next);
  },
);
