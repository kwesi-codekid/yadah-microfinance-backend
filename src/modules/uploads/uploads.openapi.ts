import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonResponse } from '../../openapi/shared.js';
import { deleteQuery, uploadQuery } from './uploads.routes.js';

const security = [{ bearerAuth: [] }];

export const uploadPaths: ZodOpenApiPathsObject = {
  '/uploads/images': {
    post: {
      tags: ['Uploads'],
      summary: 'Upload an image, get back its URL',
      description:
        'Multipart form with an `image` file field, max 10 MB. JPEG, PNG, WebP, ' +
        'HEIC/HEIF (what an iPhone saves), AVIF, GIF, BMP and TIFF are all accepted; ' +
        'a file whose type the browser could not name is judged by its extension ' +
        'instead. Whatever arrives is stored as JPEG — or PNG, if PNG was sent — so ' +
        'every URL this returns opens in any browser and embeds in a PDF. ' +
        'Returns the hosted URL for the frontend to include in a later form submit ' +
        '(e.g. customer photoUrl / idDocumentFrontUrl / idDocumentBackUrl). ' +
        'Use kind=document for ID scans (higher resolution) and kind=signature for a picture ' +
        'of a signature on a loan application or hire-purchase agreement. Nothing is attached ' +
        'to any record by this call.',
      security,
      requestParams: { query: uploadQuery },
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: z.object({ image: z.string().meta({ format: 'binary' }) }),
          },
        },
      },
      responses: {
        '201': jsonResponse(
          'Uploaded',
          z.object({
            url: z.string().describe('Hosted image URL — submit this in the form'),
            publicId: z.string().describe('Pass to DELETE /uploads/images to remove'),
          }),
        ),
        '413': errorResponse('FILE_TOO_LARGE'),
        '415': errorResponse('UNSUPPORTED_FILE_TYPE'),
      },
    },
    delete: {
      tags: ['Uploads'],
      summary: 'Delete an uploaded image',
      description:
        'Removes an image that was uploaded but discarded (form abandoned, or ' +
        'replaced with a new upload). Only images from the uploads endpoint can ' +
        'be deleted.',
      security,
      requestParams: { query: deleteQuery },
      responses: {
        '204': { description: 'Deleted' },
        '403': errorResponse('FORBIDDEN — not an uploaded image'),
      },
    },
  },
};
