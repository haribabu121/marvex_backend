import { Router } from 'express'
import { z } from 'zod'
import AboutContent from '../models/AboutContent.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { writeAuditLog } from '../utils/audit.js'
import { requireAdmin, requireChangedPassword } from '../middleware/auth.js'

const router = Router()
const statisticSchema = z.object({
  _id: z.string().optional(),
  label: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(40),
  description: z.string().trim().max(240).default(''),
  displayOrder: z.number().int().min(0).max(1000),
  isActive: z.boolean(),
})
const contentSchema = z.object({
  heading: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  statistics: z.array(statisticSchema).max(30),
})

function publicContent(content) {
  return {
    heading: content.heading,
    description: content.description,
    statistics: content.statistics
      .filter((statistic) => statistic.isActive)
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map((statistic) => ({
        id: String(statistic._id),
        label: statistic.label,
        value: statistic.value,
        description: statistic.description,
        displayOrder: statistic.displayOrder,
      })),
  }
}

router.get('/about/public', asyncHandler(async (_req, res) => {
  const content = await AboutContent.findOne({ key: 'about' })
  if (!content) {
    return res.status(503).json({ success: false, message: 'About content is not configured.' })
  }
  return res.json({ success: true, data: publicContent(content) })
}))

router.get('/about', requireAdmin, requireChangedPassword, asyncHandler(async (_req, res) => {
  const content = await AboutContent.findOne({ key: 'about' })
  if (!content) {
    return res.status(503).json({ success: false, message: 'About content is not configured.' })
  }
  return res.json({ success: true, data: content })
}))

router.put('/about', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const result = contentSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ success: false, message: 'Check the heading, description, and statistics.' })
  }

  const content = await AboutContent.findOneAndUpdate(
    { key: 'about' },
    {
      $set: {
        heading: result.data.heading,
        description: result.data.description,
        statistics: result.data.statistics.map((statistic) => ({
          ...statistic,
          _id: statistic._id || undefined,
        })),
      },
    },
    { returnDocument: 'after', runValidators: true },
  )

  await writeAuditLog(req, 'about.updated', 'About page performance content was updated.', 'about', content._id)
  return res.json({ success: true, data: content })
}))

export default router
