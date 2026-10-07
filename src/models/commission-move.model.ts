import { Schema, model, type Types } from 'mongoose';
import { moneyField, trashFields, type TrashFields } from './shared.js';

/**
 * Money moved out of Yadah's commission account into one of the company's
 * cash accounts (client decision, 7 Oct 2026). The commission account goes
 * down and that cash account goes up by the same amount — the company's cash
 * total does not change. Office staff record them.
 *
 * Never edited. A move made in error (wrong account, wrong amount) goes to the
 * trash, which puts the money back in the commission account; then it is
 * moved again correctly.
 */
export interface CommissionMove extends TrashFields {
  _id: Types.ObjectId;
  amount: number;
  cashAccountId: Types.ObjectId;
  /** Accra day the money moved. */
  occurredOn: string;
  note?: string;
  recordedById: Types.ObjectId;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const commissionMoveSchema = new Schema<CommissionMove>(
  {
    amount: moneyField,
    cashAccountId: { type: Schema.Types.ObjectId, ref: 'CashAccount', required: true },
    occurredOn: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    note: { type: String, trim: true, maxlength: 300 },
    recordedById: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String, required: true },
    ...trashFields,
  },
  { timestamps: true },
);

commissionMoveSchema.index({ idempotencyKey: 1 }, { unique: true });
commissionMoveSchema.index({ occurredOn: -1, _id: -1 });
commissionMoveSchema.index({ cashAccountId: 1, occurredOn: 1 });

export const CommissionMoveModel = model<CommissionMove>(
  'CommissionMove',
  commissionMoveSchema,
  'commission-moves',
);
