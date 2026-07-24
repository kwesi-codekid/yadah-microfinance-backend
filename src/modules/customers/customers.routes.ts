import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../../lib/errors.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  createCustomerBody,
  customerIdParams,
  listCustomersQuery,
  updateCustomerBody,
  type CreateCustomerBody,
  type CustomerIdParams,
  type ListCustomersQuery,
  type UpdateCustomerBody,
} from './customers.schemas.js';
import * as customersService from './customers.service.js';

export const customersRouter = Router();
customersRouter.use(requireAuth);

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('UNSUPPORTED_FILE_TYPE', 'Photo must be JPEG, PNG, or WebP', 415));
    }
  },
});

/** Runs multer and maps its errors into the standard envelope. */
const acceptPhoto: RequestHandler = (req, res, next) => {
  photoUpload.single('photo')(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('FILE_TOO_LARGE', 'Photo must be 5 MB or smaller', 413)
          : new AppError('UPLOAD_ERROR', err.message, 400),
      );
      return;
    }
    next(err);
  });
};

// All roles create — collectors register in the field, assigned to themselves.
customersRouter.post('/', validate({ body: createCustomerBody }), (req, res, next) => {
  const { body } = getValidated<{ body: CreateCustomerBody }>(req);
  customersService
    .createCustomer(getAuth(req), body, req.id as string)
    .then((customer) => res.status(201).json({ customer }))
    .catch(next);
});

// All roles list — collectors see only their own assigned customers.
customersRouter.get('/', validate({ query: listCustomersQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListCustomersQuery }>(req);
  customersService
    .listCustomers(getAuth(req), query)
    .then((list) => res.json(list))
    .catch(next);
});

customersRouter.get('/:id', validate({ params: customerIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: CustomerIdParams }>(req);
  customersService
    .getCustomer(getAuth(req), params.id)
    .then((customer) => res.json({ customer }))
    .catch(next);
});

customersRouter.patch(
  '/:id',
  requireOffice,
  validate({ params: customerIdParams, body: updateCustomerBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: CustomerIdParams; body: UpdateCustomerBody }>(
      req,
    );
    customersService
      .updateCustomer(getAuth(req), params.id, body, req.id as string)
      .then((customer) => res.json({ customer }))
      .catch(next);
  },
);

// Office or the assigned collector; field "photo" in multipart form data.
customersRouter.post(
  '/:id/photo',
  acceptPhoto,
  validate({ params: customerIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CustomerIdParams }>(req);
    if (!req.file) {
      next(new AppError('VALIDATION_ERROR', 'A "photo" file field is required', 400));
      return;
    }
    customersService
      .setCustomerPhoto(getAuth(req), params.id, req.file.buffer, req.id as string)
      .then((customer) => res.json({ customer }))
      .catch(next);
  },
);

customersRouter.post(
  '/:id/deactivate',
  requireOffice,
  validate({ params: customerIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CustomerIdParams }>(req);
    customersService
      .setCustomerStatus(getAuth(req), params.id, 'inactive', req.id as string)
      .then((customer) => res.json({ customer }))
      .catch(next);
  },
);

customersRouter.post(
  '/:id/activate',
  requireOffice,
  validate({ params: customerIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CustomerIdParams }>(req);
    customersService
      .setCustomerStatus(getAuth(req), params.id, 'active', req.id as string)
      .then((customer) => res.json({ customer }))
      .catch(next);
  },
);
