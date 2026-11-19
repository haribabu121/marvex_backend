import mongoose from 'mongoose'

const statisticSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 100 },
    value: { type: String, required: true, trim: true, maxlength: 40 },
    description: { type: String, default: '', trim: true, maxlength: 240 },
    displayOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { _id: true },
)

const aboutContentSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: 'about' },
    heading: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    statistics: { type: [statisticSchema], default: [] },
  },
  { timestamps: true },
)

export default mongoose.models.AboutContent ||
  mongoose.model('AboutContent', aboutContentSchema)
