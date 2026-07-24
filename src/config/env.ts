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
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Logger isn't up yet at config time; fail loud and early.
  console.error('Invalid environment configuration:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
