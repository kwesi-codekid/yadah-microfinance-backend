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
 * Uploads a customer image (profile photo or ID document scan), replacing
 * any previous one (same public_id). Photos are capped to 800×800; ID
 * documents keep more detail at 1600×1600 for legibility.
 */
export async function uploadCustomerImage(
  customerId: string,
  buffer: Buffer,
  kind: 'photo' | 'id-document' = 'photo',
): Promise<string> {
  if (!configured) {
    throw new AppError('PHOTOS_NOT_CONFIGURED', 'Photo storage is not configured', 503);
  }
  const max = kind === 'photo' ? 800 : 1600;
  const publicId = kind === 'photo' ? customerId : `${customerId}-id`;
  const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'yadah/customers',
        public_id: publicId,
        overwrite: true,
        invalidate: true,
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
  return result.secure_url;
}

export async function deleteCustomerImages(customerId: string): Promise<void> {
  if (!configured) return;
  await cloudinary.uploader.destroy(`yadah/customers/${customerId}`, { invalidate: true });
  await cloudinary.uploader.destroy(`yadah/customers/${customerId}-id`, { invalidate: true });
}
