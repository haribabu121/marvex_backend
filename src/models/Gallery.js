import mongoose from 'mongoose'

const gallerySchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    altText: { type: String, required: true, trim: true, maxlength: 240 },
    mediaUrl: { type: String, required: true },
    publicId: { type: String, required: true },
    resourceType: { type: String, enum: ['image'], default: 'image' },
    format: { type: String, required: true, lowercase: true },
    bytes: { type: Number, required: true, min: 1 },
    displayOrder: { type: Number, default: 0, index: true },
    isPublished: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
)

gallerySchema.index({ title: 'text', description: 'text', altText: 'text' })

export default mongoose.models.Gallery || mongoose.model('Gallery', gallerySchema)
