/* eslint-env mocha */
'use strict'

const assert = require('assert')
const { once } = require('events')
const { deflateSync } = require('zlib')
const Client = require('../src/client')
const { createSerializer } = require('../src/transforms/serializer')
const [, writeVarInt, sizeOfVarInt] = require('protodef').types.varint

function varint (value) {
  const buffer = Buffer.alloc(sizeOfVarInt(value))
  writeVarInt(value, buffer, 0)
  return buffer
}

function frame (body) {
  return Buffer.concat([varint(body.length), body])
}

function encode (state, name, params = {}) {
  const encoder = createSerializer({ state, version: '26.3', isServer: true })
  const body = encoder.createPacketBuffer({ name, params })
  encoder.destroy()
  return body
}

describe('Client packet body observers', function () {
  this.timeout(5000)
  let client

  beforeEach(() => {
    client = new Client(false, '26.3', undefined, true)
    client.state = 'play'
  })

  afterEach(() => {
    client.splitter.destroy()
    client.deserializer.destroy()
    client.serializer.destroy()
    client.decompressor?.destroy()
    client.compressor?.destroy()
  })

  it('observes normal, unknown, partial and hard-failing bodies before parsing, and survives recovery', async () => {
    const good = encode('play', 'keep_alive', { keepAliveId: 42n })
    const unknown = Buffer.from('ff01abcd', 'hex')
    const partial = good.subarray(0, 1)
    // Real advancements decoder failure: an impossible added-array count.
    const malformed = Buffer.from('850101ffffffff07', 'hex')
    const observed = []
    const parsed = []
    const errors = []
    client.on('error', error => errors.push(error))
    client.on('keep_alive', packet => {
      assert.strictEqual(observed.length, parsed.length === 0 ? 1 : 5)
      parsed.push(packet)
    })
    const raw = []
    client.on('rawPacket', packet => raw.push(packet))
    const failures = []
    client.on('malformedPacket', packet => failures.push(packet))
    client.addPacketBodyObserver((body, state) => observed.push({ body, state }))
    const oldParser = client.deserializer
    client.splitter.write(Buffer.concat([good, unknown, partial, malformed, good].map(frame)))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepStrictEqual(observed.map(({ body }) => body), [good, unknown, partial, malformed, good])
    assert.ok(observed.every(({ state }) => state === 'play'))
    assert.strictEqual(parsed.length, 2)
    assert.strictEqual(raw.length, 1)
    assert.deepStrictEqual(raw[0].buffer, unknown)
    assert.strictEqual(failures.length, 1)
    assert.deepStrictEqual(failures[0].buffer, malformed)
    assert.notStrictEqual(client.deserializer, oldParser)
    assert.deepStrictEqual(errors, [])
  })

  it('observes both bundle delimiters in wire order before bundled packet delivery', () => {
    const delimiter = encode('play', 'bundle_delimiter')
    const keepAlive = encode('play', 'keep_alive', { keepAliveId: 7n })
    const observed = []
    let delivered = 0
    client.addPacketBodyObserver(body => observed.push(body))
    client.on('keep_alive', () => { delivered++; assert.strictEqual(observed.length, 3) })
    client.splitter.write(Buffer.concat([delimiter, keepAlive].map(frame)))
    assert.strictEqual(delivered, 0)
    assert.deepStrictEqual(observed, [delimiter, keepAlive])
    client.splitter.write(frame(delimiter))
    assert.deepStrictEqual(observed, [delimiter, keepAlive, delimiter])
    assert.strictEqual(delivered, 1)
  })

  it('isolates mutations and throwing observers from the parser and other observers', () => {
    const body = encode('play', 'keep_alive', { keepAliveId: 123n })
    const observed = []
    client.addPacketBodyObserver(copy => { Buffer.from(copy.buffer).fill(0); throw new Error('observer failed') })
    client.addPacketBodyObserver(copy => observed.push(copy))
    let decoded
    client.on('keep_alive', packet => { decoded = packet })
    client.deserializer.write(body)
    assert.deepStrictEqual(observed, [body])
    assert.notStrictEqual(observed[0], body)
    assert.notStrictEqual(observed[0].buffer, body.buffer)
    assert.strictEqual(BigInt(decoded.keepAliveId.toString()), 123n)
    observed[0].fill(0)
    assert.notStrictEqual(body[0], 0)
  })

  it('validates callbacks and gives repeated registrations independent idempotent unsubscribe functions', () => {
    for (const listener of [null, undefined, 1, {}, 'listener']) {
      assert.throws(() => client.addPacketBodyObserver(listener), TypeError)
    }
    const body = encode('play', 'keep_alive', { keepAliveId: 1n })
    const copies = []
    const listener = body => copies.push(body)
    const unsubscribeFirst = client.addPacketBodyObserver(listener)
    const unsubscribeSecond = client.addPacketBodyObserver(listener)
    client.deserializer.write(body)
    assert.strictEqual(copies.length, 2)
    assert.notStrictEqual(copies[0], copies[1])
    unsubscribeFirst()
    unsubscribeFirst()
    client.deserializer.write(body)
    assert.strictEqual(copies.length, 3)
    unsubscribeSecond()
    client.deserializer.write(body)
    assert.strictEqual(copies.length, 3)
  })

  it('keeps subscriptions across state switches and captures the state of the parser', () => {
    const observed = []
    client.addPacketBodyObserver((body, state) => observed.push({ body, state }))
    const playParser = client.deserializer
    client.state = 'configuration'
    const configuration = encode('configuration', 'keep_alive', { keepAliveId: 1n })
    client.deserializer.write(configuration)
    const play = encode('play', 'keep_alive', { keepAliveId: 2n })
    // An old parser must report its creation state even after client.state changed.
    playParser.write(play)
    client._rebuildDeserializer()
    client.deserializer.write(configuration)
    client.state = 'play'
    client.deserializer.write(play)
    assert.deepStrictEqual(observed, [
      { body: configuration, state: 'configuration' },
      { body: play, state: 'play' },
      { body: configuration, state: 'configuration' },
      { body: play, state: 'play' }
    ])
    playParser.destroy()
  })

  it('keeps the parser state stable when an earlier observer changes client.state', () => {
    const body = encode('play', 'keep_alive', { keepAliveId: 1n })
    const states = []
    const parser = client.deserializer
    client.addPacketBodyObserver(() => { client.state = 'configuration' })
    client.addPacketBodyObserver((body, state) => states.push(state))
    parser.write(body)
    assert.deepStrictEqual(states, ['play'])
    assert.strictEqual(client.state, 'configuration')
    parser.destroy()
  })

  for (const compressed of [false, true]) {
    it(`sees decompressed bodies without frame or compression headers (${compressed ? 'compressed' : 'uncompressed'} transport)`, async () => {
      client.setCompressionThreshold(0)
      const body = encode('play', 'keep_alive', { keepAliveId: 6n })
      const wireBody = compressed
        ? Buffer.concat([varint(body.length), deflateSync(body)])
        : Buffer.concat([varint(0), body])
      const observed = []
      client.addPacketBodyObserver(copy => observed.push(copy))
      const received = once(client, 'keep_alive')
      client.splitter.write(frame(wireBody))
      await received
      assert.deepStrictEqual(observed, [body])
    })
  }
})
