import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import ActivityLog from '../models/ActivityLog.js'
import DocumentCleanupJob from '../models/DocumentCleanupJob.js'
import Employee from '../models/Employee.js'
import SuryaGharLogin from '../models/SuryaGharLogin.js'
import SuryaGharSanction from '../models/SuryaGharSanction.js'
import { getCloudinary, isCloudinaryConfigured } from '../config/cloudinary.js'
import { requireAdmin, requireChangedPassword } from '../middleware/auth.js'
import { requireEmployee } from '../middleware/employeeAuth.js'
import { asyncHandler } from '../utils/asyncHandler.js'
import HttpError from '../utils/HttpError.js'
import { getAuthorizedEmployeeIds, getEmployeeHierarchy, serializeHierarchyFields } from '../utils/employeeHierarchy.js'
import { documentConfig, verifySuryaGharDocument, cloudinaryResourceType, SURYA_GHAR_FOLDER } from '../utils/suryaGharDocuments.js'
import { getSuryaGharReportingPeriod } from '../utils/suryaGharReporting.js'

const router = Router()
const statuses = ['PENDING', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED']
const loginSchema = z.object({
  customerName: z.string().trim().min(1).max(160),
  mobileNumber: z.string().trim().min(6).max(20),
  consumerNumber: z.string().trim().min(1).max(100),
  district: z.string().trim().min(1).max(120),
  solarCapacity: z.coerce.number().positive().max(1000),
  applicationNumber: z.string().trim().min(1).max(100),
  applicationSubmittedAt: z.string().datetime(),
  eTokenNumber: z.string().trim().min(1).max(120),
  eTokenProofPublicId: z.string().min(1).max(400),
  eTokenProofResourceType: z.enum(['image', 'raw']),
  acknowledgementPublicId: z.string().min(1).max(400),
  acknowledgementResourceType: z.enum(['image', 'raw']),
  remarks: z.string().max(2000).optional().default(''),
})
const sanctionSchema = z.object({
  loginSubmissionId: z.string().regex(/^[a-f\d]{24}$/i),
  feasibilityApprovalDate: z.string().datetime(),
  feasibilityApprovalStatus: z.string().trim().min(1).max(100),
  feasibilityDocumentPublicId: z.string().min(1).max(400),
  feasibilityDocumentResourceType: z.enum(['image', 'raw']),
  remarks: z.string().max(2000).optional().default(''),
})
const uploadSignatureSchema = z.object({
  documentType: z.enum(['eTokenProof', 'applicationAcknowledgement', 'feasibilityApprovalDocument']),
  mimeType: z.string().min(1).max(100),
  bytes: z.number().int().positive(),
})
const reviewSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED']),
  remarks: z.string().max(2000).optional().default(''),
})
const previewMaxBytes = 15 * 1024 * 1024
const previewImageTypes = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

function referenceId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
}

function requireSubmitter(employee, res) {
  if (!['SM', 'DRM'].includes(employee.role)) {
    res.status(403).json({ success: false, message: 'Only SM and DRM employees can submit login and sanction records.' })
    return false
  }
  return true
}

function aggregateByDay(Model, dateField, employeeIds, start, end) {
  return Model.aggregate([
    {
      $match: {
        employeeId: { $in: employeeIds },
        [Model === SuryaGharLogin ? 'loginStatus' : 'sanctionStatus']: 'APPROVED',
        [dateField]: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: {
          employeeId: '$employeeId',
          day: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}`, timezone: 'Asia/Kolkata' } },
        },
        count: { $sum: 1 },
      },
    },
  ])
}

function aggregateTotals(Model, employeeIds, statusField, verifiedAtField) {
  return Model.aggregate([
    {
      $match: {
        employeeId: { $in: employeeIds },
        [statusField]: 'APPROVED',
        [verifiedAtField]: { $type: 'date' },
      },
    },
    { $group: { _id: '$employeeId', count: { $sum: 1 } } },
  ])
}

async function queueCleanup(recordType, recordId, documents) {
  const jobs = documents
    .filter(({ key, document }) => document?.publicId && document?.resourceType)
    .map(({ key, document }) => ({
      updateOne: {
        filter: { recordType, recordId, documentKey: key, publicId: document.publicId },
        update: {
          $setOnInsert: {
            recordType,
            recordId,
            documentKey: key,
            publicId: document.publicId,
            resourceType: document.resourceType,
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        },
        upsert: true,
      },
    }))
  if (jobs.length) await DocumentCleanupJob.bulkWrite(jobs, { ordered: true })
}

function loginCleanupDocuments(record) {
  return (record.temporaryDocuments || []).map((document, index) => ({
    key: `temporaryDocuments.${index}`,
    document,
  }))
}

function sanctionCleanupDocuments(record) {
  return (record.temporaryDocuments || []).map((document, index) => ({
    key: `temporaryDocuments.${index}`,
    document,
  }))
}

async function sendDocumentPreview(res, document) {
  if (
    !document?.publicId?.startsWith(`${SURYA_GHAR_FOLDER}/`) ||
    !['image', 'raw'].includes(document.resourceType)
  ) {
    return res.status(404).json({ success: false, message: 'Document preview is unavailable.' })
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME
  if (!cloudName) throw new HttpError(503, 'Document storage is not configured.')

  const cloudinary = getCloudinary()
  const resource = await cloudinary.api.resource(document.publicId, {
    resource_type: document.resourceType,
  })
  if (
    resource.public_id !== document.publicId ||
    resource.resource_type !== document.resourceType
  ) {
    throw new HttpError(404, 'Document preview is unavailable.')
  }
  const extensionStart = document.publicId.lastIndexOf('.')
  const folderSeparator = document.publicId.lastIndexOf('/')
  const publicIdFormat = extensionStart > folderSeparator
    ? document.publicId.slice(extensionStart + 1).toLowerCase()
    : ''
  const format = String(resource.format || publicIdFormat).toLowerCase()
  const allowedFormats = document.resourceType === 'raw'
    ? ['pdf']
    : ['jpg', 'jpeg', 'png', 'webp']
  if (!allowedFormats.includes(format)) {
    throw new HttpError(415, 'This document format cannot be previewed.')
  }

  let url
  try {
    url = new URL(cloudinary.utils.private_download_url(document.publicId, format, {
      resource_type: document.resourceType,
      type: 'upload',
      expires_at: Math.floor(Date.now() / 1000) + 60,
      attachment: false,
    }))
  } catch {
    throw new HttpError(502, 'Document preview is unavailable.')
  }
  const expectedPath = `/v1_1/${cloudName}/${document.resourceType}/download`
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.cloudinary.com') ||
    url.pathname !== expectedPath
  ) {
    throw new HttpError(502, 'Document preview is unavailable.')
  }

  const upstream = await fetch(url)
  if (!upstream.ok) {
    console.error('Surya Ghar document preview delivery failed:', {
      status: upstream.status,
      statusText: upstream.statusText,
    })
    throw new HttpError(502, 'Could not retrieve the document preview.')
  }
  const contentLength = Number(upstream.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > previewMaxBytes) {
    throw new HttpError(413, 'The document preview exceeds the allowed size.')
  }

  const data = Buffer.from(await upstream.arrayBuffer())
  if (data.length > previewMaxBytes) throw new HttpError(413, 'The document preview exceeds the allowed size.')

  let previewType
  let extension
  if (document.resourceType === 'raw') {
    if (data.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new HttpError(415, 'This document cannot be previewed as a PDF.')
    }
    previewType = 'application/pdf'
    extension = 'pdf'
  } else {
    previewType = previewImageTypes[format]
    const validImageSignature = format === 'jpg' || format === 'jpeg'
      ? data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : format === 'png'
        ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        : format === 'webp'
          ? data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
          : false
    if (!previewType || !validImageSignature) {
      throw new HttpError(415, 'This image format cannot be previewed.')
    }
    extension = format === 'jpeg' ? 'jpg' : format
  }

  res.setHeader('Content-Type', previewType)
  res.setHeader('Content-Disposition', `inline; filename="document.${extension}"`)
  res.setHeader('Content-Length', data.length)
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  return res.send(data)
}

function previewMetadata(document) {
  return {
    available: Boolean(document?.publicId && document?.resourceType),
    resourceType: document?.resourceType || null,
  }
}

function serializeLoginDocuments(record) {
  const data = typeof record.toObject === 'function' ? record.toObject() : record
  const submission = { ...data }
  delete submission.temporaryDocuments
  return {
    ...submission,
    documents: {
      eTokenProof: previewMetadata(data.documents?.eTokenProof),
      applicationAcknowledgement: previewMetadata(data.documents?.applicationAcknowledgement),
    },
  }
}

function serializeSanctionDocument(record) {
  const data = typeof record.toObject === 'function' ? record.toObject() : record
  const submission = { ...data }
  delete submission.temporaryDocuments
  return {
    ...submission,
    feasibilityApprovalDocument: previewMetadata(data.feasibilityApprovalDocument),
  }
}

async function setReviewStatus(Model, req, recordId, statusField, verifiedByField, verifiedAtField, recordType) {
  const parsed = reviewSchema.safeParse(req.body)
  if (!parsed.success) return { response: { status: 400, message: 'Choose a valid review status and remarks.' } }
  const { status, remarks } = parsed.data
  const record = await Model.findById(recordId)
  if (!record) return { response: { status: 404, message: 'Submission not found.' } }
  if (!['PENDING', 'RESUBMISSION_REQUIRED'].includes(record[statusField])) {
    return { response: { status: 409, message: 'This submission has already been reviewed.' } }
  }

  if (status === 'APPROVED') {
    await queueCleanup(
      recordType,
      record._id,
      recordType === 'login' ? loginCleanupDocuments(record) : sanctionCleanupDocuments(record),
    )
  }

  const now = new Date()
  const filter = {
    _id: record._id,
    [statusField]: { $in: ['PENDING', 'RESUBMISSION_REQUIRED'] },
    updatedAt: record.updatedAt,
  }
  const update = {
    $set: {
      [statusField]: status,
      verificationRemarks: remarks,
      ...(status === 'APPROVED' ? { [verifiedByField]: req.admin._id, [verifiedAtField]: now } : {}),
    },
    $push: { approvalHistory: { status, adminId: req.admin._id, remarks, changedAt: now } },
  }
  const updated = await Model.findOneAndUpdate(filter, update, { returnDocument: 'after', runValidators: true })
  if (!updated) return { response: { status: 409, message: 'This submission has already been reviewed.' } }

  try {
    await ActivityLog.create({
      adminId: req.admin._id,
      action: `${recordType}.${status.toLowerCase()}`,
      targetType: recordType,
      targetId: String(record._id),
      summary: `${status === 'APPROVED' ? 'Approved' : status === 'REJECTED' ? 'Rejected' : 'Requested resubmission for'} ${recordType} ${record.loginReferenceId || record.sanctionReferenceId}.`,
      ipAddress: req.ip || '',
    })
  } catch (error) {
    console.error('Surya Ghar approval activity log failed; record history was saved:', error instanceof Error ? error.message : error)
  }
  return { record: updated }
}

router.post('/upload/signature', requireEmployee, asyncHandler(async (req, res) => {
  const parsed = uploadSignatureSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Select a supported document file.' })
  if (!isCloudinaryConfigured()) return res.status(503).json({ success: false, message: 'Document storage is not configured.' })

  const { documentType, mimeType, bytes } = parsed.data
  const config = documentConfig[documentType]
  if (!config.mimeTypes.includes(mimeType) || bytes > config.maxBytes) {
    return res.status(400).json({ success: false, message: 'Choose a PDF, JPEG, PNG or WebP document no larger than 15 MB.' })
  }

  const folder = config.folder(String(req.employee._id))
  const timestamp = Math.floor(Date.now() / 1000)
  const allowedFormats = config.formats
  const signature = getCloudinary().utils.api_sign_request(
    { timestamp, folder, allowed_formats: allowedFormats },
    process.env.CLOUDINARY_API_SECRET,
  )

  return res.json({
    success: true,
    data: {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      timestamp,
      signature,
      folder,
      allowedFormats,
      resourceType: cloudinaryResourceType(mimeType),
      documentType,
    },
  })
}))

router.post('/upload/complete', requireEmployee, asyncHandler(async (req, res) => {
  const parsed = z.object({
    documentType: z.enum(['eTokenProof', 'applicationAcknowledgement', 'feasibilityApprovalDocument']),
    publicId: z.string().min(1).max(400),
    resourceType: z.enum(['image', 'raw']),
  }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Invalid uploaded document details.' })
  if (!isCloudinaryConfigured()) return res.status(503).json({ success: false, message: 'Document storage is not configured.' })
  const document = await verifySuryaGharDocument({
    publicId: parsed.data.publicId,
    employeeId: req.employee._id,
    documentType: parsed.data.documentType,
    resourceType: parsed.data.resourceType,
  })
  return res.json({
    success: true,
    data: { publicId: document.publicId, resourceType: document.resourceType },
  })
}))

router.post('/logins', requireEmployee, asyncHandler(async (req, res) => {
  if (!requireSubmitter(req.employee, res)) return
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Complete all required customer, application and document fields.' })
  if (!isCloudinaryConfigured()) return res.status(503).json({ success: false, message: 'Document storage is not configured.' })

  const [eTokenProof, applicationAcknowledgement, hierarchy] = await Promise.all([
    verifySuryaGharDocument({ publicId: parsed.data.eTokenProofPublicId, employeeId: req.employee._id, documentType: 'eTokenProof', resourceType: parsed.data.eTokenProofResourceType }),
    verifySuryaGharDocument({ publicId: parsed.data.acknowledgementPublicId, employeeId: req.employee._id, documentType: 'applicationAcknowledgement', resourceType: parsed.data.acknowledgementResourceType }),
    getEmployeeHierarchy(req.employee),
  ])
  const {
    eTokenProofPublicId,
    eTokenProofResourceType,
    acknowledgementPublicId,
    acknowledgementResourceType,
    ...loginData
  } = parsed.data
  const record = await SuryaGharLogin.create({
    loginReferenceId: referenceId('PMSG-L'),
    ...loginData,
    applicationNumber: parsed.data.applicationNumber.toUpperCase(),
    applicationSubmittedAt: new Date(parsed.data.applicationSubmittedAt),
    documents: { eTokenProof, applicationAcknowledgement },
    ...serializeHierarchyFields(hierarchy),
    loginStatus: 'PENDING',
  })
  return res.status(201).json({ success: true, data: serializeLoginDocuments(record) })
}))

router.patch('/logins/:id/resubmit', requireEmployee, asyncHandler(async (req, res) => {
  if (!requireSubmitter(req.employee, res)) return
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Complete all required customer, application and document fields.' })
  if (!isCloudinaryConfigured()) return res.status(503).json({ success: false, message: 'Document storage is not configured.' })
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid login submission ID.' })

  const current = await SuryaGharLogin.findOne({
    _id: req.params.id,
    employeeId: req.employee._id,
    loginStatus: 'RESUBMISSION_REQUIRED',
  })
  if (!current) return res.status(404).json({ success: false, message: 'Resubmission-required login was not found.' })

  const [eTokenProof, applicationAcknowledgement] = await Promise.all([
    verifySuryaGharDocument({ publicId: parsed.data.eTokenProofPublicId, employeeId: req.employee._id, documentType: 'eTokenProof', resourceType: parsed.data.eTokenProofResourceType }),
    verifySuryaGharDocument({ publicId: parsed.data.acknowledgementPublicId, employeeId: req.employee._id, documentType: 'applicationAcknowledgement', resourceType: parsed.data.acknowledgementResourceType }),
  ])
  const oldDocuments = [current.documents?.eTokenProof, current.documents?.applicationAcknowledgement]
    .filter((document) => document?.publicId)
  const {
    eTokenProofPublicId,
    eTokenProofResourceType,
    acknowledgementPublicId,
    acknowledgementResourceType,
    ...loginData
  } = parsed.data
  const update = {
    $set: {
      ...loginData,
      applicationNumber: parsed.data.applicationNumber.toUpperCase(),
      applicationSubmittedAt: new Date(parsed.data.applicationSubmittedAt),
      documents: { eTokenProof, applicationAcknowledgement },
      loginStatus: 'PENDING',
      verificationRemarks: '',
    },
    $unset: { loginVerifiedBy: '', loginVerifiedAt: '' },
    $push: {
      resubmissions: { employeeId: req.employee._id, submittedAt: new Date() },
      ...(oldDocuments.length ? { temporaryDocuments: { $each: oldDocuments } } : {}),
    },
  }
  const record = await SuryaGharLogin.findOneAndUpdate(
    { _id: current._id, employeeId: req.employee._id, loginStatus: 'RESUBMISSION_REQUIRED' },
    update,
    { returnDocument: 'after', runValidators: true },
  )
  if (!record) return res.status(409).json({ success: false, message: 'This login has already been updated.' })
  return res.json({ success: true, data: serializeLoginDocuments(record) })
}))

router.get('/logins/eligible-for-sanction', requireEmployee, asyncHandler(async (req, res) => {
  if (!requireSubmitter(req.employee, res)) return
  const employeeIds = await getAuthorizedEmployeeIds(req.employee)
  const existing = await SuryaGharSanction.find({
    loginSubmissionId: { $exists: true },
    sanctionStatus: { $in: ['PENDING', 'APPROVED', 'RESUBMISSION_REQUIRED'] },
  }).distinct('loginSubmissionId')
  const items = await SuryaGharLogin.find({
    employeeId: { $in: employeeIds },
    loginStatus: 'APPROVED',
    _id: { $nin: existing },
  }).select('customerName applicationNumber eTokenNumber employeeName employeeId employeeRole smId drmId rmId zmId loginVerifiedAt')
    .sort({ loginVerifiedAt: -1 })
    .limit(200)
    .lean()
  return res.json({ success: true, data: { items } })
}))

router.post('/sanctions', requireEmployee, asyncHandler(async (req, res) => {
  if (!requireSubmitter(req.employee, res)) return
  const parsed = sanctionSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Complete the feasibility date, status, document and remarks.' })
  if (!isCloudinaryConfigured()) return res.status(503).json({ success: false, message: 'Document storage is not configured.' })

  const employeeIds = await getAuthorizedEmployeeIds(req.employee)
  const login = await SuryaGharLogin.findOne({
    _id: parsed.data.loginSubmissionId,
    employeeId: { $in: employeeIds },
    loginStatus: 'APPROVED',
  })
  if (!login) return res.status(404).json({ success: false, message: 'Approved login was not found in your authorized hierarchy.' })
  const exists = await SuryaGharSanction.exists({
    loginSubmissionId: login._id,
    sanctionStatus: { $in: ['PENDING', 'APPROVED', 'RESUBMISSION_REQUIRED'] },
  })
  if (exists) return res.status(409).json({ success: false, message: 'A sanction submission already exists for this login.' })

  const [feasibilityApprovalDocument, submitterHierarchy] = await Promise.all([
    verifySuryaGharDocument({
      publicId: parsed.data.feasibilityDocumentPublicId,
      employeeId: req.employee._id,
      documentType: 'feasibilityApprovalDocument',
      resourceType: parsed.data.feasibilityDocumentResourceType,
    }),
    getEmployeeHierarchy(req.employee),
  ])
  const record = await SuryaGharSanction.create({
    sanctionReferenceId: referenceId('PMSG-S'),
    loginSubmissionId: login._id,
    applicationNumber: login.applicationNumber,
    customerName: login.customerName,
    mobileNumber: login.mobileNumber,
    consumerNumber: login.consumerNumber,
    eTokenNumber: login.eTokenNumber,
    employeeId: login.employeeId,
    employeeName: login.employeeName,
    employeeRole: login.employeeRole,
    submittedByEmployeeId: req.employee._id,
    submittedByEmployeeName: req.employee.name,
    submittedByEmployeeRole: req.employee.role,
    smId: login.smId,
    drmId: login.drmId,
    rmId: login.rmId,
    zmId: login.zmId,
    feasibilityApprovalDate: new Date(parsed.data.feasibilityApprovalDate),
    feasibilityApprovalStatus: parsed.data.feasibilityApprovalStatus,
    feasibilityApprovalDocument,
    remarks: parsed.data.remarks,
    sanctionStatus: 'PENDING',
    submittingEmployeeHierarchy: {
      smId: submitterHierarchy.smId,
      drmId: submitterHierarchy.drmId,
      rmId: submitterHierarchy.rmId,
      zmId: submitterHierarchy.zmId,
    },
  })
  return res.status(201).json({ success: true, data: serializeSanctionDocument(record) })
}))

router.patch('/sanctions/:id/resubmit', requireEmployee, asyncHandler(async (req, res) => {
  if (!requireSubmitter(req.employee, res)) return
  const parsed = z.object({
    feasibilityApprovalDate: z.string().datetime(),
    feasibilityApprovalStatus: z.string().trim().min(1).max(100),
    feasibilityDocumentPublicId: z.string().min(1).max(400),
    feasibilityDocumentResourceType: z.enum(['image', 'raw']),
    remarks: z.string().max(2000).optional().default(''),
  }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Complete the feasibility date, status, document and remarks.' })
  if (!isCloudinaryConfigured()) return res.status(503).json({ success: false, message: 'Document storage is not configured.' })
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid sanction submission ID.' })
  const current = await SuryaGharSanction.findOne({
    _id: req.params.id,
    submittedByEmployeeId: req.employee._id,
    sanctionStatus: 'RESUBMISSION_REQUIRED',
  })
  if (!current) return res.status(404).json({ success: false, message: 'Resubmission-required sanction was not found.' })

  const document = await verifySuryaGharDocument({
    publicId: parsed.data.feasibilityDocumentPublicId,
    employeeId: req.employee._id,
    documentType: 'feasibilityApprovalDocument',
    resourceType: parsed.data.feasibilityDocumentResourceType,
  })
  const update = {
    $set: {
      feasibilityApprovalDate: new Date(parsed.data.feasibilityApprovalDate),
      feasibilityApprovalStatus: parsed.data.feasibilityApprovalStatus,
      feasibilityApprovalDocument: document,
      remarks: parsed.data.remarks,
      sanctionStatus: 'PENDING',
      verificationRemarks: '',
    },
    $unset: { verifiedBy: '', sanctionVerifiedAt: '' },
    $push: {
      resubmissions: { employeeId: req.employee._id, submittedAt: new Date() },
      ...(current.feasibilityApprovalDocument?.publicId
        ? { temporaryDocuments: current.feasibilityApprovalDocument }
        : {}),
    },
  }
  const record = await SuryaGharSanction.findOneAndUpdate(
    { _id: current._id, submittedByEmployeeId: req.employee._id, sanctionStatus: 'RESUBMISSION_REQUIRED' },
    update,
    { returnDocument: 'after', runValidators: true },
  )
  if (!record) return res.status(409).json({ success: false, message: 'This sanction has already been updated.' })
  return res.json({ success: true, data: serializeSanctionDocument(record) })
}))

router.get('/dashboard', requireEmployee, asyncHandler(async (req, res) => {
  const employeeIds = await getAuthorizedEmployeeIds(req.employee)
  const period = getSuryaGharReportingPeriod()
  const { today, monthStart, nextMonthStart } = period
  const [loginDays, sanctionDays, loginTotals, sanctionTotals, pendingLogins, pendingSanctions, employees] = await Promise.all([
    aggregateByDay(SuryaGharLogin, 'loginVerifiedAt', employeeIds, period.monthStartDate, period.nextMonthStartDate),
    aggregateByDay(SuryaGharSanction, 'sanctionVerifiedAt', employeeIds, period.monthStartDate, period.nextMonthStartDate),
    aggregateTotals(SuryaGharLogin, employeeIds, 'loginStatus', 'loginVerifiedAt'),
    aggregateTotals(SuryaGharSanction, employeeIds, 'sanctionStatus', 'sanctionVerifiedAt'),
    SuryaGharLogin.countDocuments({ employeeId: { $in: employeeIds }, loginStatus: { $in: ['PENDING', 'RESUBMISSION_REQUIRED'] } }),
    SuryaGharSanction.countDocuments({
      $or: [
        { employeeId: { $in: employeeIds } },
        { submittedByEmployeeId: { $in: employeeIds } },
      ],
      sanctionStatus: { $in: ['PENDING', 'RESUBMISSION_REQUIRED'] },
    }),
    Employee.find({ _id: { $in: employeeIds } }).select('name role reportsTo').lean(),
  ])

  const totalMap = (rows) => new Map(rows.map(({ _id, count }) => [String(_id), count]))
  const loginTotalByEmployee = totalMap(loginTotals)
  const sanctionTotalByEmployee = totalMap(sanctionTotals)
  const dayCounts = (rows, day) => rows
    .filter(({ _id }) => _id.day === day)
    .reduce((sum, { count }) => sum + count, 0)
  const monthlyCounts = (rows) => rows.reduce((sum, { count }) => sum + count, 0)
  const employeesById = new Map(employees.map((employee) => [String(employee._id), employee]))
  const team = employees.map((employee) => {
    const employeeId = String(employee._id)
    return {
      employeeId,
      employeeName: employee.name,
      employeeRole: employee.role,
      loginCount: loginTotalByEmployee.get(employeeId) || 0,
      sanctionCount: sanctionTotalByEmployee.get(employeeId) || 0,
      todayLoginCount: loginDays.filter(({ _id }) => String(_id.employeeId) === employeeId && _id.day === today).reduce((sum, { count }) => sum + count, 0),
      todaySanctionCount: sanctionDays.filter(({ _id }) => String(_id.employeeId) === employeeId && _id.day === today).reduce((sum, { count }) => sum + count, 0),
      monthLoginCount: loginDays.filter(({ _id }) => String(_id.employeeId) === employeeId).reduce((sum, { count }) => sum + count, 0),
      monthSanctionCount: sanctionDays.filter(({ _id }) => String(_id.employeeId) === employeeId).reduce((sum, { count }) => sum + count, 0),
    }
  }).sort((left, right) => left.employeeRole.localeCompare(right.employeeRole) || left.employeeName.localeCompare(right.employeeName))
  const ownId = String(req.employee._id)
  const own = team.find(({ employeeId }) => employeeId === ownId) || {
    employeeId: ownId, employeeName: req.employee.name, employeeRole: req.employee.role,
    loginCount: 0, sanctionCount: 0, todayLoginCount: 0, todaySanctionCount: 0, monthLoginCount: 0, monthSanctionCount: 0,
  }
  const graph = new Map()
  for (const row of loginDays) {
    if (!graph.has(row._id.day)) graph.set(row._id.day, { date: row._id.day, logins: 0, sanctions: 0 })
    graph.get(row._id.day).logins += row.count
  }
  for (const row of sanctionDays) {
    if (!graph.has(row._id.day)) graph.set(row._id.day, { date: row._id.day, logins: 0, sanctions: 0 })
    graph.get(row._id.day).sanctions += row.count
  }
  return res.json({
    success: true,
    data: {
      timezone: 'Asia/Kolkata',
      asOfDate: today,
      monthStart,
      nextMonthStart,
      own,
      team: team.filter(({ employeeId }) => employeeId !== ownId),
      teamTotals: {
        loginCount: loginTotals.reduce((sum, row) => sum + row.count, 0),
        sanctionCount: sanctionTotals.reduce((sum, row) => sum + row.count, 0),
        todayLoginCount: dayCounts(loginDays, today),
        todaySanctionCount: dayCounts(sanctionDays, today),
        monthLoginCount: monthlyCounts(loginDays),
        monthSanctionCount: monthlyCounts(sanctionDays),
      },
      pendingLogins,
      pendingSanctions,
      monthlyPerformance: [...graph.values()].sort((left, right) => left.date.localeCompare(right.date)),
      employeeNames: Object.fromEntries([...employeesById].map(([id, employee]) => [id, employee.name])),
    },
  })
}))

router.get('/logins', requireEmployee, asyncHandler(async (req, res) => {
  const employeeIds = await getAuthorizedEmployeeIds(req.employee)
  const status = typeof req.query.status === 'string' && statuses.includes(req.query.status) ? req.query.status : null
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 30))
  const filter = { employeeId: { $in: employeeIds }, ...(status ? { loginStatus: status } : {}) }
  const [items, total] = await Promise.all([
    SuryaGharLogin.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SuryaGharLogin.countDocuments(filter),
  ])
  return res.json({ success: true, data: { items: items.map(serializeLoginDocuments), total, page, limit } })
}))

router.get('/sanctions', requireEmployee, asyncHandler(async (req, res) => {
  const employeeIds = await getAuthorizedEmployeeIds(req.employee)
  const status = typeof req.query.status === 'string' && statuses.includes(req.query.status) ? req.query.status : null
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 30))
  const filter = {
    $or: [{ employeeId: { $in: employeeIds } }, { submittedByEmployeeId: { $in: employeeIds } }],
    ...(status ? { sanctionStatus: status } : {}),
  }
  const [items, total] = await Promise.all([
    SuryaGharSanction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SuryaGharSanction.countDocuments(filter),
  ])
  return res.json({ success: true, data: { items: items.map(serializeSanctionDocument), total, page, limit } })
}))

router.get('/logins/:id/documents/:documentKey/preview', requireEmployee, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid login submission ID.' })
  if (!['eTokenProof', 'applicationAcknowledgement'].includes(req.params.documentKey)) {
    return res.status(404).json({ success: false, message: 'Document preview is unavailable.' })
  }
  const employeeIds = await getAuthorizedEmployeeIds(req.employee)
  const record = await SuryaGharLogin.findOne({
    _id: req.params.id,
    employeeId: { $in: employeeIds },
  }).select('documents').lean()
  if (!record) return res.status(404).json({ success: false, message: 'Submission not found.' })
  return sendDocumentPreview(res, record.documents?.[req.params.documentKey])
}))

router.get('/sanctions/:id/documents/feasibilityApprovalDocument/preview', requireEmployee, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid sanction submission ID.' })
  const employeeIds = await getAuthorizedEmployeeIds(req.employee)
  const record = await SuryaGharSanction.findOne({
    _id: req.params.id,
    $or: [
      { employeeId: { $in: employeeIds } },
      { submittedByEmployeeId: { $in: employeeIds } },
    ],
  }).select('feasibilityApprovalDocument').lean()
  if (!record) return res.status(404).json({ success: false, message: 'Submission not found.' })
  return sendDocumentPreview(res, record.feasibilityApprovalDocument)
}))

router.get('/admin/logins', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' && statuses.includes(req.query.status) ? req.query.status : 'PENDING'
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 30))
  const filter = { loginStatus: status }
  const [items, total] = await Promise.all([
    SuryaGharLogin.find(filter).populate('employeeId', 'name role').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SuryaGharLogin.countDocuments(filter),
  ])
  return res.json({ success: true, data: { items: items.map(serializeLoginDocuments), total, page, limit } })
}))

router.get('/admin/sanctions', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  const status = typeof req.query.status === 'string' && statuses.includes(req.query.status) ? req.query.status : 'PENDING'
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 30))
  const filter = { sanctionStatus: status }
  const [items, total] = await Promise.all([
    SuryaGharSanction.find(filter).populate('submittedByEmployeeId', 'name role').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SuryaGharSanction.countDocuments(filter),
  ])
  return res.json({ success: true, data: { items: items.map(serializeSanctionDocument), total, page, limit } })
}))

router.get('/admin/cleanup-jobs', requireAdmin, requireChangedPassword, asyncHandler(async (_req, res) => {
  const items = await DocumentCleanupJob.find({ status: { $in: ['FAILED', 'PROCESSING'] } })
    .select('recordType recordId documentKey status attempts nextAttemptAt lastError updatedAt')
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean()
  return res.json({ success: true, data: { items } })
}))

router.get('/admin/logins/:id/documents/:documentKey/preview', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid login submission ID.' })
  if (!['eTokenProof', 'applicationAcknowledgement'].includes(req.params.documentKey)) {
    return res.status(404).json({ success: false, message: 'Document preview is unavailable.' })
  }
  const record = await SuryaGharLogin.findById(req.params.id).lean()
  if (!record) return res.status(404).json({ success: false, message: 'Submission not found.' })
  return sendDocumentPreview(res, record.documents?.[req.params.documentKey])
}))

router.get('/admin/sanctions/:id/documents/feasibilityApprovalDocument/preview', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid sanction submission ID.' })
  const record = await SuryaGharSanction.findById(req.params.id).lean()
  if (!record) return res.status(404).json({ success: false, message: 'Submission not found.' })
  return sendDocumentPreview(res, record.feasibilityApprovalDocument)
}))

router.patch('/admin/logins/:id/review', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid login submission ID.' })
  const result = await setReviewStatus(SuryaGharLogin, req, req.params.id, 'loginStatus', 'loginVerifiedBy', 'loginVerifiedAt', 'login')
  if (result.response) return res.status(result.response.status).json({ success: false, message: result.response.message })
  return res.json({ success: true, data: serializeLoginDocuments(result.record) })
}))

router.patch('/admin/sanctions/:id/review', requireAdmin, requireChangedPassword, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid sanction submission ID.' })
  const result = await setReviewStatus(SuryaGharSanction, req, req.params.id, 'sanctionStatus', 'verifiedBy', 'sanctionVerifiedAt', 'sanction')
  if (result.response) return res.status(result.response.status).json({ success: false, message: result.response.message })
  return res.json({ success: true, data: serializeSanctionDocument(result.record) })
}))

export default router
