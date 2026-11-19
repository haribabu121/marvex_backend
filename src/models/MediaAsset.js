import mongoose from 'mongoose'

const mediaAssetSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    resourceType: { type: String, enum: ['image', 'video'], required: true },
    format: { type: String, required: true, lowercase: true },
    bytes: { type: Number, required: true, min: 1 },
    assetType: { type: String, enum: ['carousel', 'thumbnail', 'gallery'], required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
  },
  { timestamps: true },
)

mediaAssetSchema.index({ createdAt: -1 })

export default mongoose.models.MediaAsset || mongoose.model('MediaAsset', mediaAssetSchema)
