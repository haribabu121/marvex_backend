import mongoose from 'mongoose'

const documentSchema = new mongoose.Schema(
  {
    secureUrl: { type: String, default: null },
    publicId: { type: String, default: null },
    resourceType: { type: String, enum: ['image', 'raw'], default: null },
    deletionStatus: { type: String, enum: ['NOT_REQUIRED', 'PENDING', 'DELETED', 'FAILED'], default: 'NOT_REQUIRED' },
    deletionError: { type: String, default: null, maxlength: 1000 },
  },
  { _id: false },
)

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED'], required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', required: true },
    remarks: { type: String, default: '', maxlength: 2000 },
    changedAt: { type: Date, required: true },
  },
  { _id: false },
)

const resubmissionSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    submittedAt: { type: Date, required: true },
  },
  { _id: false },
)

const loginSchema = new mongoose.Schema(
  {
    loginReferenceId: { type: String, required: true, unique: true, index: true },
    customerName: { type: String, required: true, trim: true, maxlength: 160 },
    mobileNumber: { type: String, required: true, trim: true, maxlength: 20 },
    consumerNumber: { type: String, required: true, trim: true, maxlength: 100 },
    district: { type: String, required: true, trim: true, maxlength: 120 },
    solarCapacity: { type: Number, required: true, min: 0.1, max: 1000 },
    applicationNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: 100 },
    applicationSubmittedAt: { type: Date, required: true },
    eTokenNumber: { type: String, required: true, trim: true, maxlength: 120 },
    documents: {
      eTokenProof: { type: documentSchema, default: () => ({}) },
      applicationAcknowledgement: { type: documentSchema, default: () => ({}) },
    },
    temporaryDocuments: { type: [documentSchema], default: [] },
    remarks: { type: String, default: '', maxlength: 2000 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, required: true },
    employeeRole: { type: String, enum: ['ZM', 'RM', 'DRM', 'SM'], required: true },
    smId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    drmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    rmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    zmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    loginStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED'], default: 'PENDING', index: true },
    loginVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    loginVerifiedAt: { type: Date, default: null, index: true },
    verificationRemarks: { type: String, default: '', maxlength: 2000 },
    approvalHistory: { type: [statusHistorySchema], default: [] },
    resubmissions: { type: [resubmissionSchema], default: [] },
  },
  { timestamps: true },
)

loginSchema.index({ applicationNumber: 1 }, { unique: true })
loginSchema.index({ employeeId: 1, loginStatus: 1, loginVerifiedAt: 1 })
loginSchema.index({ drmId: 1, loginStatus: 1, loginVerifiedAt: 1 })
loginSchema.index({ rmId: 1, loginStatus: 1, loginVerifiedAt: 1 })
loginSchema.index({ zmId: 1, loginStatus: 1, loginVerifiedAt: 1 })

export default mongoose.models.SuryaGharLogin || mongoose.model('SuryaGharLogin', loginSchema)
