import jwt from 'jsonwebtoken'
import Employee from '../models/Employee.js'

const EMPLOYEE_COOKIE = 'marvex_employee_access'

function getAccessSecret() {
  const secret = process.env.JWT_ACCESS_SECRET
  if (!secret) throw new Error('JWT_ACCESS_SECRET is required.')
  return secret
}

export function setEmployeeCookie(res, employee) {
  const token = jwt.sign(
    { sub: String(employee._id), version: employee.tokenVersion, type: 'employee' },
    getAccessSecret(),
    { expiresIn: '8h', issuer: 'marvex-energy-employee' },
  )
  const production = process.env.NODE_ENV === 'production'
  res.cookie(EMPLOYEE_COOKIE, token, {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'none' : 'lax',
    path: '/api/cms',
    maxAge: 8 * 60 * 60 * 1000,
  })
}

export function clearEmployeeCookie(res) {
  const production = process.env.NODE_ENV === 'production'
  res.clearCookie(EMPLOYEE_COOKIE, {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'none' : 'lax',
    path: '/api/cms',
  })
}

export async function requireEmployee(req, res, next) {
  try {
    const token = req.cookies?.[EMPLOYEE_COOKIE]
    if (!token) return res.status(401).json({ success: false, message: 'Employee sign-in required.' })

    const payload = jwt.verify(token, getAccessSecret(), {
      issuer: 'marvex-energy-employee',
    })
    if (payload.type !== 'employee' || !payload.sub || !Number.isInteger(payload.version)) {
      return res.status(401).json({ success: false, message: 'Employee session is invalid.' })
    }

    const employee = await Employee.findById(payload.sub)
    if (!employee?.isActive || employee.tokenVersion !== payload.version) {
      return res.status(401).json({ success: false, message: 'Employee session is no longer active.' })
    }

    req.employee = employee
    return next()
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ success: false, message: 'Employee session has expired.' })
    }
    return next(error)
  }
}

export function serializeEmployee(employee) {
  return {
    id: String(employee._id),
    name: employee.name,
    email: employee.email,
    role: employee.role,
    reportsTo: employee.reportsTo ? String(employee.reportsTo) : null,
  }
}
