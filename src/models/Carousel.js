import mongoose from 'mongoose'

const carouselSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    mediaType: { type: String, enum: ['video'], default: 'video', required: true },
    mediaUrl: { type: String, required: true },
    publicId: { type: String, required: true },
    resourceType: { type: String, enum: ['video'], default: 'video' },
    format: { type: String, required: true, lowercase: true },
    bytes: { type: Number, required: true, min: 1 },
    thumbnailUrl: { type: String, default: '' },
    thumbnailPublicId: { type: String, default: '' },
    category: { type: String, required: true, trim: true, maxlength: 80 },
    displayOrder: { type: Number, default: 0, index: true },
    isPublished: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
)

carouselSchema.index({ title: 'text', description: 'text', category: 'text' })

export default mongoose.models.Carousel || mongoose.model('Carousel', carouselSchema)
