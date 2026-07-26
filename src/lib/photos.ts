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

/**
 * Uploads an image and returns its URL + public id. The frontend includes
 * the URL in whatever form it submits next (customer create/update);
 * nothing in the DB is touched here. `kind` controls the size cap:
 * documents keep more detail for legibility.
 */
export async function uploadImage(
  buffer: Buffer,
  kind: 'photo' | 'document' = 'photo',
): Promise<UploadedImage> {
  if (!configured) {
    throw new AppError('PHOTOS_NOT_CONFIGURED', 'Photo storage is not configured', 503);
  }
  const max = kind === 'photo' ? 800 : 1600;
  const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: UPLOAD_FOLDER,
        public_id: randomUUID(),
        resource_type: 'image',
        transformation: [{ width: max, height: max, crop: 'limit' }, { fetch_format: 'auto' }],
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
