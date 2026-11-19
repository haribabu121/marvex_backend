import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyTrustedOrigin } from '../src/middleware/auth.js'

function runOriginCheck(origin, method = 'POST') {
  let nextCalled = false
  let statusCode
  let body
  const req = {
    method,
    get: () => origin,
  }
  const res = {
    status(code) {
      statusCode = code
      return this
    },
    json(value) {
      body = value
      return this
    },
  }

  verifyTrustedOrigin(req, res, () => { nextCalled = true })
  return { nextCalled, statusCode, body }
}

test('allows writes from a configured frontend origin', () => {
  const previous = process.env.FRONTEND_URL
  process.env.FRONTEND_URL = 'https://cms.example.com/'
  try {
    assert.equal(runOriginCheck('https://cms.example.com').nextCalled, true)
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_URL
    else process.env.FRONTEND_URL = previous
  }
})

test('rejects writes without an allowed origin', () => {
  const previous = process.env.FRONTEND_URL
  process.env.FRONTEND_URL = 'https://cms.example.com'
  try {
    const result = runOriginCheck('https://unexpected.example.com')
    assert.equal(result.nextCalled, false)
    assert.equal(result.statusCode, 403)
    assert.equal(result.body.success, false)
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_URL
    else process.env.FRONTEND_URL = previous
  }
})

test('does not require an origin for read-only requests', () => {
  const result = runOriginCheck(undefined, 'GET')
  assert.equal(result.nextCalled, true)
})
