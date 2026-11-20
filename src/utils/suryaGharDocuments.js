import { getCloudinary } from '../config/cloudinary.js'

export const SURYA_GHAR_FOLDER = 'marvex-energy/surya-ghar'
export const documentConfig = {
  eTokenProof: {
    folder: (employeeId) => `${SURYA_GHAR_FOLDER}/login/${employeeId}/etoken`,
    mimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    formats: 'pdf,jpg,jpeg,png,webp',
    maxBytes: 15 * 1024 * 1024,
  },
  applicationAcknowledgement: {
    folder: (employeeId) => `${SURYA_GHAR_FOLDER}/login/${employeeId}/acknowledgement`,
    mimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    formats: 'pdf,jpg,jpeg,png,webp',
    maxBytes: 15 * 1024 * 1024,
  },
  feasibilityApprovalDocument: {
    folder: (employeeId) => `${SURYA_GHAR_FOLDER}/sanction/${employeeId}/feasibility`,
    mimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    formats: 'pdf,jpg,jpeg,png,webp',
    maxBytes: 15 * 1024 * 1024,
  },
}

export function cloudinaryResourceType(mimeType) {
  return mimeType.startsWith('image/') ? 'image' : 'raw'
}

export async function verifySuryaGharDocument({ publicId, employeeId, documentType, resourceType }) {
  const config = documentConfig[documentType]
  if (!config || typeof publicId !== 'string' || !['image', 'raw'].includes(resourceType)) {
    throw new Error('Invalid Surya Ghar document.')
  }

  const folder = config.folder(String(employeeId))
  const resource = await getCloudinary().api.resource(publicId, { resource_type: resourceType })
  const resourceFolder = resource.asset_folder || resource.folder || ''
  const allowedFolder = resourceFolder === folder || resourceFolder.startsWith(`${folder}/`)
  const format = String(resource.format || '').toLowerCase()

  if (
    resource.resource_type !== resourceType ||
    !allowedFolder ||
    !config.formats.split(',').includes(format) ||
    !resource.secure_url ||
    !Number.isInteger(resource.bytes) ||
    resource.bytes < 1 ||
    resource.bytes > config.maxBytes
  ) {
    throw new Error('Uploaded document failed validation.')
  }

  return {
    secureUrl: resource.secure_url,
    publicId: resource.public_id,
    resourceType,
    deletionStatus: 'PENDING',
  }
}

export async function destroySuryaGharDocument(publicId, resourceType) {
  if (typeof publicId !== 'string' || !publicId.startsWith(`${SURYA_GHAR_FOLDER}/`)) {
    throw new Error('Refusing to delete an asset outside the Surya Ghar document folder.')
  }
  if (!['image', 'raw'].includes(resourceType)) throw new Error('Unsupported Surya Ghar document resource type.')

  const result = await getCloudinary().uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true,
  })
  if (!['ok', 'not found'].includes(result.result)) {
    throw new Error('Cloudinary did not confirm document deletion.')
  }
}
