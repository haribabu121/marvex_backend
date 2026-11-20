import Employee from '../models/Employee.js'
import HttpError from './HttpError.js'

const parentRole = { SM: 'DRM', DRM: 'RM', RM: 'ZM', ZM: null }

export async function getEmployeeHierarchy(employee) {
  const hierarchy = { employeeId: employee._id, employeeName: employee.name, employeeRole: employee.role }
  const roles = { SM: null, DRM: null, RM: null, ZM: null }
  let current = employee

  while (current) {
    roles[current.role] = current
    const expectedParentRole = parentRole[current.role]
    if (!expectedParentRole) break
    if (!current.reportsTo) {
      throw new HttpError(409, `The ${current.role} reporting assignment is incomplete.`)
    }

    const parent = await Employee.findById(current.reportsTo)
    if (!parent || parent.role !== expectedParentRole) {
      throw new HttpError(409, `The ${current.role} reporting assignment is invalid.`)
    }
    current = parent
  }

  return {
    ...hierarchy,
    smId: roles.SM?._id || null,
    drmId: roles.DRM?._id || null,
    rmId: roles.RM?._id || null,
    zmId: roles.ZM?._id || null,
  }
}

export async function getAuthorizedEmployeeIds(employee) {
  const ids = [employee._id]
  let reportsTo = [employee._id]

  while (reportsTo.length) {
    const children = await Employee.find({
      reportsTo: { $in: reportsTo },
    }).select('_id').lean()
    reportsTo = children
      .map(({ _id }) => _id)
      .filter((id) => !ids.some((existing) => String(existing) === String(id)))
    ids.push(...reportsTo)
  }

  return ids
}

export function serializeHierarchyFields(hierarchy) {
  return {
    employeeId: hierarchy.employeeId,
    employeeName: hierarchy.employeeName,
    employeeRole: hierarchy.employeeRole,
    smId: hierarchy.smId,
    drmId: hierarchy.drmId,
    rmId: hierarchy.rmId,
    zmId: hierarchy.zmId,
  }
}
