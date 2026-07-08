const mongoose = require('mongoose')
const { GridFSBucket } = require('mongodb')
const { Readable } = require('stream')

function getBucket() {
  const db = mongoose.connection.db
  if (!db) throw new Error('MongoDB not connected')
  return new GridFSBucket(db, { bucketName: 'documents' })
}

async function uploadBuffer(buffer, filename, contentType) {
  const bucket = getBucket()
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, { contentType })
    const readable = Readable.from(buffer)
    readable.pipe(uploadStream)
    uploadStream.on('finish', () => resolve(uploadStream.id))
    uploadStream.on('error', reject)
  })
}

async function downloadBuffer(fileId) {
  const bucket = getBucket()
  const objectId = typeof fileId === 'string' ? new mongoose.Types.ObjectId(fileId) : fileId
  return new Promise((resolve, reject) => {
    const chunks = []
    const downloadStream = bucket.openDownloadStream(objectId)
    downloadStream.on('data', (chunk) => chunks.push(chunk))
    downloadStream.on('end', () => resolve(Buffer.concat(chunks)))
    downloadStream.on('error', reject)
  })
}

async function deleteFile(fileId) {
  const bucket = getBucket()
  const objectId = typeof fileId === 'string' ? new mongoose.Types.ObjectId(fileId) : fileId
  await bucket.delete(objectId)
}

module.exports = { uploadBuffer, downloadBuffer, deleteFile }
