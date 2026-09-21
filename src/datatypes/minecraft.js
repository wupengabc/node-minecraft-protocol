'use strict'

const nbt = require('prismarine-nbt')
const UUID = require('uuid-1345')
const zlib = require('zlib')
const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const [readLpVec3, writeLpVec3, sizeOfLpVec3] = require('./lpVec3')

module.exports = {
  varlong: [readVarLong, writeVarLong, sizeOfVarLong],
  UUID: [readUUID, writeUUID, 16],
  compressedNbt: [readCompressedNbt, writeCompressedNbt, sizeOfCompressedNbt],
  restBuffer: [readRestBuffer, writeRestBuffer, sizeOfRestBuffer],
  entityMetadataLoop: [readEntityMetadata, writeEntityMetadata, sizeOfEntityMetadata],
  topBitSetTerminatedArray: [readTopBitSetTerminatedArray, writeTopBitSetTerminatedArray, sizeOfTopBitSetTerminatedArray],
  lpVec3: [readLpVec3, writeLpVec3, sizeOfLpVec3],
  vecDelta: [readVecDelta, writeVecDelta, sizeOfVecDelta]
}

// 26.3 ClientboundMoveEntityPacket.Pos/PosRot replaced the flat `short dx/dy/dz`
// triple with a `VecDelta`. The wire layout is a single packed varint followed
// by a variable-length payload whose shape depends on that varint:
//
//   packed    = varint, bit 0 = onGround, bits 1.. = stepCount
//   stepCount <= 0 -> Linear : short xa, short ya, short za
//   stepCount  > 0 -> Stepped: stepCount * (varint ticks, short xa, ya, za)
//
// Deltas are scaled by VecDeltaCodec's 4096 (encode = round(v * 4096)). The
// step count gates the payload length, so this cannot be expressed with
// protodef switch/array types and is implemented natively. The value exposes
// `onGround`, the final-step delta in blocks as x/y/z (matching the old dX-style
// flat fields), and the full `steps` list.
const VEC_DELTA_SCALE = 4096

function readVecDelta (buffer, offset) {
  const start = offset
  let packed = 0
  let shift = 0
  while (true) {
    if (offset >= buffer.length) throw new PartialReadError('vecDelta: unexpected end reading packed header')
    const byte = buffer.readUInt8(offset++)
    packed |= (byte & 0x7f) << shift
    if (!(byte & 0x80)) break
    shift += 7
    if (shift > 35) throw new PartialReadError('vecDelta: packed header varint too large')
  }
  const stepCount = packed >>> 1
  const onGround = (packed & 1) === 1

  const steps = []
  let xa = 0
  let ya = 0
  let za = 0
  if (stepCount > 0) {
    for (let i = 0; i < stepCount; i++) {
      let ticks = 0
      let tshift = 0
      while (true) {
        if (offset >= buffer.length) throw new PartialReadError('vecDelta: unexpected end reading step ticks')
        const byte = buffer.readUInt8(offset++)
        ticks |= (byte & 0x7f) << tshift
        if (!(byte & 0x80)) break
        tshift += 7
        if (tshift > 35) throw new PartialReadError('vecDelta: step ticks varint too large')
      }
      if (offset + 6 > buffer.length) throw new PartialReadError('vecDelta: unexpected end reading step delta')
      const sx = buffer.readInt16BE(offset); offset += 2
      const sy = buffer.readInt16BE(offset); offset += 2
      const sz = buffer.readInt16BE(offset); offset += 2
      steps.push({ ticks, x: sx / VEC_DELTA_SCALE, y: sy / VEC_DELTA_SCALE, z: sz / VEC_DELTA_SCALE })
      xa = sx; ya = sy; za = sz
    }
  } else {
    if (offset + 6 > buffer.length) throw new PartialReadError('vecDelta: unexpected end reading linear delta')
    xa = buffer.readInt16BE(offset); offset += 2
    ya = buffer.readInt16BE(offset); offset += 2
    za = buffer.readInt16BE(offset); offset += 2
  }

  return {
    value: {
      onGround,
      dX: xa / VEC_DELTA_SCALE,
      dY: ya / VEC_DELTA_SCALE,
      dZ: za / VEC_DELTA_SCALE,
      steps
    },
    size: offset - start
  }
}

function writeVecDelta (value, buffer, offset) {
  const steps = value.steps || []
  const stepCount = steps.length
  const packed = ((stepCount << 1) | (value.onGround ? 1 : 0)) >>> 0
  offset = writeVarInt(packed, buffer, offset)
  if (stepCount > 0) {
    for (const step of steps) {
      offset = writeVarInt(step.ticks, buffer, offset)
      offset = buffer.writeInt16BE(Math.round(step.x * VEC_DELTA_SCALE), offset)
      offset = buffer.writeInt16BE(Math.round(step.y * VEC_DELTA_SCALE), offset)
      offset = buffer.writeInt16BE(Math.round(step.z * VEC_DELTA_SCALE), offset)
    }
  } else {
    offset = buffer.writeInt16BE(Math.round((value.dX || 0) * VEC_DELTA_SCALE), offset)
    offset = buffer.writeInt16BE(Math.round((value.dY || 0) * VEC_DELTA_SCALE), offset)
    offset = buffer.writeInt16BE(Math.round((value.dZ || 0) * VEC_DELTA_SCALE), offset)
  }
  return offset
}

function sizeOfVecDelta (value) {
  const steps = value.steps || []
  let size = sizeOfVarInt(((steps.length << 1) | (value.onGround ? 1 : 0)) >>> 0)
  if (steps.length > 0) {
    for (const step of steps) size += sizeOfVarInt(step.ticks) + 6
  } else {
    size += 6
  }
  return size
}
const PartialReadError = require('protodef').utils.PartialReadError

function readVarLong (buffer, offset) {
  return readVarInt(buffer, offset)
}

function writeVarLong (value, buffer, offset) {
  return writeVarInt(value, buffer, offset)
}

function sizeOfVarLong (value) {
  return sizeOfVarInt(value)
}

function readUUID (buffer, offset) {
  if (offset + 16 > buffer.length) { throw new PartialReadError() }
  return {
    value: UUID.stringify(buffer.slice(offset, 16 + offset)),
    size: 16
  }
}

function writeUUID (value, buffer, offset) {
  const buf = value.length === 32 ? Buffer.from(value, 'hex') : UUID.parse(value)
  buf.copy(buffer, offset)
  return offset + 16
}

function sizeOfNbt (value, { tagType } = { tagType: 'nbt' }) {
  return nbt.proto.sizeOf(value, tagType)
}

// Length-prefixed compressed NBT, see differences: http://wiki.vg/index.php?title=Slot_Data&diff=6056&oldid=4753
function readCompressedNbt (buffer, offset) {
  if (offset + 2 > buffer.length) { throw new PartialReadError() }
  const length = buffer.readInt16BE(offset)
  if (length === -1) return { size: 2 }
  if (offset + 2 + length > buffer.length) { throw new PartialReadError() }

  const compressedNbt = buffer.slice(offset + 2, offset + 2 + length)

  let nbtBuffer
  try {
    nbtBuffer = zlib.gunzipSync(compressedNbt) // TODO: async
  } catch (err) {
    throw new PartialReadError('zlib decompress failed: ' + err.message)
  }

  const results = nbt.proto.read(nbtBuffer, 0, 'nbt')
  return {
    size: length + 2,
    value: results.value
  }
}

function writeCompressedNbt (value, buffer, offset) {
  if (value === undefined) {
    buffer.writeInt16BE(-1, offset)
    return offset + 2
  }
  const nbtBuffer = Buffer.alloc(sizeOfNbt(value))
  nbt.proto.write(value, nbtBuffer, 0, 'nbt')

  const compressedNbt = zlib.gzipSync(nbtBuffer) // TODO: async
  compressedNbt.writeUInt8(0, 9) // clear the OS field to match MC

  buffer.writeInt16BE(compressedNbt.length, offset)
  compressedNbt.copy(buffer, offset + 2)
  return offset + 2 + compressedNbt.length
}

function sizeOfCompressedNbt (value) {
  if (value === undefined) { return 2 }

  const nbtBuffer = Buffer.alloc(sizeOfNbt(value, { tagType: 'nbt' }))
  nbt.proto.write(value, nbtBuffer, 0, 'nbt')

  const compressedNbt = zlib.gzipSync(nbtBuffer) // TODO: async

  return 2 + compressedNbt.length
}

function readRestBuffer (buffer, offset) {
  if (offset < 0 || offset > buffer.length) {
    throw new Error(`restBuffer read out of bounds: offset=${offset} bufferLength=${buffer.length}`)
  }
  return {
    value: buffer.slice(offset),
    size: buffer.length - offset
  }
}

function writeRestBuffer (value, buffer, offset) {
  value.copy(buffer, offset)
  return offset + value.length
}

function sizeOfRestBuffer (value) {
  return value.length
}

function readEntityMetadata (buffer, offset, { type, endVal }) {
  let cursor = offset
  const metadata = []
  let item
  while (true) {
    if (cursor + 1 > buffer.length) { throw new PartialReadError() }
    item = buffer.readUInt8(cursor)
    if (item === endVal) {
      return {
        value: metadata,
        size: cursor + 1 - offset
      }
    }
    const results = this.read(buffer, cursor, type, {})
    metadata.push(results.value)
    cursor += results.size
  }
}

function writeEntityMetadata (value, buffer, offset, { type, endVal }) {
  const self = this
  value.forEach(function (item) {
    offset = self.write(item, buffer, offset, type, {})
  })
  buffer.writeUInt8(endVal, offset)
  return offset + 1
}

function sizeOfEntityMetadata (value, { type }) {
  let size = 1
  for (let i = 0; i < value.length; ++i) {
    size += this.sizeOf(value[i], type, {})
  }
  return size
}

function readTopBitSetTerminatedArray (buffer, offset, { type }) {
  let cursor = offset
  const values = []
  let item
  while (true) {
    if (cursor + 1 > buffer.length) { throw new PartialReadError() }
    item = buffer.readUInt8(cursor)
    buffer[cursor] = buffer[cursor] & 127 // removes top bit
    const results = this.read(buffer, cursor, type, {})
    values.push(results.value)
    cursor += results.size
    if ((item & 128) === 0) { // check if top bit is set, if not last value
      return {
        value: values,
        size: cursor - offset
      }
    }
  }
}

function writeTopBitSetTerminatedArray (value, buffer, offset, { type }) {
  const self = this
  let prevOffset = offset
  value.forEach(function (item, i) {
    prevOffset = offset
    offset = self.write(item, buffer, offset, type, {})
    buffer[prevOffset] = i !== value.length - 1 ? (buffer[prevOffset] | 128) : buffer[prevOffset] // set top bit for all values but last
  })
  return offset
}

function sizeOfTopBitSetTerminatedArray (value, { type }) {
  let size = 0
  for (let i = 0; i < value.length; ++i) {
    size += this.sizeOf(value[i], type, {})
  }
  return size
}
