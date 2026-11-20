import mongoose from 'mongoose'

const cleanupJobSchema = new mongoose.Schema(
  {
    recordType: { type: String, enum: ['login', 'sanction'], required: true },
    recordId: { type: mongoose.Schema.Types.ObjectId, required: true },
    documentKey: { type: String, required: true },
    publicId: { type: String, default: null },
    resourceType: { type: String, enum: ['image', 'raw'], required: true },
    status: { type: String, enum: ['PENDING', 'PROCESSING', 'FAILED', 'COMPLETED'], default: 'PENDING', index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 1000 },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

cleanupJobSchema.index(
  { recordType: 1, recordId: 1, documentKey: 1, publicId: 1 },
  { unique: true, partialFilterExpression: { publicId: { $type: 'string' } } },
)
cleanupJobSchema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 })

export default mongoose.models.DocumentCleanupJob || mongoose.model('DocumentCleanupJob', cleanupJobSchema)
