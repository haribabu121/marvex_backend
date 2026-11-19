import { Router } from 'express'
import AboutContent from '../models/AboutContent.js'
import ActivityLog from '../models/ActivityLog.js'
import Carousel from '../models/Carousel.js'
import Gallery from '../models/Gallery.js'
import MediaAsset from '../models/MediaAsset.js'
import { requireAdmin, requireChangedPassword } from '../middleware/auth.js'
import { asyncHandler } from '../utils/asyncHandler.js'

const router = Router()

router.get('/', requireAdmin, requireChangedPassword, asyncHandler(async (_req, res) => {
  const [about, carouselCount, publishedCarouselCount, galleryCount, publishedGalleryCount, mediaCount, recentActivity] =
    await Promise.all([
      AboutContent.findOne({ key: 'about' }).select('statistics'),
      Carousel.countDocuments(),
      Carousel.countDocuments({ isPublished: true }),
      Gallery.countDocuments(),
      Gallery.countDocuments({ isPublished: true }),
      MediaAsset.countDocuments(),
      ActivityLog.find().sort({ createdAt: -1 }).limit(8).populate('adminId', 'name email').lean(),
    ])

  return res.json({
    success: true,
    data: {
      statisticsCount: about?.statistics.length || 0,
      carouselCount,
      publishedCarouselCount,
      galleryCount,
      publishedGalleryCount,
      mediaCount,
      recentActivity,
    },
  })
}))

export default router
