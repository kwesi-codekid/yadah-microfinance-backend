import Fuse from 'fuse.js';
import type { Types } from 'mongoose';
import { CustomerModel } from '../models/index.js';

interface CustomerSearchDoc {
  _id: Types.ObjectId;
  fullName: string;
  phone: string;
  altPhone?: string;
}

/**
 * Typo-tolerant customer lookup: loads the minimal customer projection and
 * ranks with Fuse.js. In-memory is a deliberate Phase 1 tradeoff — a few
 * thousand customers fit comfortably, and self-hosted Mongo has no fuzzy
 * text search. Revisit (cache or Atlas Search) only if customer count or
 * search volume makes this measurably slow.
 */
export async function fuzzyCustomerIds(term: string, limit = 200): Promise<Types.ObjectId[]> {
  const customers = await CustomerModel.find({}, { fullName: 1, phone: 1, altPhone: 1 }).lean<
    CustomerSearchDoc[]
  >();

  const fuse = new Fuse(customers, {
    keys: [
      { name: 'fullName', weight: 0.7 },
      { name: 'phone', weight: 0.2 },
      { name: 'altPhone', weight: 0.1 },
    ],
    threshold: 0.38, // tolerant of typos, not of noise
    ignoreLocation: true,
  });
  return fuse.search(term, { limit }).map((r) => r.item._id);
}
