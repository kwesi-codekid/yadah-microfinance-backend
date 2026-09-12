import { AppError } from './errors.js';
import type { Customer } from '../models/index.js';

/**
 * The ID document images are optional on the profile itself (client decision,
 * 10 Sep 2026): a customer can be registered and edited without them. They
 * gate credit instead — no loan or hire-purchase agreement is opened, approved
 * or restored until both sides are on file, and neither side can be removed
 * while one is running. "On file" means both the front and the back.
 *
 * ANY of the four ID types is accepted (client decision, 12 Sep 2026 — loans
 * previously demanded a Ghana Card). What credit turns on is that there IS an
 * identified document and that both sides of it have been photographed, not
 * which document it happens to be.
 */
export function hasIdDocument(
  customer: Pick<Customer, 'idDocumentFrontUrl' | 'idDocumentBackUrl'>,
): boolean {
  return Boolean(customer.idDocumentFrontUrl && customer.idDocumentBackUrl);
}

/** One sentence for both the loan refusal and the HP eligibility reason. */
export const ID_DOCUMENT_REQUIRED_MESSAGE =
  'No ID document on the customer profile — upload the front and back of the ID first';

export function idDocumentRequired(): AppError {
  return new AppError('ID_DOCUMENT_REQUIRED', ID_DOCUMENT_REQUIRED_MESSAGE, 422);
}

/**
 * Identified well enough to stand behind money: an ID recorded, and both sides
 * of it photographed.
 *
 * The two halves are separate facts on the profile and fail for different
 * reasons — `identification` is the type and number somebody typed in, the two
 * URLs are the pictures — so callers that need to say WHICH half is missing use
 * `missingIdParts` below rather than this.
 */
export function hasCompleteId(
  customer: Pick<Customer, 'identification' | 'idDocumentFrontUrl' | 'idDocumentBackUrl'>,
): boolean {
  return Boolean(customer.identification?.idNumber) && hasIdDocument(customer);
}

/** Which halves of the ID are missing, in words a teller can act on. */
export function missingIdParts(
  customer: Pick<Customer, 'identification' | 'idDocumentFrontUrl' | 'idDocumentBackUrl'>,
): string[] {
  const missing: string[] = [];
  if (!customer.identification?.idNumber) missing.push('the ID type and number');
  if (!hasIdDocument(customer)) missing.push('a photo of both sides of the ID');
  return missing;
}
