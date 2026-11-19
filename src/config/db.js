import mongoose from 'mongoose'

const globalConnection = globalThis.__marvexMongoConnection ?? {
  connection: null,
  promise: null,
}

globalThis.__marvexMongoConnection = globalConnection

export async function connectDatabase() {
  if (globalConnection.connection) return globalConnection.connection

  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI is required.')

  if (!globalConnection.promise) {
    globalConnection.promise = mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
    })
  }

  try {
    globalConnection.connection = await globalConnection.promise
    return globalConnection.connection
  } catch (error) {
    globalConnection.promise = null
    throw error
  }
}
