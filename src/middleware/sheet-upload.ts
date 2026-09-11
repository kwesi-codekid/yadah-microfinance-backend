import type { RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../lib/errors.js';

/**
 * Accepts one spreadsheet in a `file` field, for the bulk importers.
 *
 * Kept in memory: the sheet is read once, checked, and the findings sent
 * back; nothing about it needs to outlive the request. Errors multer raises
 * are folded into the standard envelope so the client sees the same shape it
 * sees from every other refusal.
 */

const SHEET_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const named = /\.(csv|xlsx)$/i.test(file.originalname);
    if (named || SHEET_TYPES.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(
      new AppError(
        'UNSUPPORTED_FILE_TYPE',
        'Upload a .csv or .xlsx sheet — an older .xls must be saved as .xlsx first',
        415,
      ),
    );
  },
});

export const acceptSheet: RequestHandler = (req, res, next) => {
  sheetUpload.single('file')(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('FILE_TOO_LARGE', 'The sheet must be 5 MB or smaller', 413)
          : new AppError('UPLOAD_ERROR', err.message, 400),
      );
      return;
    }
    next(err);
  });
};
