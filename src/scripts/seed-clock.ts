/**
 * Must be the FIRST import of seed-full.ts: it prepares the process before any
 * application module reads its configuration or takes a reference to `Date`.
 *
 * 1. Every outside service is switched off for this process, whatever `.env`
 *    says, so replaying history can never text, email or charge anybody.
 * 2. `new Date()` and `Date.now()` become a clock the seed can move. Replaying
 *    a day with the clock set to that day means the real services stamp every
 *    record, schedule, ObjectId and audit entry as if it happened then, so no
 *    date has to be patched afterwards and nothing can disagree about when.
 */
import 'dotenv/config';

for (const key of [
  'SMS_API_KEY',
  'RESEND_API_KEY',
  'PAYSTACK_SECRET_KEY',
  'CLOUDINARY_URL',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
]) {
  process.env[key] = '';
}
// Paper loans are entered behind this switch. It only affects this process.
process.env.ALLOW_BACKDATED_ENTRY = 'true';

// One replay commits thousands of transactions. Not waiting for the disk, and a
// short driver heartbeat (operations were stalling until the next one once the
// clock moved), take it from most of an hour to minutes. Dev data, re-creatable.
if (process.env.MONGO_URI) {
  const joiner = process.env.MONGO_URI.includes('?') ? '&' : '?';
  process.env.MONGO_URI += `${joiner}w=1&journal=false&heartbeatFrequencyMS=500`;
}

const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
let offsetMs = 0;

globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[], newTarget: new (...a: never[]) => unknown) {
    const effective = args.length === 0 ? [realNow() + offsetMs] : args;
    return Reflect.construct(target, effective, newTarget) as object;
  },
  apply() {
    return new RealDate(realNow() + offsetMs).toString();
  },
  get(target, prop, receiver: unknown) {
    if (prop === 'now') return () => realNow() + offsetMs;
    return Reflect.get(target, prop, receiver) as unknown;
  },
});

/** Sets the clock to an instant; it keeps ticking from there. */
export function setClock(at: number): void {
  offsetMs = at - realNow();
}

/** Back to the real time. */
export function resetClock(): void {
  offsetMs = 0;
}

export function realTime(): number {
  return realNow();
}
