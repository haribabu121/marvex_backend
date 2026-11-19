import ActivityLog from '../models/ActivityLog.js'

export async function writeAuditLog(req, action, summary, targetType = '', targetId = '') {
  await ActivityLog.create({
    adminId: req.admin._id,
    action,
    summary,
    targetType,
    targetId: String(targetId || ''),
    ipAddress: req.ip || '',
  })
}
