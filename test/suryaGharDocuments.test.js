import assert from 'node:assert/strict'
import test from 'node:test'
import { destroySuryaGharDocument } from '../src/utils/suryaGharDocuments.js'

test('refuses to delete Cloudinary assets outside the Surya Ghar document folder', async () => {
  await assert.rejects(
    destroySuryaGharDocument('marvex-energy/gallery/customer-proof', 'image'),
    /outside the Surya Ghar document folder/,
  )
})

test('refuses unsupported Cloudinary resource types without making a delete request', async () => {
  await assert.rejects(
    destroySuryaGharDocument('marvex-energy/surya-ghar/login/employee/etoken/proof', 'video'),
    /Unsupported Surya Ghar document resource type/,
  )
})
