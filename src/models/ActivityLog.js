import mongoose from 'mongoose'

const activityLogSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    action: { type: String, required: true, maxlength: 80 },
    targetType: { type: String, default: '', maxlength: 40 },
    targetId: { type: String, default: '', maxlength: 100 },
    summary: { type: String, required: true, maxlength: 240 },
    ipAddress: { type: String, default: '', maxlength: 64 },
  },
  { timestamps: true },
)

activityLogSchema.index({ createdAt: -1 })

export default mongoose.models.ActivityLog || mongoose.model('ActivityLog', activityLogSchema)
