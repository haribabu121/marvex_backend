import DocumentCleanupJob from '../models/DocumentCleanupJob.js'
import SuryaGharLogin from '../models/SuryaGharLogin.js'
import SuryaGharSanction from '../models/SuryaGharSanction.js'
import { destroySuryaGharDocument } from './suryaGharDocuments.js'

const LEASE_MS = 60 * 1000
const POLL_MS = 15 * 1000
let running = false

function documentPath(job) {
  if (job.recordType === 'sanction' && job.documentKey === 'feasibilityApprovalDocument') {
    return 'feasibilityApprovalDocument'
  }
  if (job.recordType === 'login' && ['eTokenProof', 'applicationAcknowledgement'].includes(job.documentKey)) {
    return `documents.${job.documentKey}`
  }
  const temporaryDocument = job.documentKey.match(/^temporaryDocuments\.(\d+)$/)
  if (temporaryDocument) return job.documentKey
  throw new Error('Unsupported cleanup document reference.')
}

function findReferencedDocumentPath(record, job) {
  const expected = documentPath(job)
  const readPath = (path) => {
    if (path.startsWith('documents.')) return record.documents?.[path.slice('documents.'.length)]
    if (path.startsWith('temporaryDocuments.')) return record.temporaryDocuments?.[Number(path.split('.')[1])]
    return record[path]
  }
  if (readPath(expected)?.publicId === job.publicId) return expected

  const fixedPaths = job.recordType === 'login'
    ? ['documents.eTokenProof', 'documents.applicationAcknowledgement']
    : ['feasibilityApprovalDocument']
  const matchingPath = fixedPaths.find((path) => readPath(path)?.publicId === job.publicId)
  if (matchingPath) return matchingPath
  const temporaryIndex = record.temporaryDocuments?.findIndex((document) => document.publicId === job.publicId) ?? -1
  return temporaryIndex >= 0 ? `temporaryDocuments.${temporaryIndex}` : null
}

function retryDelay(attempts) {
  return Math.min(6 * 60 * 60 * 1000, 30 * 1000 * (2 ** Math.min(attempts - 1, 10)))
}

async function getRecord(job) {
  if (job.recordType === 'login') return SuryaGharLogin.findById(job.recordId).lean()
  return SuryaGharSanction.findById(job.recordId).lean()
}

async function processNextJob() {
  const now = new Date()
  const job = await DocumentCleanupJob.findOneAndUpdate(
    {
      $or: [
        { status: { $in: ['PENDING', 'FAILED'] }, nextAttemptAt: { $lte: now } },
        { status: 'PROCESSING', lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: { status: 'PROCESSING', lockedUntil: new Date(now.getTime() + LEASE_MS) },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after', sort: { nextAttemptAt: 1, createdAt: 1 } },
  )
  if (!job) return false

  const record = await getRecord(job)
  const approved = job.recordType === 'login'
    ? record?.loginStatus === 'APPROVED'
    : record?.sanctionStatus === 'APPROVED'
  if (!approved) {
    await DocumentCleanupJob.updateOne(
      { _id: job._id, status: 'PROCESSING' },
      { $set: { status: 'PENDING', lockedUntil: null, nextAttemptAt: new Date(Date.now() + POLL_MS) } },
    )
    return true
  }

  const path = findReferencedDocumentPath(record, job)
  if (!path) {
    await DocumentCleanupJob.updateOne(
      { _id: job._id, status: 'PROCESSING' },
      {
        $set: {
          status: 'COMPLETED',
          completedAt: new Date(),
          lockedUntil: null,
          lastError: 'The asset is no longer referenced by this record; no Cloudinary deletion was attempted.',
        },
        $unset: { publicId: '' },
      },
    )
    return true
  }
  if (!path.startsWith('temporaryDocuments.')) {
    await DocumentCleanupJob.updateOne(
      { _id: job._id, status: 'PROCESSING' },
      {
        $set: { status: 'COMPLETED', completedAt: new Date(), lockedUntil: null, lastError: null },
        $unset: { publicId: '' },
      },
    )
    return true
  }
  const document = path.startsWith('documents.')
    ? record?.documents?.[path.slice('documents.'.length)]
    : path.startsWith('temporaryDocuments.')
      ? record?.temporaryDocuments?.[Number(path.split('.')[1])]
      : record?.[path]
  if (!document?.publicId) {
    await DocumentCleanupJob.updateOne(
      { _id: job._id, status: 'PROCESSING' },
      {
        $set: { status: 'COMPLETED', completedAt: new Date(), lockedUntil: null, lastError: null },
        $unset: { publicId: '' },
      },
    )
    return true
  }

  try {
    await destroySuryaGharDocument(job.publicId, job.resourceType)
    const Model = job.recordType === 'login' ? SuryaGharLogin : SuryaGharSanction
    const update = {
      $set: { [`${path}.deletionStatus`]: 'DELETED', [`${path}.deletionError`]: null },
      $unset: { [`${path}.secureUrl`]: '', [`${path}.publicId`]: '' },
    }
    await Model.updateOne(
      { _id: job.recordId, [job.recordType === 'login' ? 'loginStatus' : 'sanctionStatus']: 'APPROVED', [`${path}.publicId`]: job.publicId },
      update,
    )
    await DocumentCleanupJob.updateOne(
      { _id: job._id, status: 'PROCESSING' },
      { $set: { status: 'COMPLETED', completedAt: new Date(), lockedUntil: null, lastError: null } },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'Cloudinary cleanup failed.'
    const Model = job.recordType === 'login' ? SuryaGharLogin : SuryaGharSanction
    await Model.updateOne(
      { _id: job.recordId, [`${path}.publicId`]: job.publicId },
      { $set: { [`${path}.deletionStatus`]: 'FAILED', [`${path}.deletionError`]: message } },
    )
    await DocumentCleanupJob.updateOne(
      { _id: job._id, status: 'PROCESSING' },
      {
        $set: {
          status: 'FAILED',
          lockedUntil: null,
          lastError: message,
          nextAttemptAt: new Date(Date.now() + retryDelay(job.attempts)),
        },
      },
    )
    console.error('Surya Ghar document cleanup failed:', {
      jobId: String(job._id),
      recordType: job.recordType,
      recordId: String(job.recordId),
      documentKey: job.documentKey,
      attempt: job.attempts,
      message,
    })
  }
  return true
}

async function runWorker() {
  if (running) return
  running = true
  try {
    while (await processNextJob()) {
      // Drain currently eligible jobs before sleeping.
    }
  } catch (error) {
    console.error('Surya Ghar cleanup worker error:', error instanceof Error ? error.message : error)
  } finally {
    running = false
  }
}

export function startSuryaGharCleanupWorker() {
  const timer = setInterval(runWorker, POLL_MS)
  timer.unref()
  void runWorker()
  return () => clearInterval(timer)
}

export { processNextJob as processSuryaGharCleanupJob }
