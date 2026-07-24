import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

// The SDK reads CLOUDINARY_URL from the environment on its own; this just
// makes the dependency explicit and fails loud when it's missing.
const configured = env.CLOUDINARY_URL !== '';
if (configured) {
  cloudinary.config({ secure: true });
}

/**
 * Uploads a customer photo, replacing any previous one (same public_id).
 * Images are capped server-side to 800×800 and metadata is stripped by
 * Cloudinary's incoming transformation.
 */
export async function uploadCustomerPhoto(customerId: string, buffer: Buffer): Promise<string> {
  if (!configured) {
    throw new AppError('PHOTOS_NOT_CONFIGURED', 'Photo storage is not configured', 503);
  }
  const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'yadah/customers',
        public_id: customerId,
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
        transformation: [{ width: 800, height: 800, crop: 'limit' }, { fetch_format: 'auto' }],
      },
      (err, res) => {
        if (err || !res) {
          reject(new AppError('PHOTO_UPLOAD_FAILED', 'Could not store the photo', 502));
          return;
        }
        resolve(res);
      },
    );
    stream.end(buffer);
  });
  return result.secure_url;
}

export async function deleteCustomerPhoto(customerId: string): Promise<void> {
  if (!configured) return;
  await cloudinary.uploader.destroy(`yadah/customers/${customerId}`, { invalidate: true });
}
