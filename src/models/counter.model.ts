import { Schema, model } from 'mongoose';

/**
 * Atomic sequence counters. One document per sequence, `_id` is the sequence
 * key (e.g. `SU-2608` — susu numbers issued in August 2026). Incremented with
 * a single `findOneAndUpdate($inc)`, which Mongo applies atomically even under
 * concurrent writers.
 *
 * Deliberately NOT written inside the caller's transaction: a hot counter
 * document would collide on every concurrent account opening and abort the
 * money transaction around it. The cost is a gap in the sequence when a
 * creation rolls back — account numbers are identifiers, not a ledger, so
 * gaps are harmless.
 */

export interface Counter {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<Counter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const CounterModel = model<Counter>('Counter', counterSchema, 'counters');
