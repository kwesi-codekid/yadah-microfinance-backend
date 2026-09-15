import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { deleteImage, uploadImage } from '../../lib/photos.js';
import { requireAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

/**
 * What phones and scanners actually produce, rather than what the web grew up
 * on. An iPhone saves HEIC by default and a recent Android saves AVIF; neither
 * used to get past this filter, which is what the branch experienced as "my
 * phone will not upload". Cloudinary reads every format listed here, and
 * lib/photos.ts rewrites whatever arrives as JPEG or PNG, so widening the door
 * costs nothing downstream.
 */
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  // Not a registered type, but some Android cameras and scanners send it.
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  // A Live Photo or a burst, which iOS hands over as a sequence. Cloudinary
  // keeps the first frame, which is the picture the clerk framed.
  'image/heic-sequence',
  'image/heif-sequence',
  'image/avif',
  'image/gif',
  'image/bmp',
  'image/tiff',
]);

/**
 * The same formats by extension, for the handsets that do not name what they
 * are sending.
 *
 * A browser that has never heard of HEIC labels it `application/octet-stream`,
 * and an iPhone picking from Files rather than the photo library does exactly
 * that. Refusing on the label alone rejects a photograph that is perfectly
 * good, so a generic label falls back to the extension — and Cloudinary, which
 * is told to expect an image and refuses anything that is not one, has the
 * final say either way.
 */
const ALLOWED_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif|avif|gif|bmp|tiff?)$/i;
const UNNAMED_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', '']);

function looksLikeImage(mimetype: string, filename: string): boolean {
  const type = mimetype.toLowerCase().trim();
  if (ALLOWED_IMAGE_TYPES.has(type)) return true;
  return UNNAMED_TYPES.has(type) && ALLOWED_EXTENSIONS.test(filename);
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (looksLikeImage(file.mimetype, file.originalname)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          'UNSUPPORTED_FILE_TYPE',
          'That file is not a picture we can read. JPEG, PNG, WebP, HEIC, AVIF, GIF, BMP and TIFF all work.',
          415,
        ),
      );
    }
  },
});

/** Runs multer and maps its errors into the standard envelope. */
const acceptImage: RequestHandler = (req, res, next) => {
  imageUpload.single('image')(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('FILE_TOO_LARGE', 'Image must be 10 MB or smaller', 413)
          : new AppError('UPLOAD_ERROR', err.message, 400),
      );
      return;
    }
    next(err);
  });
};

export const uploadQuery = z.object({
  /** photo (800px cap), document (1600px, for ID legibility) or signature (1200px). */
  kind: z.enum(['photo', 'document', 'signature']).default('photo'),
});

// Upload → returns the URL for the frontend to include in its next form submit.
uploadsRouter.post('/images', acceptImage, validate({ query: uploadQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: z.infer<typeof uploadQuery> }>(req);
  if (!req.file) {
    next(new AppError('VALIDATION_ERROR', 'An "image" file field is required', 400));
    return;
  }
  uploadImage(req.file.buffer, query.kind, req.file.mimetype)
    .then((result) => res.status(201).json(result))
    .catch(next);
});

export const deleteQuery = z.object({
  publicId: z.string().regex(/^yadah\/uploads\/[A-Za-z0-9-]+$/, 'Not an uploaded image id'),
});

// Delete an uploaded image (e.g. user removed it from the form, or replacing).
uploadsRouter.delete('/images', validate({ query: deleteQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: z.infer<typeof deleteQuery> }>(req);
  deleteImage(query.publicId)
    .then(() => res.status(204).end())
    .catch(next);
});
