import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { deleteImage, uploadImage } from '../../lib/photos.js';
import { requireAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('UNSUPPORTED_FILE_TYPE', 'Image must be JPEG, PNG, or WebP', 415));
    }
  },
});

/** Runs multer and maps its errors into the standard envelope. */
const acceptImage: RequestHandler = (req, res, next) => {
  imageUpload.single('image')(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('FILE_TOO_LARGE', 'Image must be 5 MB or smaller', 413)
          : new AppError('UPLOAD_ERROR', err.message, 400),
      );
      return;
    }
    next(err);
  });
};

export const uploadQuery = z.object({
  /** photo (800px cap) or document (1600px, for ID legibility). */
  kind: z.enum(['photo', 'document']).default('photo'),
});

// Upload → returns the URL for the frontend to include in its next form submit.
uploadsRouter.post('/images', acceptImage, validate({ query: uploadQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: z.infer<typeof uploadQuery> }>(req);
  if (!req.file) {
    next(new AppError('VALIDATION_ERROR', 'An "image" file field is required', 400));
    return;
  }
  uploadImage(req.file.buffer, query.kind)
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
