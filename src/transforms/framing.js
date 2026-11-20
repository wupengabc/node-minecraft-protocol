'use strict'

const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const { Duplex, Transform } = require('readable-stream')

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
const FRAME_TIME_CHECK_INTERVAL = 8
const FRAME_SLICE_MS = 8

// Framing is one-to-many. Own the write callback so neither Transform nor
// the splitter can leave it parked in a second, independent read gate.
class Splitter extends Duplex {
  constructor () {
    super()
    this.buffer = Buffer.alloc(0)
    this.recognizeLegacyPing = false
    this._frameOffset = 0
    this._frameCallback = null
    this._frameTask = null
    this._waitingForRead = false
  }

  get pendingFrameBytes () {
    return this.buffer.length - this._frameOffset
  }

  _write (chunk, enc, cb) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    this._frameCallback = cb

    if (this.recognizeLegacyPing && this.buffer[0] === LEGACY_PING_PACKET_ID) {
      // Legacy server-list pings are not length-prefixed.
      const header = Buffer.alloc(sizeOfVarInt(LEGACY_PING_PACKET_ID))
      writeVarInt(LEGACY_PING_PACKET_ID, header, 0)
      const payload = this.buffer.length > 1 ? this.buffer.subarray(1) : Buffer.from('\0')
      this._frameOffset = this.buffer.length
      if (!this.push(Buffer.concat([header, payload])) && !this.destroyed) {
        this._waitingForRead = true
        return
      }
      if (!this.destroyed) this._finishChunk()
      return
    }

    this._processFrames()
  }

  _read () {
    if (!this._waitingForRead) return
    this._waitingForRead = false
    this._scheduleFrames()
  }

  _scheduleFrames () {
    this._frameTask = setImmediate(() => {
      this._frameTask = null
      this._processFrames()
    })
  }

  _processFrames () {
    let frames = 0
    let timeBudgetReached = false
    const deadline = performance.now() + FRAME_SLICE_MS
    try {
      while (!this.destroyed && frames < MAX_FRAMES_PER_TICK && this._frameOffset < this.buffer.length) {
        const { value, size } = readVarInt(this.buffer, this._frameOffset)
        if (value < 0) throw new Error('Negative packet length')
        const start = this._frameOffset + size
        const end = start + value
        if (end > this.buffer.length) break

        this._frameOffset = end
        frames++
        const hasRoom = this.push(this.buffer.subarray(start, end))
        if (this.destroyed) return
        if (!hasRoom) {
          this._waitingForRead = true
          return
        }
        // push() can include synchronous parsing and application listeners.
        if (frames % FRAME_TIME_CHECK_INTERVAL === 0 && performance.now() >= deadline) {
          timeBudgetReached = true
          break
        }
      }
    } catch (err) {
      if (this.destroyed) return
      if (!err.partialReadError) return this._finishChunk(err)
    }

    if (this.destroyed) return
    if ((timeBudgetReached || frames === MAX_FRAMES_PER_TICK) && this._frameOffset < this.buffer.length) {
      // Keep yielding between batches even when all downstream stages are flowing.
      this._scheduleFrames()
      return
    }
    this._finishChunk()
  }

  _finishChunk (err) {
    const cb = this._frameCallback
    this._frameCallback = null
    this.buffer = !err && this._frameOffset < this.buffer.length
      ? Buffer.from(this.buffer.subarray(this._frameOffset))
      : Buffer.alloc(0)
    this._frameOffset = 0
    cb(err)
  }

  _final (cb) {
    this.buffer = Buffer.alloc(0)
    this.push(null)
    cb()
  }

  _destroy (err, cb) {
    this.unpipe()
    clearImmediate(this._frameTask)
    this._frameTask = null
    this._waitingForRead = false
    const writeCb = this._frameCallback
    this._frameCallback = null
    this._frameOffset = 0
    this.buffer = Buffer.alloc(0)
    if (writeCb) {
      const writeError = err ?? Object.assign(new Error('Splitter destroyed before completing the write'), { code: 'ERR_STREAM_DESTROYED' })
      writeCb(writeError)
    }
    cb(err)
  }
}
