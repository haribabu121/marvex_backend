import 'dotenv/config'
import app from './app.js'
import { connectDatabase } from './config/db.js'
import { seedAboutContent, seedAdminAccount } from './routes/authRoutes.js'

const port = Number.parseInt(process.env.PORT || '4000', 10)

function assertEnvironment() {
  const required = [
    'MONGODB_URI',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
    'JWT_ACCESS_SECRET',
    'FRONTEND_URL',
  ]
  const missing = required.filter((key) => !process.env[key])
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }
  if (process.env.JWT_ACCESS_SECRET.length < 32) {
    throw new Error('JWT_ACCESS_SECRET must be at least 32 characters.')
  }
  if (process.env.JWT_ACCESS_SECRET.startsWith('replace-with-')) {
    throw new Error('Replace the JWT_ACCESS_SECRET example value before starting the server.')
  }
  if (process.env.ADMIN_PASSWORD.startsWith('replace-with-')) {
    throw new Error('Replace the ADMIN_PASSWORD example value before starting the server.')
  }
  if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL.startsWith('https://')) {
    throw new Error('FRONTEND_URL must use HTTPS in production.')
  }
}

async function start() {
  assertEnvironment()
  await connectDatabase()
  await seedAdminAccount()
  await seedAboutContent()

  app.listen(port, () => {
    console.log(`CMS API listening on port ${port}.`)
  })
}

start().catch((error) => {
  console.error('CMS API failed to start:', error instanceof Error ? error.message : 'Unknown error')
  process.exitCode = 1
})
