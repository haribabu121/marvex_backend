import argon2 from 'argon2'
import { Router } from 'express'
import { z } from 'zod'
import AdminUser from '../models/AdminUser.js'
import AboutContent from '../models/AboutContent.js'
import RefreshSession from '../models/RefreshSession.js'
import { getCloudinary, isCloudinaryConfigured } from '../config/cloudinary.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { writeAuditLog } from '../utils/audit.js'
import { destroyManagedAsset } from '../utils/cloudinaryMedia.js'
import {
  clearAdminCookies,
  issueAdminSession,
  requireAdmin,
  requireChangedPassword,
  revokeRefreshCookie,
  rotateAdminSession,
} from '../middleware/auth.js'

const router = Router()
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
})
const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12).max(200),
})
const avatarFormats = 'jpg,jpeg,png,webp,avif'
const avatarMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
const avatarMaxBytes = 5 * 1024 * 1024
const avatarSignatureSchema = z.object({
  mimeType: z.string().min(1).max(100),
  bytes: z.number().int().positive(),
})
const avatarCompleteSchema = z.object({
  publicId: z.string().min(1).max(240),
})

function serializeAdmin(admin) {
  return {
    id: String(admin._id),
    name: admin.name,
    email: admin.email,
    avatarUrl: admin.avatarUrl || null,
    mustChangePassword: admin.mustChangePassword,
  }
}

router.post('/login', asyncHandler(async (req, res) => {
  const result = loginSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({ success: false, message: 'Enter a valid email and password.' })
  }

  const email = result.data.email.toLowerCase()
  const admin = await AdminUser.findOne({ email }).select('+passwordHash')
  if (!admin?.isActive) {
    return res.status(401).json({ success: false, message: 'Email or password is incorrect.' })
  }

  if (admin.lockUntil && admin.lockUntil > new Date()) {
    return res.status(423).json({
      success: false,
      message: 'Sign-in is temporarily locked. Try again later.',
    })
  }

  const passwordMatches = await argon2.verify(admin.passwordHash, result.data.password)
  if (!passwordMatches) {
    admin.failedLoginCount += 1
    if (admin.failedLoginCount >= 5) {
      admin.failedLoginCount = 0
      admin.lockUntil = new Date(Date.now() + 15 * 60 * 1000)
    }
    await admin.save()
    return res.status(401).json({ success: false, message: 'Email or password is incorrect.' })
  }

  admin.failedLoginCount = 0
  admin.lockUntil = null
  admin.lastLoginAt = new Date()
  await admin.save()
  await issueAdminSession(res, admin._id)
  req.admin = admin
  await writeAuditLog(req, 'admin.login', 'Administrator signed in.', 'admin', admin._id)

  return res.json({
    success: true,
    data: serializeAdmin(admin),
  })
}))

router.post('/refresh', asyncHandler(async (req, res) => {
  const admin = await rotateAdminSession(req, res)
  if (!admin) {
    clearAdminCookies(res)
    return res.status(401).json({ success: false, message: 'Session has expired. Sign in again.' })
  }

  return res.json({
    success: true,
    data: serializeAdmin(admin),
  })
}))

router.post('/logout', requireAdmin, asyncHandler(async (req, res) => {
  await revokeRefreshCookie(req)
  await RefreshSession.updateOne(
    { _id: req.adminSession._id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  )
  await writeAuditLog(req, 'admin.logout', 'Administrator signed out.', 'admin', req.admin._id)
  clearAdminCookies(res)
  return res.json({ success: true, data: null })
}))

router.get('/me', requireAdmin, (req, res) => res.json({
  success: true,
  data: serializeAdmin(req.admin),
}))

router.post('/avatar/signature', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const parsed = avatarSignatureSchema.safeParse(req.body)
  if (!parsed.success || !avatarMimeTypes.includes(parsed.data?.mimeType) || parsed.data.bytes > avatarMaxBytes) {
    return res.status(400).json({
      success: false,
      message: 'Choose a JPEG, PNG, WebP or AVIF profile image no larger than 5 MB.',
    })
  }
  if (!isCloudinaryConfigured()) {
    return res.status(503).json({ success: false, message: 'Media storage is not configured.' })
  }

  const folder = `marvex-energy/admin-avatars/${req.admin._id}`
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = getCloudinary().utils.api_sign_request(
    { timestamp, folder, allowed_formats: avatarFormats },
    process.env.CLOUDINARY_API_SECRET,
  )

  return res.json({
    success: true,
    data: {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      timestamp,
      signature,
      folder,
      allowedFormats: avatarFormats,
      resourceType: 'image',
    },
  })
}))

router.post('/avatar/complete', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const parsed = avatarCompleteSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid profile image details.' })
  }
  if (!isCloudinaryConfigured()) {
    return res.status(503).json({ success: false, message: 'Media storage is not configured.' })
  }

  const folder = `marvex-energy/admin-avatars/${req.admin._id}`
  const resource = await getCloudinary().api.resource(parsed.data.publicId, { resource_type: 'image' })
  const resourcePublicId = typeof resource.public_id === 'string' ? resource.public_id : ''
  const resourceFolder = resource.asset_folder || resource.folder || ''
  const belongsToAdmin = resourcePublicId.startsWith(`${folder}/`)
    && (resourceFolder === folder || resourceFolder.startsWith(`${folder}/`))
  if (!belongsToAdmin) {
    return res.status(400).json({ success: false, message: 'Uploaded profile image is not in your profile folder.' })
  }

  if (
    resource.resource_type !== 'image' ||
    !avatarFormats.split(',').includes(String(resource.format).toLowerCase()) ||
    !resource.secure_url ||
    !Number.isInteger(resource.bytes) ||
    resource.bytes < 1 ||
    resource.bytes > avatarMaxBytes
  ) {
    await destroyManagedAsset(resourcePublicId, 'image')
    return res.status(400).json({ success: false, message: 'Uploaded profile image failed validation.' })
  }

  const previousPublicId = req.admin.avatarPublicId
  req.admin.avatarUrl = resource.secure_url
  req.admin.avatarPublicId = resourcePublicId
  await req.admin.save()
  await writeAuditLog(req, 'admin.avatar_updated', 'Administrator profile photo was updated.', 'admin', req.admin._id)

  let warning
  if (previousPublicId && previousPublicId !== resourcePublicId) {
    try {
      await destroyManagedAsset(previousPublicId, 'image')
    } catch (cleanupError) {
      console.error('CMS profile image cleanup failed:', cleanupError.message)
      warning = 'Profile photo changed, but the previous photo could not be removed.'
    }
  }

  return res.json({ success: true, data: serializeAdmin(req.admin), ...(warning ? { warning } : {}) })
}))

router.delete('/avatar', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  if (!req.admin.avatarPublicId && !req.admin.avatarUrl) {
    return res.json({ success: true, data: serializeAdmin(req.admin) })
  }

  if (req.admin.avatarPublicId) await destroyManagedAsset(req.admin.avatarPublicId, 'image')
  req.admin.avatarUrl = null
  req.admin.avatarPublicId = null
  await req.admin.save()
  await writeAuditLog(req, 'admin.avatar_deleted', 'Administrator profile photo was deleted.', 'admin', req.admin._id)
  return res.json({ success: true, data: serializeAdmin(req.admin) })
}))

router.post('/change-password', requireAdmin, asyncHandler(async (req, res) => {
  const result = passwordSchema.safeParse(req.body)
  if (!result.success) {
    return res.status(400).json({
      success: false,
      message: 'Use a new password with at least 12 characters.',
    })
  }

  const admin = await AdminUser.findById(req.admin._id).select('+passwordHash')
  const currentMatches = await argon2.verify(admin.passwordHash, result.data.currentPassword)
  if (!currentMatches) {
    return res.status(400).json({ success: false, message: 'Current password is incorrect.' })
  }

  admin.passwordHash = await argon2.hash(result.data.newPassword, { type: argon2.argon2id })
  admin.mustChangePassword = false
  await admin.save()
  await RefreshSession.updateMany(
    { adminId: admin._id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  )
  await writeAuditLog(req, 'admin.password_changed', 'Administrator password was changed.', 'admin', admin._id)
  clearAdminCookies(res)
  return res.json({ success: true, data: { signedOut: true } })
}))

export async function seedAdminAccount() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD
  if (!email || !password || password.length < 12) {
    throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.')
  }

  const existingAdmin = await AdminUser.findOne({ role: 'admin' })
  if (existingAdmin) return

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
  await AdminUser.create({
    name: process.env.ADMIN_NAME?.trim() || 'Marvex CMS Admin',
    email,
    passwordHash,
    role: 'admin',
    mustChangePassword: true,
  })
}

export async function seedAboutContent() {
  await AboutContent.updateOne(
    { key: 'about' },
    {
      $setOnInsert: {
        heading: 'Verified Performance',
        description: 'Reliable execution nationwide',
        statistics: [
          {
            label: 'rooftop solar installations',
            value: '500+',
            description: 'Successful rooftop solar installations',
            isActive: true,
            displayOrder: 0,
          },
          {
            label: 'support response time',
            value: '< 2 hrs',
            description: 'Average support response time',
            isActive: true,
            displayOrder: 1,
          },
          {
            label: 'performance warranty',
            value: '25 yrs',
            description: 'Solar performance warranty',
            isActive: true,
            displayOrder: 2,
          },
        ],
      },
    },
    { upsert: true },
  )
}

export default router
