import cors from 'cors'
import cookieParser from 'cookie-parser'
import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import { verifyTrustedOrigin } from './middleware/auth.js'
import aboutRoutes from './routes/aboutRoutes.js'
import activityRoutes from './routes/activityRoutes.js'
import authRoutes from './routes/authRoutes.js'
import carouselRoutes from './routes/carouselRoutes.js'
import dashboardRoutes from './routes/dashboardRoutes.js'
import galleryRoutes from './routes/galleryRoutes.js'
import mediaRoutes from './routes/mediaRoutes.js'
import HttpError from './utils/HttpError.js'

const app = express()
const frontendOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean)

app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false)
app.disable('x-powered-by')
app.use(helmet())
app.use(cors({
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  origin(origin, callback) {
    if (!origin || frontendOrigins.includes(origin.replace(/\/+$/, ''))) return callback(null, true)
    return callback(new HttpError(403, 'This origin is not allowed.'))
  },
}))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use(verifyTrustedOrigin)

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    success: false,
    message: 'Too many sign-in attempts. Try again in 15 minutes.',
  }),
})

app.get('/health', (_req, res) => res.json({ success: true, status: 'ok' }))
app.use('/api/cms/auth', (req, res, next) => (
  req.path === '/login' ? loginLimiter(req, res, next) : next()
), authRoutes)
app.use('/api/cms', aboutRoutes)
app.use('/api/cms/dashboard', dashboardRoutes)
app.use('/api/cms/activity-logs', activityRoutes)
app.use('/api/cms/carousels', carouselRoutes)
app.use('/api/cms/gallery', galleryRoutes)
app.use('/api/cms', mediaRoutes)

app.use((_req, res) => res.status(404).json({ success: false, message: 'API route not found.' }))

app.use((error, _req, res, _next) => {
  let status = error instanceof HttpError ? error.status : 500
  if (error.code === 11000) status = 409
  if (error.name === 'ValidationError' || error.name === 'CastError') status = 400
  if (error.type === 'entity.parse.failed') status = 400
  if (error.type === 'entity.too.large') status = 413
  if (status >= 500) {
    console.error('CMS API error:', {
      name: error.name,
      code: error.code,
      message: error.message,
    })
  }
  const message = status >= 500
    ? 'An unexpected server error occurred.'
    : error.message
  return res.status(status).json({ success: false, message })
})

export default app
