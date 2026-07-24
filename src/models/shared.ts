/** Field helpers shared by all models. Money is ALWAYS integer pesewas. */

export const moneyField = {
  type: Number,
  required: true,
  min: 0,
  validate: {
    validator: Number.isInteger,
    message: 'Money must be integer pesewas',
  },
} as const;

export const optionalMoneyField = { ...moneyField, required: false } as const;

export const CHANNELS = ['cash', 'paystack', 'momo'] as const;
export type Channel = (typeof CHANNELS)[number];

export const ROLES = ['admin', 'manager', 'collector'] as const;
export type Role = (typeof ROLES)[number];
