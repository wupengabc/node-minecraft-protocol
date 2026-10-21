'use strict'
/* eslint-env mocha */

const assert = require('assert')
const EventEmitter = require('events')
const states = require('../src/states')
const Client = require('../src/client')
const installPlay = require('../src/client/play')
const installKeepAlive = require('../src/client/keepalive')
const { stalledClient, decodeWire } = require('./common/outbound')
const { createSerializer } = require('../src/transforms/serializer')

describe('configuration state switches', function () {
  it('serializes acknowledgements in play before two configuration switches', function () {
    const client = new Client(false, '1.20.4', undefined, true)
    client.writes = []
    client.write = (name, params) => {
      client.writes.push({ name, params, state: client.state })
    }
    installPlay(client, { disableChatSigning: false })

    client.emit('success', {})
    assert.strictEqual(client.state, states.CONFIGURATION)

    client.emit('select_known_packs', {})
    client.emit('finish_configuration', {})
    assert.strictEqual(client.state, states.PLAY)

    client.emit('start_configuration', {})
    assert.strictEqual(client.state, states.CONFIGURATION)
    client.emit('select_known_packs', {})
    client.emit('finish_configuration', {})
    assert.strictEqual(client.state, states.PLAY)

    client.emit('start_configuration', {})
    assert.strictEqual(client.state, states.CONFIGURATION)
    client.emit('select_known_packs', {})
    client.emit('finish_configuration', {})
    assert.strictEqual(client.state, states.PLAY)

    const acknowledgements = client.writes.filter(({ name }) => name === 'configuration_acknowledged')
    assert.strictEqual(acknowledgements.length, 2)
    assert.ok(acknowledgements.every(({ state }) => state === states.PLAY))
    assert.strictEqual(client.writes.filter(({ name }) => name === 'finish_configuration').length, 3)
  })

  for (const version of ['26.2', '26.3']) {
    for (const transport of ['plain', 'compressed', 'encrypted', 'compressed+encrypted']) {
      it(`keeps all transition ACKs and write-time codecs through repeated stalled switches (${version}, ${transport})`, async function () {
        const fixture = stalledClient(version)
        const { client, socket } = fixture
        const secret = transport.includes('encrypted') ? Buffer.alloc(16, 7) : undefined
        const compression = transport.includes('compressed')
        if (compression) client.setCompressionThreshold(0)
        if (secret) client.setEncryption(secret)
        client.state = states.LOGIN
        installPlay(client, {})
        const receive = (name, params) => {
          const encoder = createSerializer({ state: client.state, version, isServer: true })
          client.deserializer.write(encoder.createPacketBuffer({ name, params }))
          encoder.destroy()
        }
        const expected = []
        receive('success', { uuid: '00000000-0000-0000-0000-000000000001', sessionId: '00000000-0000-0000-0000-000000000001', username: 'test', properties: [] })
        expected.push(['login', 'login_acknowledged'], ['configuration', 'custom_payload'], ['configuration', 'settings'])
        for (let i = 0; i < 3; i++) {
          receive('select_known_packs', { packs: [] })
          expected.push(['configuration', 'select_known_packs'])
          receive('finish_configuration', {})
          expected.push(['configuration', 'finish_configuration'])
          assert.strictEqual(client.state, states.PLAY)
          client.write('held_item_slot', { slotId: i })
          client.writePriority('tick_end', {})
          expected.push(['play', 'held_item_slot'], ['play', 'tick_end'])
          if (i < 2) {
            receive('start_configuration', {})
            expected.push(['play', 'configuration_acknowledged'], ['configuration', 'settings'])
            assert.strictEqual(client.state, states.CONFIGURATION)
          }
        }
        assert.strictEqual(fixture.chunks.length, 1, 'socket remains stalled across every codec change')
        await fixture.flush()
        const decoded = decodeWire(fixture.wire(), expected, { version, secret, compression })
        assert.deepStrictEqual(decoded.filter((p, i) => expected[i][1] === 'held_item_slot').map(p => p.slotId), [0, 1, 2])
        socket.destroy()
      })
    }
  }

  it('reschedules (does not leak) a stale keepalive timeout on every state switch', function (done) {
    const client = new EventEmitter()
    const interval = 20
    let errors = 0

    client.writePriority = () => {}
    client.end = () => {}
    client.on('error', () => { errors++ })
    installKeepAlive(client, { checkTimeoutInterval: interval, keepAliveTimeoutGracePeriod: 0 })

    client.emit('keep_alive', { keepAliveId: 1 })
    client.emit('state', states.CONFIGURATION)
    client.emit('state', states.PLAY)
    client.emit('keep_alive', { keepAliveId: 2 })
    client.emit('state', states.CONFIGURATION)
    client.emit('state', states.PLAY)
    client.emit('keep_alive', { keepAliveId: 3 })

    // Only the last-scheduled deadline (from the final keep_alive) should be
    // live. If clearTimers() failed to cancel earlier per-state timeouts,
    // multiple 'error' events would fire instead of exactly one.
    setTimeout(() => {
      assert.strictEqual(errors, 1)
      client.emit('end')
      done()
    }, interval + 10)
  })

  it('arms the watchdog in configuration and catches a switch that never completes', function (done) {
    // Velocity server switches move the client through play -> configuration
    // -> play. If the target backend fails and the proxy redirects back to
    // the original server without ever sending finish_configuration (or any
    // further bytes), the client must not stay parked in 'configuration'
    // forever. Regression for: onState() previously only re-armed the
    // watchdog for 'play', so a stall while switching went undetected with
    // no timeout, no error, and no reconnect.
    const client = new EventEmitter()
    const interval = 20
    let errors = 0
    let endReason = null

    client.writePriority = () => {}
    client.end = (reason) => { endReason = reason }
    client.on('error', () => { errors++ })
    installKeepAlive(client, { checkTimeoutInterval: interval, keepAliveTimeoutGracePeriod: 0 })

    client.emit('keep_alive', { keepAliveId: 1 })
    client.emit('state', states.CONFIGURATION)

    setTimeout(() => {
      assert.strictEqual(errors, 1)
      assert.strictEqual(endReason, 'keepAliveError')
      client.emit('end')
      done()
    }, interval + 10)
  })

  it('does not spuriously fire immediately when entering configuration for a normal switch', function (done) {
    const client = new EventEmitter()
    const interval = 1000
    let errors = 0

    client.writePriority = () => {}
    client.end = () => {}
    client.on('error', () => { errors++ })
    installKeepAlive(client, { checkTimeoutInterval: interval, keepAliveTimeoutGracePeriod: 0 })

    client.emit('keep_alive', { keepAliveId: 1 })
    client.emit('state', states.CONFIGURATION)
    client.emit('state', states.PLAY)
    client.emit('keep_alive', { keepAliveId: 2 })

    setTimeout(() => {
      assert.strictEqual(errors, 0)
      client.emit('end')
      done()
    }, 20)
  })
})
