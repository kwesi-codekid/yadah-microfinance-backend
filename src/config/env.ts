import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGO_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  SMS_API_KEY: z.string().default(''),
  SMS_SENDER_ID: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('Yadah <onboarding@resend.dev>'),
  CLOUDINARY_URL: z.string().default(''),
  FRONTEND_ORIGIN: z.string().default('*'),
  /** Paystack secret key (sk_...). Empty = payments endpoints answer 503. */
  PAYSTACK_SECRET_KEY: z.string().default(''),
  /**
   * Web Push (VAPID). Generate once with `npx web-push generate-vapid-keys`
   * and keep the pair stable — rotating it invalidates every subscription.
   * Empty = in-app notifications still work, browser push is skipped.
   */
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  /** Contact URI push services can reach you on, e.g. mailto:ops@example.com. */
  VAPID_SUBJECT: z.string().default('mailto:support@yadah.example'),
  /**
   * Data-population stage only. Lets the office say which day a susu or
   * savings transaction actually happened on, for history being typed in
   * after the fact. Off by default and meant to be switched off again once
   * the branch is caught up — see lib/backdating.ts.
   *
   * An enum rather than `coerce.boolean`, which follows JS truthiness and
   * would read the string 'false' as true.
   */
  ALLOW_BACKDATED_ENTRY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Logger isn't up yet at config time; fail loud and early.
  console.error('Invalid environment configuration:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
