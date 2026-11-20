import argon2 from 'argon2'
import { Router } from 'express'
import { z } from 'zod'
import Employee from '../models/Employee.js'
import { requireAdmin, requireChangedPassword } from '../middleware/auth.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import { writeAuditLog } from '../utils/audit.js'
import HttpError from '../utils/HttpError.js'

const router = Router()
const createEmployeeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(200),
  role: z.enum(['ZM', 'RM', 'DRM', 'SM']),
  reportsTo: z.string().regex(/^[a-f\d]{24}$/i).nullable(),
})
const parentRole = { ZM: null, RM: 'ZM', DRM: 'RM', SM: 'DRM' }

router.get('/', requireAdmin, requireChangedPassword, asyncHandler(async (_req, res) => {
  const employees = await Employee.find()
    .select('name email role reportsTo isActive lastLoginAt createdAt')
    .populate('reportsTo', 'name role')
    .sort({ role: 1, name: 1 })
    .lean()
  return res.json({ success: true, data: { items: employees } })
}))

router.post('/', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const parsed = createEmployeeSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Enter valid employee details and a password of at least 12 characters.' })
  }
  const data = parsed.data
  const expectedParent = parentRole[data.role]
  if ((expectedParent === null && data.reportsTo) || (expectedParent && !data.reportsTo)) {
    return res.status(400).json({ success: false, message: `${data.role} must report to ${expectedParent || 'no employee'}.` })
  }
  if (data.reportsTo) {
    const parent = await Employee.findOne({ _id: data.reportsTo, isActive: true }).select('role')
    if (!parent || parent.role !== expectedParent) {
      return res.status(400).json({ success: false, message: `Choose an active ${expectedParent} as the reporting manager.` })
    }
  }

  const employee = await Employee.create({
    name: data.name,
    email: data.email.toLowerCase(),
    passwordHash: await argon2.hash(data.password, { type: argon2.argon2id }),
    role: data.role,
    reportsTo: data.reportsTo,
  })
  await writeAuditLog(req, 'employee.created', `Created ${employee.role} employee ${employee.name}.`, 'employee', employee._id)
  return res.status(201).json({
    success: true,
    data: {
      id: String(employee._id),
      name: employee.name,
      email: employee.email,
      role: employee.role,
      reportsTo: employee.reportsTo ? String(employee.reportsTo) : null,
      isActive: employee.isActive,
    },
  })
}))

router.patch('/:id/active', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Choose a valid employee account status.' })

  if (!parsed.data.isActive && await Employee.exists({ reportsTo: req.params.id, isActive: true })) {
    return res.status(409).json({ success: false, message: "Reassign or deactivate this employee's active reports first." })
  }
  const employee = await Employee.findByIdAndUpdate(
    req.params.id,
    { $set: { isActive: parsed.data.isActive }, $inc: { tokenVersion: 1 } },
    { returnDocument: 'after', runValidators: true },
  ).select('name email role isActive')
  if (!employee) throw new HttpError(404, 'Employee not found.')
  await writeAuditLog(
    req,
    parsed.data.isActive ? 'employee.activated' : 'employee.deactivated',
    `${parsed.data.isActive ? 'Activated' : 'Deactivated'} employee ${employee.name}.`,
    'employee',
    employee._id,
  )
  return res.json({ success: true, data: employee })
}))

export default router
