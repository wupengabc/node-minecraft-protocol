'use strict'

const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const Transform = require('readable-stream').Transform

module.exports.createSplitter = function () {
  return new Splitter()
}

module.exports.createFramer = function () {
  return new Framer()
}

class Framer extends Transform {
  _transform (chunk, enc, cb) {
    const varIntSize = sizeOfVarInt(chunk.length)
    const buffer = Buffer.alloc(varIntSize + chunk.length)
    writeVarInt(chunk.length, buffer, 0)
    chunk.copy(buffer, varIntSize)
    this.push(buffer)
    return cb()
  }
}

const LEGACY_PING_PACKET_ID = 0xfe
const MAX_FRAMES_PER_TICK = 128

class Splitter extends Transform {
  constructor () {
    super()
    this.buffer = Buffer.alloc(0)
    this.recognizeLegacyPing = false
  }

  _transform (chunk, enc, cb) {
    this.buffer = Buffer.concat([this.buffer, chunk])

    if (this.recognizeLegacyPing && this.buffer[0] === LEGACY_PING_PACKET_ID) {
      // legacy_server_list_ping packet follows a different protocol format
      // prefix the encoded varint packet id for the deserializer
      const header = Buffer.alloc(sizeOfVarInt(LEGACY_PING_PACKET_ID))
      writeVarInt(LEGACY_PING_PACKET_ID, header, 0)
      let payload = this.buffer.slice(1) // remove 0xfe packet id
      if (payload.length === 0) payload = Buffer.from('\0') // TODO: update minecraft-data to recognize a lone 0xfe, https://github.com/PrismarineJS/minecraft-data/issues/95
      this.push(Buffer.concat([header, payload]))
      this.buffer = Buffer.alloc(0)
      return cb()
    }

    const processFrames = () => {
      let offset = 0
      let frames = 0
      try {
        while (frames < MAX_FRAMES_PER_TICK && offset < this.buffer.length) {
          const { value, size } = readVarInt(this.buffer, offset)
          if (this.buffer.length < offset + size + value) break

          this.push(this.buffer.slice(offset + size, offset + size + value))
          offset += size + value
          frames += 1
        }
      } catch (e) {
        if (!e.partialReadError) return cb(e)
      }

      this.buffer = this.buffer.slice(offset)
      if (frames === MAX_FRAMES_PER_TICK && this.buffer.length > 0) {
        // Large entity updates can contain thousands of frames. Yielding keeps
        // chat, keepalive, and application timers responsive without reordering.
        setImmediate(processFrames)
        return
      }
      cb()
    }

    processFrames()
  }
}
