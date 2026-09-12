import { describe, expect, it } from 'vitest';
import { hasCompleteId, hasIdDocument, missingIdParts } from './id-document.js';

/**
 * The two halves of "identified": a type and number somebody typed in, and
 * photographs of the document itself. Credit turns on both — for the borrower
 * and, since 12 Sep 2026, for whoever guarantees them — and the halves fail
 * separately, which is what `missingIdParts` exists to say.
 */
const FRONT = 'https://res.cloudinary.com/demo/image/upload/front.jpg';
const BACK = 'https://res.cloudinary.com/demo/image/upload/back.jpg';
const PASSPORT = { idType: 'passport' as const, idNumber: 'G12345678' };

describe('hasIdDocument', () => {
  it('needs both sides — one alone counts for nothing', () => {
    expect(hasIdDocument({ idDocumentFrontUrl: FRONT, idDocumentBackUrl: BACK })).toBe(true);
    expect(hasIdDocument({ idDocumentFrontUrl: FRONT })).toBe(false);
    expect(hasIdDocument({ idDocumentBackUrl: BACK })).toBe(false);
    expect(hasIdDocument({})).toBe(false);
  });
});

describe('hasCompleteId', () => {
  it('accepts any ID type, so long as it is recorded and photographed', () => {
    for (const idType of ['ghana-card', 'passport', 'drivers-license', 'voter-id'] as const) {
      expect(
        hasCompleteId({
          identification: { idType, idNumber: 'X1' },
          idDocumentFrontUrl: FRONT,
          idDocumentBackUrl: BACK,
        }),
      ).toBe(true);
    }
  });

  it('refuses a record missing either half', () => {
    // Photographed, but nobody typed the number in.
    expect(hasCompleteId({ idDocumentFrontUrl: FRONT, idDocumentBackUrl: BACK })).toBe(false);
    // Recorded, but never photographed.
    expect(hasCompleteId({ identification: PASSPORT })).toBe(false);
    expect(hasCompleteId({})).toBe(false);
  });
});

describe('missingIdParts', () => {
  it('says nothing about a complete record', () => {
    expect(
      missingIdParts({
        identification: PASSPORT,
        idDocumentFrontUrl: FRONT,
        idDocumentBackUrl: BACK,
      }),
    ).toEqual([]);
  });

  it('names the half that is missing, and both when both are', () => {
    expect(missingIdParts({ identification: PASSPORT })).toEqual([
      'a photo of both sides of the ID',
    ]);
    expect(missingIdParts({ idDocumentFrontUrl: FRONT, idDocumentBackUrl: BACK })).toEqual([
      'the ID type and number',
    ]);
    expect(missingIdParts({})).toEqual([
      'the ID type and number',
      'a photo of both sides of the ID',
    ]);
  });

  it('reads as a sentence when the refusal joins them', () => {
    // How the guarantor refusal is built: "… — the ID type and number and a
    // photo of both sides of the ID is missing from their profile".
    expect(missingIdParts({}).join(' and ')).toBe(
      'the ID type and number and a photo of both sides of the ID',
    );
  });
});
