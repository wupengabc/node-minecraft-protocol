/* eslint-env mocha */

const assert = require('assert')
const { stalledClient, decodeWire } = require('./common/outbound')
const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint

function plainFrame (client, name, params) {
  const payload = client.serializer.createPacketBuffer({ name, params })
  const frame = Buffer.alloc(sizeOfVarInt(payload.length) + payload.length)
  const size = writeVarInt(payload.length, frame, 0)
  payload.copy(frame, size)
  return frame
}

describe('outbound packet queue', function () {
  it('preserves movement, teleport, action and every tick boundary through real socket backpressure', async function () {
    const fixture = stalledClient()
    const { client, socket } = fixture
    client.state = 'play'
    const flags = { onGround: true, hasHorizontalCollision: false }
    const packets = [
      ['position', { x: 1, y: 2, z: 3, flags }],
      ['position_look', { x: 2, y: 2, z: 3, yaw: 90, pitch: 0, flags }],
      ['position', { x: 3, y: 2, z: 3, flags }],
      ['teleport_confirm', { teleportId: 7 }],
      ['position_look', { x: 10, y: 2, z: 3, yaw: 0, pitch: 0, flags }],
      ['held_item_slot', { slotId: 2 }],
      ['attack', { entityId: 42 }],
      ['arm_animation', { hand: 0 }],
      ['tick_end', {}],
      ['look', { yaw: 90, pitch: 0, flags }],
      ['tick_end', {}],
      ['tick_end', {}],
      ['keep_alive', { keepAliveId: 1n }]
    ]
    assert.strictEqual(client.writeBackpressured, true)
    for (const [name, params] of packets) {
      if (name === 'attack' || name === 'arm_animation' || name === 'keep_alive') client.writePriority(name, params)
      else client.write(name, params)
    }
    assert.strictEqual(fixture.chunks.length, 1, 'all packets wait behind the stalled socket write')
    assert.strictEqual(client.writeBackpressured, true)
    await fixture.flush()
    const decoded = decodeWire(fixture.wire(), packets.map(([name]) => ['play', name]))
    assert.deepStrictEqual(decoded.slice(0, 3).map(p => p.x), [1, 2, 3])
    assert.strictEqual(decoded[4].x, 10)
    assert.strictEqual(decoded[5].slotId, 2)
    assert.strictEqual(client.writeBackpressured, false)
    socket.destroy()
  })

  it('orders raw and named packets together and snapshots parameters before a stall', async function () {
    const fixture = stalledClient()
    const { client, socket } = fixture
    client.state = 'play'
    const params = { slotId: 1 }
    client.write('held_item_slot', params)
    params.slotId = 9
    client.writeRaw(client.serializer.createPacketBuffer({ name: 'held_item_slot', params: { slotId: 2 } }))
    client.writePriority('held_item_slot', { slotId: 3 })
    await fixture.flush()
    const packets = decodeWire(fixture.wire(), Array(3).fill(['play', 'held_item_slot']))
    assert.deepStrictEqual(packets.map(p => p.slotId), [1, 2, 3])
    socket.destroy()
  })

  it('drains final queued bytes before ending the socket', async function () {
    const fixture = stalledClient()
    const { client, socket } = fixture
    client.state = 'play'
    client.write('tick_end', {})
    client.end('test')
    await fixture.flush()
    assert.strictEqual(socket.writableEnded, true)
    decodeWire(fixture.wire(), [['play', 'tick_end']])
    socket.destroy()
  })

  it('keeps an encryption response plaintext and encrypts only subsequent bytes during a stall', async function () {
    const fixture = stalledClient()
    const { client, socket } = fixture
    client.state = 'login'
    const params = { sharedSecret: Buffer.from([1, 2]), verifyToken: Buffer.from([3, 4]) }
    const plaintext = plainFrame(client, 'encryption_begin', params)
    client.write('encryption_begin', params)
    const secret = Buffer.alloc(16, 13)
    client.setEncryption(secret)
    client.write('login_acknowledged', {})
    client.state = 'configuration'
    client.write('finish_configuration', {})
    await fixture.flush()
    const wire = fixture.wire()
    assert.deepStrictEqual(wire.subarray(0, plaintext.length), plaintext)
    decodeWire(plaintext, [['login', 'encryption_begin']])
    decodeWire(wire.subarray(plaintext.length), [['login', 'login_acknowledged'], ['configuration', 'finish_configuration']], { secret })
    socket.destroy()
  })

  it('keeps compression negotiation uncompressed and applies threshold changes only to later packets', async function () {
    const fixture = stalledClient('26.2', true)
    const { client, socket } = fixture
    client.state = 'login'
    const plaintext = plainFrame(client, 'compress', { threshold: 0 })
    client.write('compress', { threshold: 0 })
    client.setCompressionThreshold(0)
    client.write('success', { uuid: '00000000-0000-0000-0000-000000000001', sessionId: '00000000-0000-0000-0000-000000000001', username: 'test', properties: [] })
    client.setCompressionThreshold(10000)
    client.write('success', { uuid: '00000000-0000-0000-0000-000000000002', sessionId: '00000000-0000-0000-0000-000000000002', username: 'test2', properties: [] })
    await fixture.flush()
    const wire = fixture.wire()
    const compressed = wire.subarray(plaintext.length)
    const compressedLength = readVarInt(compressed, 0)
    const uncompressed = compressed.subarray(compressedLength.size + compressedLength.value)
    // The same compression envelope carries an inflated length for the first
    // success and zero for the second, whose threshold has changed.
    assert.ok(readVarInt(compressed, readVarInt(compressed, 0).size).value > 0)
    assert.strictEqual(readVarInt(uncompressed, readVarInt(uncompressed, 0).size).value, 0)
    assert.deepStrictEqual(wire.subarray(0, plaintext.length), plaintext)
    decodeWire(plaintext, [['login', 'compress']], { isServer: false })
    const decoded = decodeWire(wire.subarray(plaintext.length), [['login', 'success'], ['login', 'success']], { isServer: false, compression: true })
    assert.deepStrictEqual(decoded.map(p => p.username), ['test', 'test2'])
    socket.destroy()
  })

  it('retains large encoded output across state changes beyond serializer high water marks', async function () {
    const fixture = stalledClient()
    const { client, socket } = fixture
    const secret = Buffer.alloc(16, 5)
    client.setCompressionThreshold(256)
    client.setEncryption(secret)
    client.state = 'play'
    const expected = []
    for (let i = 0; i < 100; i++) {
      client.write('custom_payload', { channel: 'test:backlog', data: Buffer.alloc(2048, i) })
      expected.push(['play', 'custom_payload'])
    }
    client.write('configuration_acknowledged', {})
    expected.push(['play', 'configuration_acknowledged'])
    client.state = 'configuration'
    client.write('custom_payload', { channel: 'test:configuration', data: Buffer.alloc(2048, 123) })
    expected.push(['configuration', 'custom_payload'])
    client.write('finish_configuration', {})
    expected.push(['configuration', 'finish_configuration'])
    client.state = 'play'
    client.write('tick_end', {})
    expected.push(['play', 'tick_end'])
    client.end('test')
    await fixture.flush()
    const decoded = decodeWire(fixture.wire(), expected, { secret, compression: true })
    for (let i = 0; i < 100; i++) assert.deepStrictEqual(decoded[i].data, Buffer.alloc(2048, i))
    assert.deepStrictEqual(decoded[101].data, Buffer.alloc(2048, 123))
    socket.destroy()
  })

  it('reports serialization errors with the write-time state without poisoning later codecs', async function () {
    const fixture = stalledClient()
    const { client, socket } = fixture
    const errors = []
    client.on('error', err => {
      errors.push(err)
      client.write('position', {}) // A malformed error-response must not recurse.
    })
    client.state = 'play'
    client.write('position', { x: 'invalid', y: 0, z: 0 })
    client.write('held_item_slot', { slotId: 2 })
    client.state = 'configuration'
    client.write('finish_configuration', {})
    await fixture.flush()
    assert.strictEqual(errors.length, 1)
    assert.ok(errors[0].message.startsWith('Serialization error for play.toServer'))
    decodeWire(fixture.wire(), [['play', 'held_item_slot'], ['configuration', 'finish_configuration']])
    socket.destroy()
  })
})
