const assert = require('assert')
const { Duplex } = require('stream')
const { inflateSync } = require('zlib')
const { createDecipheriv } = require('crypto')
const Client = require('../../src/client')
const { createDeserializer } = require('../../src/transforms/serializer')
const [readVarInt] = require('protodef').types.varint

function stalledClient (version = '26.2', isServer = false) {
  const chunks = []
  let release
  const socket = new Duplex({
    writableHighWaterMark: 1,
    read () {},
    write (buffer, encoding, callback) {
      chunks.push(Buffer.from(buffer))
      release = callback
    }
  })
  const client = new Client(isServer, version, undefined, true)
  client.setSocket(socket)
  // Occupy a real writable stream before the protocol writes arrive.
  socket.write(Buffer.from([0]))
  assert.strictEqual(socket.writableNeedDrain, true)
  return {
    client,
    socket,
    chunks,
    async flush () {
      for (let i = 0; i < 10000; i++) {
        if (release) {
          const callback = release
          release = null
          callback()
        }
        await new Promise(resolve => setImmediate(resolve))
        if (!release && !client._writeQueue.length && !socket.writableLength) return
      }
      assert.fail('outbound pipeline did not drain')
    },
    wire () { return Buffer.concat(chunks.slice(1)) }
  }
}

function decodeWire (wire, expected, { version = '26.2', isServer = true, secret, compression = false } = {}) {
  if (secret) wire = createDecipheriv('aes-128-cfb8', secret, secret).update(wire)
  const packets = []
  let offset = 0
  for (const [state, name] of expected) {
    const length = readVarInt(wire, offset)
    offset += length.size
    let payload = wire.subarray(offset, offset + length.value)
    assert.strictEqual(payload.length, length.value)
    offset += length.value
    if (compression) {
      const uncompressed = readVarInt(payload, 0)
      payload = payload.subarray(uncompressed.size)
      if (uncompressed.value) {
        payload = inflateSync(payload)
        assert.strictEqual(payload.length, uncompressed.value)
      }
    }
    const parser = createDeserializer({ state, version, isServer, noErrorLogging: true })
    const parsed = parser.parsePacketBuffer(payload)
    assert.strictEqual(parsed.metadata.size, payload.length, `${state}.${name} consumed its whole frame`)
    assert.strictEqual(parsed.data.name, name)
    packets.push(parsed.data.params)
    parser.destroy()
  }
  assert.strictEqual(offset, wire.length, 'no missing, duplicated or extra packets')
  return packets
}

module.exports = { stalledClient, decodeWire }
