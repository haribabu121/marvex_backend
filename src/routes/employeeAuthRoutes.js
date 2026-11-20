import argon2 from 'argon2'
import { Router } from 'express'
import { z } from 'zod'
import Employee from '../models/Employee.js'
import { requireEmployee, setEmployeeCookie, clearEmployeeCookie, serializeEmployee } from '../middleware/employeeAuth.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { getEmployeeHierarchy } from '../utils/employeeHierarchy.js'

const router = Router()
const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
})

router.post('/login', asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Enter a valid email and password.' })

  const employee = await Employee.findOne({ email: parsed.data.email.toLowerCase() }).select('+passwordHash')
  if (!employee?.isActive) return res.status(401).json({ success: false, message: 'Email or password is incorrect.' })
  if (employee.lockUntil && employee.lockUntil > new Date()) {
    return res.status(423).json({ success: false, message: 'Sign-in is temporarily locked. Try again later.' })
  }

  const passwordMatches = await argon2.verify(employee.passwordHash, parsed.data.password)
  if (!passwordMatches) {
    employee.failedLoginCount += 1
    if (employee.failedLoginCount >= 5) {
      employee.failedLoginCount = 0
      employee.lockUntil = new Date(Date.now() + 15 * 60 * 1000)
    }
    await employee.save()
    return res.status(401).json({ success: false, message: 'Email or password is incorrect.' })
  }

  employee.failedLoginCount = 0
  employee.lockUntil = null
  employee.lastLoginAt = new Date()
  await employee.save()
  const hierarchy = await getEmployeeHierarchy(employee)
  setEmployeeCookie(res, employee)
  return res.json({
    success: true,
    data: {
      ...serializeEmployee(employee),
      hierarchy: {
        smId: hierarchy.smId ? String(hierarchy.smId) : null,
        drmId: hierarchy.drmId ? String(hierarchy.drmId) : null,
        rmId: hierarchy.rmId ? String(hierarchy.rmId) : null,
        zmId: hierarchy.zmId ? String(hierarchy.zmId) : null,
      },
    },
  })
}))

router.get('/me', requireEmployee, asyncHandler(async (req, res) => {
  const hierarchy = await getEmployeeHierarchy(req.employee)
  return res.json({
    success: true,
    data: {
      ...serializeEmployee(req.employee),
      hierarchy: {
        smId: hierarchy.smId ? String(hierarchy.smId) : null,
        drmId: hierarchy.drmId ? String(hierarchy.drmId) : null,
        rmId: hierarchy.rmId ? String(hierarchy.rmId) : null,
        zmId: hierarchy.zmId ? String(hierarchy.zmId) : null,
      },
    },
  })
}))

router.post('/logout', requireEmployee, asyncHandler(async (req, res) => {
  await Employee.updateOne({ _id: req.employee._id }, { $inc: { tokenVersion: 1 } })
  clearEmployeeCookie(res)
  return res.json({ success: true, data: null })
}))

export default router
