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

const sanctionSchema = new mongoose.Schema(
  {
    sanctionReferenceId: { type: String, required: true, unique: true, index: true },
    loginSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'SuryaGharLogin', required: true, index: true },
    applicationNumber: { type: String, required: true, trim: true, uppercase: true, maxlength: 100 },
    customerName: { type: String, required: true, trim: true, maxlength: 160 },
    mobileNumber: { type: String, required: true, trim: true, maxlength: 20 },
    consumerNumber: { type: String, required: true, trim: true, maxlength: 100 },
    eTokenNumber: { type: String, required: true, trim: true, maxlength: 120 },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, required: true },
    employeeRole: { type: String, enum: ['ZM', 'RM', 'DRM', 'SM'], required: true },
    submittedByEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    submittedByEmployeeName: { type: String, required: true },
    submittedByEmployeeRole: { type: String, enum: ['ZM', 'RM', 'DRM', 'SM'], required: true },
    smId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    drmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    rmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    zmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    feasibilityApprovalDate: { type: Date, required: true },
    feasibilityApprovalStatus: { type: String, required: true, trim: true, maxlength: 100 },
    feasibilityApprovalDocument: { type: documentSchema, required: true },
    temporaryDocuments: { type: [documentSchema], default: [] },
    remarks: { type: String, default: '', maxlength: 2000 },
    sanctionStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED'], default: 'PENDING', index: true },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    sanctionVerifiedAt: { type: Date, default: null, index: true },
    verificationRemarks: { type: String, default: '', maxlength: 2000 },
    approvalHistory: { type: [statusHistorySchema], default: [] },
    resubmissions: { type: [resubmissionSchema], default: [] },
    submittingEmployeeHierarchy: {
      smId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
      drmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
      rmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
      zmId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    },
  },
  { timestamps: true },
)

sanctionSchema.index(
  { applicationNumber: 1 },
  { unique: true, partialFilterExpression: { sanctionStatus: 'APPROVED' } },
)
sanctionSchema.index({ employeeId: 1, sanctionStatus: 1, sanctionVerifiedAt: 1 })
sanctionSchema.index({ drmId: 1, sanctionStatus: 1, sanctionVerifiedAt: 1 })
sanctionSchema.index({ rmId: 1, sanctionStatus: 1, sanctionVerifiedAt: 1 })
sanctionSchema.index({ zmId: 1, sanctionStatus: 1, sanctionVerifiedAt: 1 })

export default mongoose.models.SuryaGharSanction || mongoose.model('SuryaGharSanction', sanctionSchema)
