import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'
import AdminUser from '../models/AdminUser.js'
import RefreshSession from '../models/RefreshSession.js'

const ACCESS_COOKIE = 'marvex_access'
const REFRESH_COOKIE = 'marvex_refresh'
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000

function getCookieOptions(path, maxAge) {
  const isProduction = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path,
    maxAge,
  }
}

function getAccessSecret() {
  const secret = process.env.JWT_ACCESS_SECRET
  if (!secret) throw new Error('JWT_ACCESS_SECRET is required.')
  return secret
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function safeHashEquals(left, right) {
  const leftBuffer = Buffer.from(left || '')
  const rightBuffer = Buffer.from(right || '')
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function signAccessToken(adminId, sessionId) {
  return jwt.sign(
    { sub: String(adminId), sid: String(sessionId), type: 'access' },
    getAccessSecret(),
    { expiresIn: '15m', issuer: 'marvex-energy-cms' },
  )
}

async function createSession(adminId) {
  const rawToken = randomBytes(48).toString('base64url')
  const session = await RefreshSession.create({
    adminId,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
  })
  return { session, rawToken }
}

export async function issueAdminSession(res, adminId) {
  const { session, rawToken } = await createSession(adminId)
  const accessToken = signAccessToken(adminId, session._id)
  res.cookie(ACCESS_COOKIE, accessToken, getCookieOptions('/api/cms', 15 * 60 * 1000))
  res.cookie(
    REFRESH_COOKIE,
    `${session._id}.${rawToken}`,
    getCookieOptions('/api/cms/auth', SESSION_DURATION_MS),
  )
}

export async function rotateAdminSession(req, res) {
  const cookie = req.cookies?.[REFRESH_COOKIE] || ''
  const separator = cookie.indexOf('.')
  if (separator <= 0) return null

  const sessionId = cookie.slice(0, separator)
  const rawToken = cookie.slice(separator + 1)
  const session = await RefreshSession.findOne({
    _id: sessionId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
  if (!session || !safeHashEquals(session.tokenHash, hashToken(rawToken))) return null

  const admin = await AdminUser.findById(session.adminId)
  if (!admin?.isActive) return null

  const revoked = await RefreshSession.updateOne(
    { _id: session._id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  )
  if (!revoked.modifiedCount) return null

  await issueAdminSession(res, admin._id)
  return admin
}

export function clearAdminCookies(res) {
  res.clearCookie(ACCESS_COOKIE, getCookieOptions('/api/cms', 0))
  res.clearCookie(REFRESH_COOKIE, getCookieOptions('/api/cms/auth', 0))
}

export async function revokeRefreshCookie(req) {
  const cookie = req.cookies?.[REFRESH_COOKIE] || ''
  const separator = cookie.indexOf('.')
  if (separator <= 0) return

  await RefreshSession.updateOne(
    { _id: cookie.slice(0, separator), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  )
}

export async function requireAdmin(req, res, next) {
  try {
    const token = req.cookies?.[ACCESS_COOKIE]
    if (!token) return res.status(401).json({ success: false, message: 'Sign in required.' })

    const payload = jwt.verify(token, getAccessSecret(), {
      issuer: 'marvex-energy-cms',
    })
    if (payload.type !== 'access' || !payload.sub || !payload.sid) {
      return res.status(401).json({ success: false, message: 'Session is invalid.' })
    }

    const [session, admin] = await Promise.all([
      RefreshSession.findOne({
        _id: payload.sid,
        adminId: payload.sub,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }),
      AdminUser.findById(payload.sub),
    ])

    if (!session || !admin?.isActive) {
      return res.status(401).json({ success: false, message: 'Session is no longer active.' })
    }

    req.admin = admin
    req.adminSession = session
    return next()
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ success: false, message: 'Session has expired.' })
    }
    return next(error)
  }
}

export function requireChangedPassword(req, res, next) {
  if (req.admin.mustChangePassword) {
    return res.status(403).json({
      success: false,
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'Change the initial administrator password to continue.',
    })
  }
  return next()
}

export function verifyTrustedOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()

  const origin = req.get('origin')?.replace(/\/+$/, '')
  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean)

  if (!origin || !allowedOrigins.includes(origin)) {
    return res.status(403).json({ success: false, message: 'Request origin is not allowed.' })
  }
  return next()
}

export { hashToken }
