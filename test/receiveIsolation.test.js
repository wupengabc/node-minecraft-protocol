/* eslint-env mocha */
'use strict'

const assert = require('node:assert/strict')
const { Duplex } = require('node:stream')
const { createCipheriv } = require('node:crypto')
const { deflateSync } = require('node:zlib')
const { setImmediate: tick, setTimeout: delay } = require('node:timers/promises')
const Client = require('../src/client')
const installKeepAlive = require('../src/client/keepalive')
const { createSerializer } = require('../src/transforms/serializer')
const [, writeVarInt, sizeOfVarInt] = require('protodef').types.varint

function varInt (value) {
  const buffer = Buffer.alloc(sizeOfVarInt(value))
  writeVarInt(value, buffer, 0)
  return buffer
}

function fixture ({ compression = false, encryption = false, watchdog = {} } = {}) {
  const client = new Client(false, '26.3', undefined, true)
  const writes = []
  const clientErrors = []
  const socket = new Duplex({
    read () {},
    write (buffer, encoding, callback) { writes.push(buffer); callback() }
  })
  client.on('error', error => clientErrors.push(error))
  client.setSocket(socket)
  // Subscribe here so regressions cannot hide a skipped real watchdog listener.
  installKeepAlive(client, watchdog)
  client.state = 'play'
  if (compression) client.setCompressionThreshold(256)
  let cipher
  if (encryption) {
    const secret = Buffer.alloc(16, 7)
    client.setEncryption(secret)
    cipher = createCipheriv('aes-128-cfb8', secret, secret)
  }
  const serializer = createSerializer({ state: 'play', isServer: true, version: '26.3' })
  function body (name, params = {}) { return serializer.createPacketBuffer({ name, params }) }
  function frame (packetBody) {
    const payload = !compression ? packetBody : packetBody.length >= 256
      ? Buffer.concat([varInt(packetBody.length), deflateSync(packetBody)])
      : Buffer.concat([Buffer.from([0]), packetBody])
    return Buffer.concat([varInt(payload.length), payload])
  }
  return {
    client, socket, writes, clientErrors, body, frame,
    feed (...frames) {
      const bytes = Buffer.concat(frames)
      socket.push(cipher ? cipher.update(bytes) : bytes)
    },
    close () {
      socket.destroy()
      client.emit('end') // Clear watchdog even if socket close is still queued.
      serializer.destroy()
      for (const key of ['serializer', 'deserializer', 'splitter', 'decompressor', 'compressor', 'framer', 'cipher', 'decipher']) client[key]?.destroy()
    }
  }
}

function failListener () { throw new Error('injected synchronous listener failure') }

async function drain () {
  for (let i = 0; i < 20; i++) await tick()
}

describe('receive event isolation', () => {
  it('drains already accepted frames when the encrypted transport reaches clean EOF', async () => {
    const f = fixture({ compression: true, encryption: true })
    try {
      const received = []
      f.client.on('custom_payload', data => received.push(data.data[0]))
      const packets = Array.from({ length: 512 }, (_, i) => f.frame(f.body('custom_payload', {
        channel: 'test:receive', data: Buffer.alloc(256, i % 256)
      })))
      f.feed(...packets)
      f.socket.push(null)
      await drain()
      assert.deepEqual(received, Array.from({ length: 512 }, (_, i) => i % 256))
      assert.deepEqual(f.clientErrors, [])
    } finally {
      f.close()
    }
  })

  for (const transport of ['plain', 'compression', 'compression+encryption']) {
    it(`keeps heartbeat responses and the receive pipeline alive (${transport})`, async () => {
      const f = fixture({ compression: transport.includes('compression'), encryption: transport.includes('encryption') })
      const { client } = f
      try {
        const seen = []
        const failures = []
        client.prependOnceListener('packet', failListener)
        client.on('packet', (_, meta) => seen.push(meta.name))
        client.prependOnceListener('keep_alive', failListener)
        client.prependOnceListener('raw.keep_alive', failListener)
        client.prependOnceListener('raw', failListener)
        client.once('socketActivity', failListener)
        client.on('receiveListenerError', failListener)
        client.on('receiveListenerError', report => failures.push(report))

        const heartbeat = f.frame(f.body('keep_alive', { keepAliveId: 17n }))
        f.feed(heartbeat)
        await drain()
        assert.equal(client._lastKeepAliveId, '17')
        assert.equal(f.writes.length, 1)

        const data = f.frame(f.body('custom_payload', { channel: 'test:receive', data: Buffer.alloc(2048) }))
        client.once('custom_payload', failListener)
        // Enough bytes to expose a stuck _transform callback, even if later
        // frames leave the exact socket chunk that contained the first error.
        f.feed(data)
        await tick()
        for (let i = 0; i < 4; i++) {
          f.feed(...Array(128).fill(data))
          await drain()
        }
        f.feed(heartbeat)
        await drain()
        assert.equal(f.writes.length, 2)
        assert.equal(seen.filter(name => name === 'custom_payload').length, 513)
        assert.equal(seen.filter(name => name === 'keep_alive').length, 2)
        assert.deepEqual(f.clientErrors, [])
        assert.equal(f.socket.isPaused(), false)
        assert.equal(client.deserializer.writableLength, 0)
        assert.deepEqual(failures.map(report => report.event), [
          'socketActivity', 'packet', 'keep_alive', 'raw.keep_alive', 'raw', 'custom_payload'
        ])
        assert.equal(failures[1].packetName, 'keep_alive')
        assert.equal(failures[1].state, 'play')
        assert.match(failures[1].error.message, /injected/)
        const snapshot = client.getReceiveDiagnostics()
        assert.equal(snapshot.packetBodies, 515)
        assert.equal(snapshot.decodedPackets, 515)
        assert.equal(snapshot.dispatchedPackets, 515)
        assert.equal(snapshot.listenerErrors, 6)
        assert.equal(snapshot.lastListenerError.packetName, 'custom_payload')
        assert.equal(snapshot.inbound.deserializer.writing, false)
        assert.ok(!JSON.stringify(snapshot).includes('injected'))
      } finally {
        f.close()
      }
    })
  }

  it('keeps listener order, once semantics, emit-time snapshots and bundle delimiters', async () => {
    const f = fixture({ compression: true })
    try {
      const { client } = f
      const calls = []
      const removed = () => calls.push('removed')
      const added = () => calls.push('added')
      client.prependOnceListener('bundle_delimiter', function () {
        assert.equal(this, client)
        calls.push('once')
        client.removeListener('bundle_delimiter', removed)
        client.on('bundle_delimiter', added)
        failListener()
      })
      client.on('bundle_delimiter', removed)
      client.on('bundle_delimiter', () => calls.push('persistent'))
      client.on('bundle_delimiter', failListener)
      client.on('raw.bundle_delimiter', () => calls.push('raw delimiter'))
      client.prependListener('keep_alive', () => calls.push('heartbeat'))
      const delimiter = f.frame(f.body('bundle_delimiter'))
      const heartbeat = f.frame(f.body('keep_alive', { keepAliveId: 1n }))
      f.feed(delimiter, heartbeat)
      await tick()
      assert.deepEqual(calls, [])
      assert.equal(client.getReceiveDiagnostics().bundlePackets, 2)
      f.feed(delimiter, heartbeat)
      await drain()
      assert.deepEqual(calls, [
        'once', 'removed', 'persistent', 'raw delimiter', 'heartbeat',
        'persistent', 'added', 'raw delimiter', 'heartbeat'
      ])
      assert.equal(client.getReceiveDiagnostics().bundlePackets, 0)
      assert.equal(f.writes.length, 2)
      assert.deepEqual(f.clientErrors, [])
    } finally {
      f.close()
    }
  })

  it('drops a failed compressed frame and keeps the next frame aligned', async () => {
    const f = fixture({ compression: true })
    try {
      const badLength = Buffer.concat([varInt(12), deflateSync(Buffer.alloc(11))])
      const heartbeat = f.frame(f.body('keep_alive', { keepAliveId: 3n }))
      f.feed(Buffer.concat([varInt(badLength.length), badLength]), heartbeat)
      await drain()
      assert.equal(f.writes.length, 1)
      assert.deepEqual(f.clientErrors, [])
      assert.equal(f.client.getReceiveDiagnostics().droppedCompressedFrames, 1)
      assert.equal(f.client.getReceiveDiagnostics().packetBodies, 1)
    } finally {
      f.close()
    }
  })

  it('reports paused receive diagnostics without letting a warning observer break the watchdog', async () => {
    const f = fixture({ watchdog: { checkTimeoutInterval: 10, keepAliveTimeoutGracePeriod: 5 } })
    try {
      f.socket.pause()
      f.client.prependOnceListener('keepAliveWarning', failListener)
      const failure = new Promise(resolve => f.client.once('error', resolve))
      const error = await Promise.race([failure, delay(200, new Error('watchdog did not finish'))])
      assert.equal(error.code, 'KEEPALIVE_TIMEOUT')
      const snapshot = error.keepAliveDiagnostics.receive
      assert.equal(snapshot.socket.paused, true)
      assert.equal(snapshot.lastListenerError.event, 'keepAliveWarning')
      assert.equal(snapshot.packetBodies, 0)
      assert.equal(snapshot.inbound.deserializer.destroyed, false)
    } finally {
      clearTimeout(f.client.closeTimer)
      f.close()
    }
  })

  it('isolates raw and malformed observers while preserving hard parser replacement', async () => {
    const f = fixture({ compression: true })
    try {
      const { client } = f
      const events = []
      client.on('rawPacket', failListener)
      client.on('rawPacket', packet => events.push(['raw', packet.packetId]))
      client.on('malformedPacket', failListener)
      client.on('malformedPacket', packet => events.push(['malformed', packet.packetId]))
      const unknown = f.frame(varInt(0x3fff))
      f.feed(unknown)
      await tick()
      const old = client.deserializer
      old.parsePacketBuffer = failListener
      const heartbeat = f.frame(f.body('keep_alive', { keepAliveId: 25n }))
      f.feed(heartbeat, heartbeat)
      await drain()
      assert.equal(events.length, 2)
      assert.deepEqual(events[0], ['raw', 0x3fff])
      assert.equal(events[1][0], 'malformed')
      assert.notEqual(client.deserializer, old)
      assert.equal(old.destroyed, true)
      assert.equal(f.writes.length, 1)
      assert.deepEqual(f.clientErrors, [])
      assert.equal(client.getReceiveDiagnostics().parserRebuilds, 1)
    } finally {
      f.close()
    }
  })
})
