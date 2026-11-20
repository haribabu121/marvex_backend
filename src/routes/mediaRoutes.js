import { Router } from 'express'
import { z } from 'zod'
import { getCloudinary, isCloudinaryConfigured } from '../config/cloudinary.js'
import { requireAdmin, requireChangedPassword } from '../middleware/auth.js'
import Carousel from '../models/Carousel.js'
import Gallery from '../models/Gallery.js'
import MediaAsset from '../models/MediaAsset.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { writeAuditLog } from '../utils/audit.js'
import { destroyManagedAsset } from '../utils/cloudinaryMedia.js'

const router = Router()
const assetTypes = {
  carousel: {
    folder: 'marvex-energy/videos',
    resourceType: 'video',
    formats: 'mp4,mov,webm,m4v',
    maxBytes: 100 * 1024 * 1024,
    mimeTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'],
  },
  thumbnail: {
    folder: 'marvex-energy/thumbnails',
    resourceType: 'image',
    formats: 'jpg,jpeg,png,webp,avif',
    maxBytes: 15 * 1024 * 1024,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
  },
  gallery: {
    folder: 'marvex-energy/gallery',
    resourceType: 'image',
    formats: 'jpg,jpeg,png,webp,avif',
    maxBytes: 15 * 1024 * 1024,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
  },
}

const signatureSchema = z.object({
  assetType: z.enum(['carousel', 'thumbnail', 'gallery']),
  mimeType: z.string().min(1).max(100),
  bytes: z.number().int().positive(),
})
const completeSchema = z.object({
  assetType: z.enum(['carousel', 'thumbnail', 'gallery']),
  publicId: z.string().min(1).max(240),
  resourceType: z.enum(['image', 'video']),
})

router.post('/upload/signature', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const parsed = signatureSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Select a supported media file.' })
  }
  if (!isCloudinaryConfigured()) {
    return res.status(503).json({ success: false, message: 'Media storage is not configured.' })
  }

  const config = assetTypes[parsed.data.assetType]
  if (!config.mimeTypes.includes(parsed.data.mimeType) || parsed.data.bytes > config.maxBytes) {
    return res.status(400).json({ success: false, message: 'File type or size is not allowed.' })
  }

  const timestamp = Math.floor(Date.now() / 1000)
  const allowedFormats = config.formats
  const signature = getCloudinary().utils.api_sign_request(
    { timestamp, folder: config.folder, allowed_formats: allowedFormats },
    process.env.CLOUDINARY_API_SECRET,
  )

  return res.json({
    success: true,
    data: {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      timestamp,
      signature,
      folder: config.folder,
      allowedFormats,
      resourceType: config.resourceType,
      assetType: parsed.data.assetType,
    },
  })
}))

router.post('/upload/complete', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const parsed = completeSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid uploaded media details.' })
  }
  if (!isCloudinaryConfigured()) {
    return res.status(503).json({ success: false, message: 'Media storage is not configured.' })
  }

  const config = assetTypes[parsed.data.assetType]
  if (config.resourceType !== parsed.data.resourceType) {
    return res.status(400).json({ success: false, message: 'Uploaded media type does not match the request.' })
  }

  const cloudinary = getCloudinary()
  const resource = await cloudinary.api.resource(parsed.data.publicId, {
    resource_type: config.resourceType,
  })
  const resourceFolder = resource.asset_folder || resource.folder || ''
  const allowedResourceFolder = resourceFolder === config.folder
    || resourceFolder.startsWith(`${config.folder}/`)
  if (
    resource.resource_type !== config.resourceType ||
    !allowedResourceFolder ||
    !config.formats.split(',').includes(String(resource.format).toLowerCase()) ||
    !resource.secure_url ||
    !Number.isInteger(resource.bytes) ||
    resource.bytes < 1 ||
    resource.bytes > config.maxBytes
  ) {
    await destroyManagedAsset(parsed.data.publicId, config.resourceType)
    return res.status(400).json({ success: false, message: 'Uploaded media failed validation.' })
  }

  const mediaAsset = await MediaAsset.findOneAndUpdate(
    { publicId: resource.public_id },
    {
      $set: {
        url: resource.secure_url,
        resourceType: resource.resource_type,
        format: resource.format,
        bytes: resource.bytes,
        assetType: parsed.data.assetType,
        uploadedBy: req.admin._id,
      },
    },
    { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true },
  )

  await writeAuditLog(req, 'media.uploaded', `Uploaded ${parsed.data.assetType} media.`, 'media', mediaAsset._id)
  return res.status(201).json({ success: true, data: mediaAsset })
}))

router.get('/media', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(60, Math.max(1, Number.parseInt(req.query.limit, 10) || 24))
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
  const filter = search
    ? { $or: [{ publicId: new RegExp(escapeRegex(search), 'i') }, { format: new RegExp(escapeRegex(search), 'i') }] }
    : {}
  const [items, total] = await Promise.all([
    MediaAsset.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    MediaAsset.countDocuments(filter),
  ])
  return res.json({ success: true, data: { items, page, limit, total } })
}))

router.delete('/media/:id', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const mediaAsset = await MediaAsset.findById(req.params.id)
  if (!mediaAsset) return res.status(404).json({ success: false, message: 'Media item not found.' })

  const [usedByCarousel, usedAsThumbnail, usedByGallery] = await Promise.all([
    Carousel.exists({ publicId: mediaAsset.publicId }),
    Carousel.exists({ thumbnailPublicId: mediaAsset.publicId }),
    Gallery.exists({ publicId: mediaAsset.publicId }),
  ])
  if (usedByCarousel || usedAsThumbnail || usedByGallery) {
    return res.status(409).json({ success: false, message: 'This media item is in use. Remove it from its content first.' })
  }

  await destroyManagedAsset(mediaAsset.publicId, mediaAsset.resourceType)
  await mediaAsset.deleteOne()
  await writeAuditLog(req, 'media.deleted', 'Deleted an unused media asset.', 'media', mediaAsset._id)
  return res.json({ success: true, data: null })
}))

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default router
