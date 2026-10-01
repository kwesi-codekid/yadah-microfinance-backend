import { z } from 'zod';
import {
  channel,
  dateRangeFields,
  exportFormat,
  fromToIssue,
  ghanaPhone,
  isoDay,
  idempotencyKey,
  objectId,
  pagination,
  positiveMoneyPesewas,
  uploadedImageUrl,
} from '../../schemas/common.js';

/**
 * A guarantor who need not be on the books — anybody willing to stand behind
 * the loan, written down as the paper names them.
 */
export const guarantorDetails = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: ghanaPhone,
  idNumber: z.string().trim().min(1).max(40).optional(),
});
export type GuarantorDetails = z.infer<typeof guarantorDetails>;

export const applyBody = z
  .object({
    customerId: objectId,
    principal: positiveMoneyPesewas,
    durationMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]),
    /**
     * A registered customer who stands behind the loan. They must be active,
     * must not be the borrower, and must be identified as fully as the
     * borrower — an ID recorded and both sides of it photographed.
     */
    guarantorId: objectId.optional(),
    /** Or anybody at all, by name and phone. */
    guarantor: guarantorDetails.optional(),
    /** Or several people, by name and phone, the first one first. */
    guarantors: z.array(guarantorDetails).min(1).max(10).optional(),
    /** A picture of the customer's signature on the application, from POST /uploads/images?kind=signature. */
    signatureUrl: uploadedImageUrl,
  })
  .check((ctx) => {
    // Exactly one of the three ways of naming the guarantor.
    const given =
      Number(ctx.value.guarantorId !== undefined) +
      Number(ctx.value.guarantor !== undefined) +
      Number(ctx.value.guarantors !== undefined);
    if (given !== 1) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['guarantor'],
        message: 'Give the guarantor one way — guarantorId, guarantor or guarantors',
      });
    }
  });
export type ApplyBody = z.infer<typeof applyBody>;

/**
 * A loan the branch made on paper before the system existed, copied in as the
 * paper records it. See `recordPaperLoan`.
 */
export const paperLoanBody = z.object({
  customerId: objectId,
  principal: positiveMoneyPesewas,
  durationMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]),
  /** The rate the paper says is owed today — escalation carries on from here. */
  ratePercent: z.union([z.literal(10), z.literal(20), z.literal(30)]),
  /** The day the money was handed over. */
  disbursedOn: isoDay,
  /** The day the application was written, when the paper says; else the disbursement. */
  appliedOn: isoDay.optional(),
  /** Everybody the paper names as standing behind the loan, first one first. */
  guarantors: z.array(guarantorDetails).max(10).default([]),
  /** Every payment the paper records, each on the day it was made. */
  repayments: z
    .array(z.object({ paidOn: isoDay, amount: positiveMoneyPesewas }))
    .max(200)
    .default([]),
  /** The number written on the paper form. */
  paperRef: z.string().trim().min(1).max(40).optional(),
  /** A photograph of the paper form, from POST /uploads/images?kind=document. */
  paperPhotoUrl: uploadedImageUrl.optional(),
});
export type PaperLoanBody = z.infer<typeof paperLoanBody>;

export const listLoansQuery = pagination
  .extend({
    customerId: objectId.optional(),
    status: z.enum(['pending', 'active', 'repaid', 'rejected', 'arrears']).optional(),
    /** Fuzzy: typo-tolerant customer name or phone. */
    search: z.string().min(1).max(100).optional(),
    format: exportFormat,
    ...dateRangeFields,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListLoansQuery = z.infer<typeof listLoansQuery>;

/** Trash listing is plain pagination — newest-trashed first. */
export const loanTrashQuery = pagination;
export type LoanTrashQuery = z.infer<typeof loanTrashQuery>;

// Shared trash body (optional reason) — re-exported so routes keep a single schema source.
export { trashBody, type TrashBody } from '../../schemas/common.js';

export const loanIdParams = z.object({ id: objectId });
export type LoanIdParams = z.infer<typeof loanIdParams>;

export const repaymentIdParams = z.object({ id: objectId, repaymentId: objectId });
export type RepaymentIdParams = z.infer<typeof repaymentIdParams>;

export const customerIdParams = z.object({ customerId: objectId });
export type CustomerIdParams = z.infer<typeof customerIdParams>;

export const rejectBody = z.object({
  reason: z.string().min(2).max(300).trim(),
});
export type RejectBody = z.infer<typeof rejectBody>;

export const repayBody = z.object({
  amount: positiveMoneyPesewas.min(1),
  idempotencyKey,
  channel,
});
export type RepayBody = z.infer<typeof repayBody>;

export const susuRepayBody = z.object({
  susuAccountId: objectId,
  /** Taken from the susu balance — at most its availableToWithdraw, and at most what the loan still owes. */
  amount: positiveMoneyPesewas.min(1),
  idempotencyKey,
});
export type SusuRepayBody = z.infer<typeof susuRepayBody>;

export const putConfigBody = z
  .object({
    ratePercent3: z.number().int().min(1).max(100),
    ratePercent6: z.number().int().min(1).max(100),
    ratePercent12: z.number().int().min(1).max(100),
    smallMinPesewas: positiveMoneyPesewas,
    smallMaxPesewas: positiveMoneyPesewas,
    bigMaxPesewas: positiveMoneyPesewas,
  })
  .check((ctx) => {
    const v = ctx.value;
    if (!(v.smallMinPesewas < v.smallMaxPesewas && v.smallMaxPesewas < v.bigMaxPesewas)) {
      ctx.issues.push({
        code: 'custom',
        message: 'Tier bounds must satisfy smallMin < smallMax < bigMax',
        path: ['smallMaxPesewas'],
        input: v.smallMaxPesewas,
      });
    }
    if (!(v.ratePercent3 < v.ratePercent6 && v.ratePercent6 < v.ratePercent12)) {
      ctx.issues.push({
        code: 'custom',
        message: 'Rates must increase with duration (escalation ladder depends on it)',
        path: ['ratePercent12'],
        input: v.ratePercent12,
      });
    }
  });
export type PutConfigBody = z.infer<typeof putConfigBody>;
