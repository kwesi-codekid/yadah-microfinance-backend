import { AppError } from './errors.js';
import type { Customer } from '../models/index.js';

/**
 * The ID document images are optional on the profile itself (client decision,
 * 10 Sep 2026): a customer can be registered and edited without them. They
 * gate credit instead — no loan or hire-purchase agreement is opened, approved
 * or restored until both sides are on file, and neither side can be removed
 * while one is running. "On file" means both the front and the back.
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
