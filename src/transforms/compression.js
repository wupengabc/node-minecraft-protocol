'use strict'

const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const zlib = require('zlib')
const Transform = require('readable-stream').Transform

module.exports.createCompressor = function (threshold) {
  return new Compressor(threshold)
}

module.exports.createDecompressor = function (threshold, hideErrors) {
  return new Decompressor(threshold, hideErrors)
}

class Compressor extends Transform {
  constructor (compressionThreshold = -1) {
    super()
    this.compressionThreshold = compressionThreshold
  }

  _transform (chunk, enc, cb) {
    if (chunk.length >= this.compressionThreshold) {
      try {
        const newChunk = zlib.deflateSync(chunk)
        const buf = Buffer.alloc(sizeOfVarInt(chunk.length) + newChunk.length)
        const offset = writeVarInt(chunk.length, buf, 0)
        newChunk.copy(buf, offset)
        this.push(buf)
        return cb()
      } catch (err) {
        return cb(err)
      }
    } else {
      const buf = Buffer.alloc(sizeOfVarInt(0) + chunk.length)
      const offset = writeVarInt(0, buf, 0)
      chunk.copy(buf, offset)
      this.push(buf)
      return cb()
    }
  }
}

class Decompressor extends Transform {
  constructor (compressionThreshold = -1, hideErrors = false) {
    super()
    this.compressionThreshold = compressionThreshold
    this.hideErrors = hideErrors
    this.droppedFrames = 0
  }

  _transform (chunk, enc, cb) {
    let body
    try {
      const { size, value } = readVarInt(chunk, 0)
      if (value < 0) throw new Error('Invalid decompressed length')
      body = value === 0
        ? chunk.subarray(size)
        : zlib.unzipSync(chunk.subarray(size), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
      if (value !== 0 && body.length !== value) throw new Error('Unexpected decompressed length')
    } catch (err) {
      // The splitter has already isolated this frame, so the next frame is
      // still usable. Do not log the frame or catch downstream listener errors
      // here: they are not decompression failures.
      this.droppedFrames++
      if (!this.hideErrors) console.error('problem inflating chunk:', err.message)
      return cb()
    }
    this.push(body)
    cb()
  }
}
