import { randomUUID } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

// The SDK reads CLOUDINARY_URL from the environment on its own; this just
// makes the dependency explicit and fails loud when it's missing.
const configured = env.CLOUDINARY_URL !== '';
if (configured) {
  cloudinary.config({ secure: true });
}

const UPLOAD_FOLDER = 'yadah/uploads';

export interface UploadedImage {
  url: string;
  publicId: string;
}

export type UploadKind = 'photo' | 'document' | 'signature';

/**
 * What the stored image is written as, whatever format arrived.
 *
 * The door accepts what phones produce — HEIC from an iPhone, AVIF from a
 * recent Android — and neither of those renders in Chrome or Firefox, nor in
 * pdfkit, which the registration form embeds a photo with. Rather than leave
 * every screen and document to cope, the format is settled once, here: what
 * comes back from this function is always a picture anything can open.
 *
 * PNG is the one format kept as it arrived. It carries transparency, which
 * JPEG would flatten to a block of colour behind a signature, and it stays
 * lossless, which is what keeps the small print on an ID scan readable.
 */
function storedFormat(mimetype: string): 'png' | 'jpg' {
  return mimetype.toLowerCase().trim() === 'image/png' ? 'png' : 'jpg';
}

/**
 * Uploads an image and returns its URL + public id. The frontend includes
 * the URL in whatever form it submits next (customer create/update);
 * nothing in the DB is touched here. `kind` controls the size cap:
 * documents keep more detail for legibility.
 */
export async function uploadImage(
  buffer: Buffer,
  kind: UploadKind = 'photo',
  mimetype = 'image/jpeg',
): Promise<UploadedImage> {
  if (!configured) {
    throw new AppError('PHOTOS_NOT_CONFIGURED', 'Photo storage is not configured', 503);
  }
  // A portrait needs little; an ID must stay legible; a signature sits between.
  const max = kind === 'photo' ? 800 : kind === 'signature' ? 1200 : 1600;
  const format = storedFormat(mimetype);
  const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: UPLOAD_FOLDER,
        public_id: randomUUID(),
        resource_type: 'image',
        // Settled rather than negotiated: `fetch_format: 'auto'` is a delivery
        // parameter, and asking for it on the way IN left the stored format up
        // to whatever was sent. `format` is what actually decides it.
        format,
        transformation: [
          { width: max, height: max, crop: 'limit' },
          // JPEG only. On a PNG the same setting is free to drop the image to
          // a palette, which is the detail an ID scan was kept lossless for.
          ...(format === 'jpg' ? [{ quality: 'auto:good' }] : []),
        ],
      },
      (err, res) => {
        if (err || !res) {
          reject(new AppError('PHOTO_UPLOAD_FAILED', 'Could not store the image', 502));
          return;
        }
        resolve(res);
      },
    );
    stream.end(buffer);
  });
  return { url: result.secure_url, publicId: result.public_id };
}

/** Deletes an uploaded image. Only assets in the uploads folder can be deleted. */
export async function deleteImage(publicId: string): Promise<void> {
  if (!configured) {
    throw new AppError('PHOTOS_NOT_CONFIGURED', 'Photo storage is not configured', 503);
  }
  if (!publicId.startsWith(`${UPLOAD_FOLDER}/`)) {
    throw new AppError('FORBIDDEN', 'Only uploaded images can be deleted', 403);
  }
  await cloudinary.uploader.destroy(publicId, { invalidate: true });
}
