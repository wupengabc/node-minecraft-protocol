'use strict'
/* global ctx */

const { ProtoDef, Serializer, FullPacketParser } = require('protodef')
const { ProtoDefCompiler } = require('protodef').Compiler
const [readVarInt] = require('protodef').types.varint

// FullPacketParser that ALWAYS attaches the framed payload to parse errors.
// Protodef's stock FullPacketParser only sets e.buffer for non-PartialReadError
// failures, so RangeErrors raised inside native Buffer readers (negative
// offset from a corrupted cursor) can reach the client without the packet id.
class DiagnosticFullPacketParser extends FullPacketParser {
  _transform (chunk, enc, cb) {
    let packet
    try {
      packet = this.parsePacketBuffer(chunk)
      if (packet.metadata.size !== chunk.length && !this.noErrorLogging) {
        console.log('Chunk size is ' + chunk.length + ' but only ' + packet.metadata.size + ' was read ; partial packet : ' +
          JSON.stringify(packet.data) + '; buffer :' + chunk.toString('hex'))
      }
    } catch (e) {
      // Always attach the raw framed payload so the client error handler can
      // extract the packet id. Also bake the packet id directly into the error
      // message so it survives any downstream reformatting.
      let packetId
      try {
        const { value: id, size: idSize } = readVarInt(chunk, 0)
        packetId = id
        e.packetId = id
        e.packetHex = chunk.slice(0, Math.min(chunk.length, idSize + 8)).toString('hex')
      } catch (_) {
        packetId = undefined
      }
      e.buffer = chunk
      e.packetBuffer = chunk
      const tag = packetId !== undefined ? `packet 0x${packetId.toString(16)}` : 'unknown packet'
      if (!e.message) e.message = ''
      e.message = `[${tag} | ${chunk.length} bytes] ${e.message}`
      if (e.partialReadError) {
        if (!this.noErrorLogging) {
          console.log(e.stack)
        }
        return cb()
      }
      return cb(e)
    }
    this.push(packet)
    cb()
  }
}

const nbt = require('prismarine-nbt')
const minecraft = require('../datatypes/minecraft')
const states = require('../states')
const merge = require('lodash.merge')

const minecraftData = require('minecraft-data')
const protocols = {}

function createProtocol (state, direction, version, customPackets, compiled = true) {
  const key = `${state};${direction};${version}${compiled ? ';c' : ''}`
  if (protocols[key]) { return protocols[key] }

  const mcData = minecraftData(version)
  const versionInfo = minecraftData.versionsByMinecraftVersion.pc[version]
  if (mcData === null) {
    throw new Error(`No data available for version ${version}`)
  } else if (versionInfo && versionInfo.version !== mcData.version.version) {
    // The protocol version returned by node-minecraft-data constructor does not match the data in minecraft-data's protocolVersions.json
    throw new Error(`Unsupported protocol version '${versionInfo.version}' (attempted to use '${mcData.version.version}' data); try updating your packages with 'npm update'`)
  }

  const mergedProtocol = merge(mcData.protocol, customPackets?.[mcData.version.majorVersion] ?? {})

  if (compiled) {
    const compiler = new ProtoDefCompiler()
    compiler.addTypes(require('../datatypes/compiler-minecraft'))
    compiler.addProtocol(mergedProtocol, [state, direction])
    nbt.addTypesToCompiler('big', compiler)
    // Patch prismarine-nbt's compound reader. The stock implementation uses
    // `while (offset !== buffer.length)` which loops forever (and past the
    // buffer) once an embedded NBT tag corrupts the cursor, ultimately
    // surfacing as a RangeError on a negative offset. Replace it with a
    // bounds-safe loop.
    compiler.addTypes({
      Read: {
        compound: ['context', (buffer, offset) => {
          const results = { value: {}, size: 0 }
          while (offset < buffer.length) {
            const typ = ctx.i8(buffer, offset)
            if (typ.value === 0) {
              results.size += typ.size
              break
            }
            if (typ.value > 20) {
              throw new Error(`Invalid tag: ${typ.value} > 20`)
            }
            const readResults = ctx.nbt(buffer, offset)
            offset += readResults.size
            results.size += readResults.size
            results.value[readResults.value.name] = {
              type: readResults.value.type,
              value: readResults.value.value
            }
          }
          return results
        }]
      },
      Write: {
        compound: ['context', (value, buffer, offset) => {
          for (const key in value) {
            offset = ctx.nbt({
              name: key,
              type: value[key].type,
              value: value[key].value
            }, buffer, offset)
          }
          offset = ctx.i8(0, buffer, offset)
          return offset
        }]
      },
      SizeOf: {
        compound: ['context', (value) => {
          let size = 1
          for (const key in value) {
            size += ctx.nbt({
              name: key,
              type: value[key].type,
              value: value[key].value
            })
          }
          return size
        }]
      }
    })
    const proto = compiler.compileProtoDefSync()
    protocols[key] = proto
    return proto
  }

  const proto = new ProtoDef(false)
  proto.addTypes(minecraft)
  proto.addProtocol(mergedProtocol, [state, direction])
  nbt.addTypesToInterperter('big', proto)
  protocols[key] = proto
  return proto
}

function createSerializer ({ state = states.HANDSHAKING, isServer = false, version, customPackets, compiled = true } = {}) {
  return new Serializer(createProtocol(state, !isServer ? 'toServer' : 'toClient', version, customPackets, compiled), 'packet')
}

function createDeserializer ({ state = states.HANDSHAKING, isServer = false, version, customPackets, compiled = true, noErrorLogging = false } = {}) {
  return new DiagnosticFullPacketParser(createProtocol(state, isServer ? 'toServer' : 'toClient', version, customPackets, compiled), 'packet', noErrorLogging)
}

module.exports = {
  createSerializer,
  createDeserializer
}
