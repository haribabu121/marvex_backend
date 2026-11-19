import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin, requireChangedPassword } from '../middleware/auth.js'
import Carousel from '../models/Carousel.js'
import MediaAsset from '../models/MediaAsset.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { writeAuditLog } from '../utils/audit.js'
import { cleanupMediaAsset } from '../utils/cleanupMediaAsset.js'
import HttpError from '../utils/HttpError.js'

const router = Router()
const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  mediaAssetId: z.string().min(1),
  thumbnailAssetId: z.string().min(1).optional().or(z.literal('')),
  category: z.string().trim().min(1).max(80),
  displayOrder: z.number().int().min(0).max(10000).default(0),
  isPublished: z.boolean().default(false),
})
const updateSchema = createSchema.partial().extend({
  mediaAssetId: z.string().min(1).optional(),
  thumbnailAssetId: z.string().min(1).optional().or(z.literal('')),
})

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function findUpload(id, assetType, resourceType) {
  if (!id) return null
  const asset = await MediaAsset.findById(id)
  if (!asset || asset.assetType !== assetType || asset.resourceType !== resourceType) {
    throw new HttpError(400, 'Select a verified upload of the correct type.')
  }
  return asset
}

router.get('/public', asyncHandler(async (_req, res) => {
  const items = await Carousel.find({ isPublished: true })
    .sort({ displayOrder: 1, createdAt: 1 })
    .select('title description mediaUrl thumbnailUrl category displayOrder')
    .lean()
  return res.json({ success: true, data: items })
}))

router.get('/', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 10))
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
  const filter = search
    ? { $or: ['title', 'description', 'category'].map((field) => ({ [field]: new RegExp(escapeRegex(search), 'i') })) }
    : {}
  const [items, total] = await Promise.all([
    Carousel.find(filter).sort({ displayOrder: 1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Carousel.countDocuments(filter),
  ])
  return res.json({ success: true, data: { items, page, limit, total } })
}))

router.post('/', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Enter the video details and choose a verified video upload.' })

  const media = await findUpload(parsed.data.mediaAssetId, 'carousel', 'video')
  const thumbnail = await findUpload(parsed.data.thumbnailAssetId, 'thumbnail', 'image')
  const item = await Carousel.create({
    title: parsed.data.title,
    description: parsed.data.description,
    mediaUrl: media.url,
    publicId: media.publicId,
    resourceType: 'video',
    format: media.format,
    bytes: media.bytes,
    thumbnailUrl: thumbnail?.url || '',
    thumbnailPublicId: thumbnail?.publicId || '',
    category: parsed.data.category,
    displayOrder: parsed.data.displayOrder,
    isPublished: parsed.data.isPublished,
  })

  await writeAuditLog(req, 'carousel.created', `Created carousel video "${item.title}".`, 'carousel', item._id)
  return res.status(201).json({ success: true, data: item })
}))

router.put('/:id', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success || Object.keys(parsed.data || {}).length === 0) {
    return res.status(400).json({ success: false, message: 'Provide valid video fields to update.' })
  }

  const item = await Carousel.findById(req.params.id)
  if (!item) return res.status(404).json({ success: false, message: 'Carousel video not found.' })

  const oldMedia = { publicId: item.publicId, resourceType: item.resourceType }
  const oldThumbnail = { publicId: item.thumbnailPublicId, resourceType: 'image' }
  const changes = parsed.data

  for (const field of ['title', 'description', 'category', 'displayOrder', 'isPublished']) {
    if (changes[field] !== undefined) item[field] = changes[field]
  }
  if (changes.mediaAssetId) {
    const media = await findUpload(changes.mediaAssetId, 'carousel', 'video')
    item.mediaUrl = media.url
    item.publicId = media.publicId
    item.resourceType = media.resourceType
    item.format = media.format
    item.bytes = media.bytes
  }
  if (changes.thumbnailAssetId !== undefined) {
    const thumbnail = await findUpload(changes.thumbnailAssetId, 'thumbnail', 'image')
    item.thumbnailUrl = thumbnail?.url || ''
    item.thumbnailPublicId = thumbnail?.publicId || ''
  }
  await item.save()

  const cleanupWarnings = []
  for (const [asset, replaced] of [
    [oldMedia, oldMedia.publicId !== item.publicId],
    [oldThumbnail, oldThumbnail.publicId !== item.thumbnailPublicId],
  ]) {
    if (!replaced || !asset.publicId) continue
    try {
      await cleanupMediaAsset(asset.publicId, asset.resourceType)
    } catch (error) {
      cleanupWarnings.push('An older media file could not be removed; retry from Media Library.')
      console.error('CMS media cleanup failed:', error instanceof Error ? error.message : 'Unknown error')
    }
  }

  await writeAuditLog(req, 'carousel.updated', `Updated carousel video "${item.title}".`, 'carousel', item._id)
  return res.json({
    success: true,
    data: item,
    ...(cleanupWarnings.length ? { warning: cleanupWarnings[0] } : {}),
  })
}))

router.delete('/:id', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const item = await Carousel.findById(req.params.id)
  if (!item) return res.status(404).json({ success: false, message: 'Carousel video not found.' })

  item.isPublished = false
  await item.save()
  await writeAuditLog(req, 'carousel.unpublished_for_delete', `Unpublished carousel video "${item.title}" before deletion.`, 'carousel', item._id)

  try {
    await cleanupMediaAsset(item.publicId, item.resourceType, { excludeCarouselId: item._id })
    await cleanupMediaAsset(item.thumbnailPublicId, 'image', { excludeCarouselId: item._id })
  } catch (error) {
    console.error('CMS carousel deletion cleanup failed:', error instanceof Error ? error.message : 'Unknown error')
    throw new HttpError(502, 'The video was unpublished, but Cloudinary cleanup failed. Retry deletion to finish safely.')
  }

  await item.deleteOne()
  await writeAuditLog(req, 'carousel.deleted', `Deleted carousel video "${item.title}".`, 'carousel', item._id)
  return res.json({ success: true, data: null })
}))

export default router
