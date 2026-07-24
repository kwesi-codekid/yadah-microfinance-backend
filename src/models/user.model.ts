import { Schema, model, type Types } from 'mongoose';
import { ROLES, type Role } from './shared.js';

export interface User {
  _id: Types.ObjectId;
  name: string;
  phone: string;
  email?: string;
  passwordHash: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<User>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true },
    email: { type: String, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  },
  { timestamps: true },
);

export const UserModel = model<User>('User', userSchema, 'users');
