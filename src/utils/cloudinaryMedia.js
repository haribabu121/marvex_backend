import { getCloudinary } from '../config/cloudinary.js'

const MANAGED_FOLDER = 'marvex-energy/'

export async function destroyManagedAsset(publicId, resourceType) {
  if (!publicId || !publicId.startsWith(MANAGED_FOLDER)) {
    throw new Error('Refusing to delete an asset outside the CMS media folder.')
  }
  if (!['image', 'video'].includes(resourceType)) {
    throw new Error('Unsupported Cloudinary resource type.')
  }

  const result = await getCloudinary().uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true,
  })
  if (!['ok', 'not found'].includes(result.result)) {
    throw new Error('Cloudinary did not confirm asset deletion.')
  }
}
