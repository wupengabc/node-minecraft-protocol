'use strict'

const nbt = require('prismarine-nbt')
const UUID = require('uuid-1345')
const zlib = require('zlib')
const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const [readLpVec3, writeLpVec3, sizeOfLpVec3] = require('./lpVec3')

module.exports = {
  varlong: [readVarLong, writeVarLong, sizeOfVarLong],
  optionalVarInt: [readOptionalVarInt, writeOptionalVarInt, sizeOfOptionalVarInt],
  clickActionNbt: [readClickActionNbt, writeClickActionNbt, sizeOfClickActionNbt],
  registryEntryHolder: [readRegistryEntryHolder, writeRegistryEntryHolder, sizeOfRegistryEntryHolder],
  registryEntryHolderSet: [readRegistryEntryHolderSet, writeRegistryEntryHolderSet, sizeOfRegistryEntryHolderSet],
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
// `onGround`, the accumulated delta in blocks as dX/dY/dZ, and the full `steps`
// list. VecDelta.Stepped.decode updates its base after each step.
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
      xa += sx; ya += sy; za += sz
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

function readRegistryEntryHolder (buffer, offset, opts) {
  const id = readVarInt(buffer, offset)
  if (id.value !== 0) return { value: { [opts.baseName]: id.value - 1 }, size: id.size }
  const data = this.read(buffer, offset + id.size, opts.otherwise.type, {})
  return { value: { [opts.otherwise.name]: data.value }, size: id.size + data.size }
}

function writeRegistryEntryHolder (value, buffer, offset, opts) {
  if (value[opts.baseName] != null) return writeVarInt(value[opts.baseName] + 1, buffer, offset)
  if (value[opts.otherwise.name] == null) throw new Error('Registry holder requires an ID or inline value')
  offset = writeVarInt(0, buffer, offset)
  return this.write(value[opts.otherwise.name], buffer, offset, opts.otherwise.type, {})
}

function sizeOfRegistryEntryHolder (value, opts) {
  if (value[opts.baseName] != null) return sizeOfVarInt(value[opts.baseName] + 1)
  if (value[opts.otherwise.name] == null) throw new Error('Registry holder requires an ID or inline value')
  return 1 + this.sizeOf(value[opts.otherwise.name], opts.otherwise.type, {})
}

function readRegistryEntryHolderSet (buffer, offset, opts) {
  const count = readVarInt(buffer, offset)
  if (count.value === 0) {
    const tag = this.read(buffer, offset + count.size, opts.base.type, {})
    return { value: { [opts.base.name]: tag.value }, size: count.size + tag.size }
  }
  if (count.value < 0) throw new RangeError('Invalid registry holder set size')
  const values = []
  let size = count.size
  for (let i = 0; i < count.value - 1; i++) {
    const entry = this.read(buffer, offset + size, opts.otherwise.type, {})
    values.push(entry.value)
    size += entry.size
  }
  return { value: { [opts.otherwise.name]: values }, size }
}

function writeRegistryEntryHolderSet (value, buffer, offset, opts) {
  if (value[opts.base.name] != null) {
    offset = writeVarInt(0, buffer, offset)
    return this.write(value[opts.base.name], buffer, offset, opts.base.type, {})
  }
  const values = value[opts.otherwise.name]
  if (!Array.isArray(values)) throw new Error('Registry holder set requires a tag or ID list')
  offset = writeVarInt(values.length + 1, buffer, offset)
  for (const entry of values) offset = this.write(entry, buffer, offset, opts.otherwise.type, {})
  return offset
}

function sizeOfRegistryEntryHolderSet (value, opts) {
  if (value[opts.base.name] != null) return 1 + this.sizeOf(value[opts.base.name], opts.base.type, {})
  const values = value[opts.otherwise.name]
  if (!Array.isArray(values)) throw new Error('Registry holder set requires a tag or ID list')
  return sizeOfVarInt(values.length + 1) + values.reduce((size, entry) => size + this.sizeOf(entry, opts.otherwise.type, {}), 0)
}

function readVarLong (buffer, offset) {
  let value = 0n
  for (let size = 0; size < 10; size++) {
    if (offset + size >= buffer.length) throw new PartialReadError()
    const byte = buffer[offset + size]
    value |= BigInt(byte & 0x7f) << BigInt(size * 7)
    if (!(byte & 0x80)) {
      const signed = BigInt.asIntN(64, value)
      const number = Number(signed)
      return { value: Number.isSafeInteger(number) ? number : signed, size: size + 1 }
    }
  }
  throw new Error('VarLong is too large')
}

function writeVarLong (value, buffer, offset) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('VarLong requires a safe integer or bigint')
  let remaining = BigInt.asUintN(64, BigInt(value))
  do {
    const byte = Number(remaining & 0x7fn)
    remaining >>= 7n
    buffer[offset++] = byte | (remaining ? 0x80 : 0)
  } while (remaining)
  return offset
}

function sizeOfVarLong (value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('VarLong requires a safe integer or bigint')
  let remaining = BigInt.asUintN(64, BigInt(value))
  let size = 1
  while (remaining >= 0x80n) {
    remaining >>= 7n
    size++
  }
  return size
}

function readOptionalVarInt (buffer, offset) {
  const result = readVarInt(buffer, offset)
  result.value = result.value === 0 ? undefined : result.value - 1
  return result
}

function writeOptionalVarInt (value, buffer, offset) {
  return writeVarInt(value == null ? 0 : value + 1, buffer, offset)
}

function sizeOfOptionalVarInt (value) {
  return sizeOfVarInt(value == null ? 0 : value + 1)
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

// ServerboundCustomClickActionPacket bounds an optional anonymous tag inside
// a byte-length-prefixed buffer, rather than a boolean-prefixed option.
function readClickActionNbt (buffer, offset) {
  const length = readVarInt(buffer, offset)
  if (length.value < 0 || length.value > 65536) throw new RangeError('Click action NBT exceeds 65536 bytes')
  const start = offset + length.size
  const end = start + length.value
  if (end > buffer.length) throw new PartialReadError()
  const tag = nbt.proto.read(buffer.subarray(start, end), 0, 'anonOptionalNbt')
  if (tag.size !== length.value) throw new Error('Click action NBT has trailing bytes')
  return { value: tag.value, size: length.size + length.value }
}

function writeClickActionNbt (value, buffer, offset) {
  const size = nbt.proto.sizeOf(value, 'anonOptionalNbt')
  if (size > 65536) throw new RangeError('Click action NBT exceeds 65536 bytes')
  offset = writeVarInt(size, buffer, offset)
  return nbt.proto.write(value, buffer, offset, 'anonOptionalNbt')
}

function sizeOfClickActionNbt (value) {
  const size = nbt.proto.sizeOf(value, 'anonOptionalNbt')
  if (size > 65536) throw new RangeError('Click action NBT exceeds 65536 bytes')
  return sizeOfVarInt(size) + size
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
