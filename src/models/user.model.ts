import { Schema, model, type Types } from 'mongoose';
import { ROLES, type Role } from './shared.js';

/**
 * One refresh-token session (e.g. one device). Only the SHA-256 hash of the
 * token secret is stored; rotation replaces tokenHash in place. A presented
 * secret that matches a family but not its current hash means the token was
 * stolen and replayed — the whole family is revoked.
 */
export interface RefreshSession {
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface User {
  _id: Types.ObjectId;
  name: string;
  phone: string;
  email?: string;
  passwordHash: string;
  role: Role;
  status: 'active' | 'disabled';
  refreshSessions: RefreshSession[];
  createdAt: Date;
  updatedAt: Date;
}

const refreshSessionSchema = new Schema<RefreshSession>(
  {
    familyId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const userSchema = new Schema<User>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true },
    email: { type: String, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    refreshSessions: { type: [refreshSessionSchema], default: [] },
  },
  { timestamps: true },
);

export const UserModel = model<User>('User', userSchema, 'users');
