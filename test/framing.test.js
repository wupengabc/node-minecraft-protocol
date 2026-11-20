/* eslint-env mocha */

const assert = require('assert')
const { Writable } = require('stream')
const { once } = require('events')
const { setImmediate: nextTurn } = require('timers/promises')
const framing = require('../src/transforms/framing')
const { createSerializer } = require('../src/transforms/serializer')
const [, writeVarInt, sizeOfVarInt] = require('protodef').types.varint

describe('framing splitter', function () {
  it('preserves the special legacy ping framing', async function () {
    const splitter = framing.createSplitter()
    splitter.recognizeLegacyPing = true
    const nextPacket = once(splitter, 'data')
    splitter.end(Buffer.from([0xfe]))
    const [packet] = await nextPacket
    assert.deepStrictEqual(packet, Buffer.from([0xfe, 0x01, 0x00]))
  })

  it('keeps trailing packets reachable during a large inbound batch', function (done) {
    const splitter = framing.createSplitter()
    const packetCount = 128 * 3
    const frames = Array.from({ length: packetCount }, () => Buffer.from([1, 0x01]))
    frames.push(Buffer.from([1, 0x7f]))

    let eventLoopYielded = false
    let received = 0
    splitter.on('data', (packet) => {
      received += 1
      if (packet[0] !== 0x7f) return
      assert.strictEqual(received, packetCount + 1)
      assert.strictEqual(eventLoopYielded, true)
      done()
    })

    splitter.write(Buffer.concat(frames))
    setImmediate(() => { eventLoopYielded = true })
  })
})

function makeFrames () {
  const serializer = createSerializer({ version: '26.3', state: 'play', isServer: true })
  return Array.from({ length: 256 }, (_, i) => {
    const body = serializer.createPacketBuffer({ name: 'custom_payload', params: { channel: 'test:splitter', data: Buffer.alloc(256, i) } })
    const prefix = Buffer.alloc(sizeOfVarInt(body.length))
    writeVarInt(body.length, prefix, 0)
    return { body, frame: Buffer.concat([prefix, body]) }
  })
}

describe('splitter readable backpressure', function () {
  it('yields on elapsed synchronous work even below the frame count cap', async function () {
    const frames = makeFrames().slice(0, 24)
    const splitter = framing.createSplitter()
    let received = 0
    const sink = new Writable({ write (body, _, done) {
      if (++received === 1) {
        const deadline = performance.now() + 12
        while (performance.now() < deadline) { /* simulate a costly listener */ }
      }
      done()
    } })
    splitter.pipe(sink)
    await nextTurn()
    const finished = once(sink, 'finish')
    splitter.end(Buffer.concat(frames.map(({ frame }) => frame)))
    assert.strictEqual(received, 8)
    await finished
    assert.strictEqual(received, frames.length)
  })

  it('limits read-ahead and preserves a frame split across 64 KiB writes', async function () {
    const frames = makeFrames()
    const wire = Buffer.concat(frames.map(({ frame }) => frame))
    const splitter = framing.createSplitter()
    const received = []
    let unblock
    const sink = new Writable({
      highWaterMark: 1,
      write (body, _, done) {
        received.push(body)
        if (received.length === 1) unblock = done
        else done()
      }
    })
    splitter.pipe(sink)
    await nextTurn()
    let wrote = 0
    assert.strictEqual(splitter.write(wire.subarray(0, 65536), err => { assert.ifError(err); wrote++ }), false)
    assert.strictEqual(splitter.writableNeedDrain, true)
    splitter.end(wire.subarray(65536))
    const finished = once(sink, 'finish')
    await nextTurn()
    assert.strictEqual(wrote, 0)
    assert.ok(splitter.readableLength >= splitter.readableHighWaterMark)
    assert.ok(splitter.readableLength < splitter.readableHighWaterMark + frames[0].body.length)
    unblock()
    await finished
    assert.strictEqual(wrote, 1)
    assert.deepStrictEqual(received, frames.map(({ body }) => body))
  })

  for (const paused of [true, false]) {
    it(`settles the pending write once when destroyed ${paused ? 'while waiting for read' : 'between scheduled batches'}`, async function () {
      const frames = makeFrames()
      const splitter = framing.createSplitter()
      let readCalls = 0
      let writeCalls = 0
      const sink = new Writable({ highWaterMark: 1, write (_, __, done) {
        readCalls++
        if (!paused) done()
      } })
      splitter.pipe(sink)
      await nextTurn()
      const closed = once(splitter, 'close')
      splitter.write(Buffer.concat(frames.map(({ frame }) => frame)), error => {
        assert.strictEqual(error?.code, 'ERR_STREAM_DESTROYED')
        writeCalls++
      })
      const before = readCalls
      assert.ok(before < frames.length)
      splitter.destroy()
      await closed
      await nextTurn()
      assert.strictEqual(readCalls, before)
      assert.strictEqual(writeCalls, 1)
      assert.strictEqual(splitter.buffer.length, 0)
      sink.destroy()
    })
  }
})
