import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin, requireChangedPassword } from '../middleware/auth.js'
import Gallery from '../models/Gallery.js'
import MediaAsset from '../models/MediaAsset.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { writeAuditLog } from '../utils/audit.js'
import { cleanupMediaAsset } from '../utils/cleanupMediaAsset.js'
import HttpError from '../utils/HttpError.js'

const router = Router()
const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  altText: z.string().trim().min(1).max(240),
  mediaAssetId: z.string().min(1),
  displayOrder: z.number().int().min(0).max(10000).default(0),
  isPublished: z.boolean().default(false),
})
const updateSchema = createSchema.partial()

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function findGalleryUpload(id) {
  const asset = await MediaAsset.findById(id)
  if (!asset || asset.assetType !== 'gallery' || asset.resourceType !== 'image') {
    throw new HttpError(400, 'Select a verified gallery image upload.')
  }
  return asset
}

router.get('/public', asyncHandler(async (_req, res) => {
  const items = await Gallery.find({ isPublished: true })
    .sort({ displayOrder: 1, createdAt: 1 })
    .select('title description altText mediaUrl displayOrder')
    .lean()
  return res.json({ success: true, data: items })
}))

router.get('/', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(60, Math.max(1, Number.parseInt(req.query.limit, 10) || 24))
  const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : ''
  const filter = search
    ? { $or: ['title', 'description', 'altText'].map((field) => ({ [field]: new RegExp(escapeRegex(search), 'i') })) }
    : {}
  const [items, total] = await Promise.all([
    Gallery.find(filter).sort({ displayOrder: 1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Gallery.countDocuments(filter),
  ])
  return res.json({ success: true, data: { items, page, limit, total } })
}))

router.post('/', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Enter the image details and choose a verified image upload.' })

  const media = await findGalleryUpload(parsed.data.mediaAssetId)
  const item = await Gallery.create({
    title: parsed.data.title,
    description: parsed.data.description,
    altText: parsed.data.altText,
    mediaUrl: media.url,
    publicId: media.publicId,
    resourceType: 'image',
    format: media.format,
    bytes: media.bytes,
    displayOrder: parsed.data.displayOrder,
    isPublished: parsed.data.isPublished,
  })

  await writeAuditLog(req, 'gallery.created', `Created gallery image "${item.title}".`, 'gallery', item._id)
  return res.status(201).json({ success: true, data: item })
}))

router.put('/:id', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success || Object.keys(parsed.data || {}).length === 0) {
    return res.status(400).json({ success: false, message: 'Provide valid image fields to update.' })
  }

  const item = await Gallery.findById(req.params.id)
  if (!item) return res.status(404).json({ success: false, message: 'Gallery image not found.' })
  const oldPublicId = item.publicId

  for (const field of ['title', 'description', 'altText', 'displayOrder', 'isPublished']) {
    if (parsed.data[field] !== undefined) item[field] = parsed.data[field]
  }
  if (parsed.data.mediaAssetId) {
    const media = await findGalleryUpload(parsed.data.mediaAssetId)
    item.mediaUrl = media.url
    item.publicId = media.publicId
    item.format = media.format
    item.bytes = media.bytes
  }
  await item.save()

  let warning
  if (oldPublicId !== item.publicId) {
    const oldAsset = await MediaAsset.findOne({ publicId: oldPublicId })
    if (oldAsset) {
      try {
        await cleanupMediaAsset(oldAsset.publicId, oldAsset.resourceType)
      } catch (error) {
        warning = 'The previous image could not be removed; retry from Media Library.'
        console.error('CMS gallery cleanup failed:', error instanceof Error ? error.message : 'Unknown error')
      }
    }
  }

  await writeAuditLog(req, 'gallery.updated', `Updated gallery image "${item.title}".`, 'gallery', item._id)
  return res.json({ success: true, data: item, ...(warning ? { warning } : {}) })
}))

router.delete('/:id', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const item = await Gallery.findById(req.params.id)
  if (!item) return res.status(404).json({ success: false, message: 'Gallery image not found.' })

  item.isPublished = false
  await item.save()
  await writeAuditLog(req, 'gallery.unpublished_for_delete', `Unpublished gallery image "${item.title}" before deletion.`, 'gallery', item._id)

  try {
    await cleanupMediaAsset(item.publicId, item.resourceType, { excludeGalleryId: item._id })
  } catch (error) {
    console.error('CMS gallery deletion cleanup failed:', error instanceof Error ? error.message : 'Unknown error')
    throw new HttpError(502, 'The image was unpublished, but Cloudinary cleanup failed. Retry deletion to finish safely.')
  }

  await item.deleteOne()
  await writeAuditLog(req, 'gallery.deleted', `Deleted gallery image "${item.title}".`, 'gallery', item._id)
  return res.json({ success: true, data: null })
}))

export default router
