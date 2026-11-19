import { Router } from 'express'
import ActivityLog from '../models/ActivityLog.js'
import { requireAdmin, requireChangedPassword } from '../middleware/auth.js'
import { asyncHandler } from '../utils/asyncHandler.js'

const router = Router()

router.get('/', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25))
  const [items, total] = await Promise.all([
    ActivityLog.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('adminId', 'name email')
      .lean(),
    ActivityLog.countDocuments(),
  ])
  return res.json({ success: true, data: { items, page, limit, total } })
}))

export default router
