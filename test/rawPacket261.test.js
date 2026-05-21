'use strict'
/* eslint-env mocha */

const assert = require('assert')
const Client = require('../src/client')
const states = require('../src/states')
const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint

describe('rawPacket emission for unknown packet IDs (protocol 775)', function () {
  this.timeout(5000)
  let client

  beforeEach(function () {
    // Create a client with version 26.1.2 (protocol 775)
    client = new Client(false, '26.1.2', undefined, true)
  })

  it('should emit rawPacket when an unknown packet ID is received in Play state', function (done) {
    // Set state to PLAY to trigger the deserializer for play packets
    client.state = states.PLAY

    // Listen for rawPacket event
    client.on('rawPacket', (payload) => {
      assert.strictEqual(payload.state, states.PLAY)
      assert.strictEqual(payload.protocolVersion, 775)
      assert.strictEqual(payload.packetId, 0xFF) // Unknown packet ID
      assert.ok(Buffer.isBuffer(payload.buffer))
      done()
    })

    // Ensure no 'error' event is emitted
    client.on('error', (err) => {
      done(new Error('Should not emit error for unknown packet ID, got: ' + err.message))
    })

    // Create a buffer with an unknown VarInt packet ID (0xFF = 255, which is beyond 0x8C)
    const packetId = 0xFF
    const idSize = sizeOfVarInt(packetId)
    const buf = Buffer.alloc(idSize + 4) // packet ID + some dummy payload
    writeVarInt(packetId, buf, 0)
    buf.fill(0xAB, idSize) // dummy payload bytes

    // Feed the buffer directly to the deserializer
    client.deserializer.write(buf)
  })

  it('should NOT emit rawPacket for non-775 protocol versions', function (done) {
    // Create a client with an older version (1.20.4, protocol != 775)
    const oldClient = new Client(false, '1.20.4', undefined, true)
    oldClient.state = states.PLAY

    // For non-775 protocols, unknown packet IDs should still emit normal 'packet' event
    // (the compiled protodef returns numeric name + undefined params for unknown IDs)
    oldClient.on('packet', (data, meta) => {
      if (typeof meta.name === 'number') {
        // Non-775 protocol should NOT intercept unknown packets as rawPacket
        done()
      }
    })

    oldClient.on('rawPacket', () => {
      done(new Error('Should not emit rawPacket for non-775 protocol'))
    })

    // Create a buffer with an unknown VarInt packet ID
    const packetId = 0xFF
    const idSize = sizeOfVarInt(packetId)
    const buf = Buffer.alloc(idSize + 4)
    writeVarInt(packetId, buf, 0)
    buf.fill(0xAB, idSize)

    oldClient.deserializer.write(buf)
  })

  it('should continue processing subsequent packets after rawPacket', function (done) {
    client.state = states.PLAY

    let rawPacketCount = 0

    client.on('rawPacket', (payload) => {
      rawPacketCount++
      assert.strictEqual(payload.protocolVersion, 775)

      if (rawPacketCount === 1) {
        assert.strictEqual(payload.packetId, 0xFF)
        // After first rawPacket, send a second unknown packet to verify stream continues
        const packetId2 = 0xFE
        const idSize2 = sizeOfVarInt(packetId2)
        const buf2 = Buffer.alloc(idSize2 + 2)
        writeVarInt(packetId2, buf2, 0)
        buf2.fill(0xCD, idSize2)
        client.deserializer.write(buf2)
      }

      if (rawPacketCount === 2) {
        // Both unknown packets were handled without crashing
        assert.strictEqual(payload.packetId, 0xFE)
        done()
      }
    })

    client.on('error', (err) => {
      done(new Error('Should not emit error, got: ' + err.message))
    })

    // Send first unknown packet
    const packetId = 0xFF
    const idSize = sizeOfVarInt(packetId)
    const buf = Buffer.alloc(idSize + 4)
    writeVarInt(packetId, buf, 0)
    buf.fill(0xAB, idSize)
    client.deserializer.write(buf)
  })

  it('should include correct packetId in rawPacket payload', function (done) {
    client.state = states.PLAY

    client.on('rawPacket', (payload) => {
      // 0x8D is one beyond the valid range (0x00..0x8C)
      assert.strictEqual(payload.packetId, 0x8D)
      done()
    })

    client.on('error', (err) => {
      done(new Error('Should not emit error, got: ' + err.message))
    })

    const packetId = 0x8D
    const idSize = sizeOfVarInt(packetId)
    const buf = Buffer.alloc(idSize + 2)
    writeVarInt(packetId, buf, 0)
    buf.fill(0x00, idSize)
    client.deserializer.write(buf)
  })

  it('should NOT emit rawPacket for valid known packet IDs', function (done) {
    client.state = states.PLAY

    client.on('rawPacket', () => {
      done(new Error('Should not emit rawPacket for known packet IDs'))
    })

    // 'keep_alive' (a known packet) should go through normal packet path
    client.on('packet', (data, meta) => {
      if (typeof meta.name === 'string') {
        // Known packet received as string name - success
        done()
      }
    })

    // Use keep_alive packet (0x2C in 26.1 play toClient) - it has a single i64 field
    // We need to construct a valid keep_alive packet buffer
    const packetId = 0x2C
    const idSize = sizeOfVarInt(packetId)
    const buf = Buffer.alloc(idSize + 8) // packet ID + 8 bytes for i64 keepAliveId
    writeVarInt(packetId, buf, 0)
    // Write a dummy i64 value (8 bytes)
    buf.writeBigInt64BE(12345n, idSize)
    client.deserializer.write(buf)
  })
})
