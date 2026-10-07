import { AppError } from './errors.js';
import { accraDay } from './time.js';

/**
 * Children are customers too (client decision, 5 Oct 2026): the office opens
 * susu and savings books for them, usually on a parent's phone number. Who is
 * a child is never ticked on a form — it is read off the date of birth, and
 * a profile with no date of birth is an adult, so leaving the field blank
 * cannot be used to slip past the adult rules.
 */
export const ADULT_AGE = 18;

/** Whole years old on an Accra day (`YYYY-MM-DD`), today by default. */
export function ageOn(dateOfBirth: Date, day: string = accraDay()): number {
  const born = accraDay(dateOfBirth);
  const years = Number(day.slice(0, 4)) - Number(born.slice(0, 4));
  // Not yet had this year's birthday. A 29 Feb birthday turns over on 1 Mar.
  return day.slice(5) < born.slice(5) ? years - 1 : years;
}

/** Under 18 on that day. No date of birth reads as an adult. */
export function isMinor(dateOfBirth: Date | null | undefined, day: string = accraDay()): boolean {
  return dateOfBirth !== null && dateOfBirth !== undefined && ageOn(dateOfBirth, day) < ADULT_AGE;
}

/**
 * The latest date of birth that is still an adult on `day` — the cut between
 * the two in a query. Born on or before it: adult. After it: child.
 */
export function adultBornBy(day: string = accraDay()): Date {
  const year = String(Number(day.slice(0, 4)) - ADULT_AGE).padStart(4, '0');
  // On 29 Feb the same day 18 years back may not exist; 28 Feb is the same cut,
  // because nobody is born between the two.
  const monthDay = day.slice(5) === '02-29' ? '02-28' : day.slice(5);
  return new Date(`${year}-${monthDay}T23:59:59.999Z`);
}

/**
 * Children may share a phone number with a parent or each other; adults may
 * not. The database holds that as a unique index over adults only, which is
 * why the stored `isMinor` flag exists at all. An adult lookup by phone — the
 * portal login, an import matching rows to people — has to ask for adults,
 * and `$ne: true` also covers a record saved before the flag existed.
 */
export const ADULTS_ONLY = { isMinor: { $ne: true } } as const;

/** One sentence for the loan refusal, the HP reason and the guarantor check. */
export const MINOR_CREDIT_MESSAGE = 'Customers under 18 cannot take a loan or hire purchase';

export function minorCreditRefused(message: string = MINOR_CREDIT_MESSAGE): AppError {
  return new AppError('CUSTOMER_MINOR', message, 422);
}

/** Said when an adult's number is already another adult's. */
export const ADULT_PHONE_TAKEN_MESSAGE =
  'This customer is 18 or older, so they need their own phone number — another adult customer already uses this one';
