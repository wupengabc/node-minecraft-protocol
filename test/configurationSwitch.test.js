'use strict'
/* eslint-env mocha */

const assert = require('assert')
const EventEmitter = require('events')
const states = require('../src/states')
const Client = require('../src/client')
const installPlay = require('../src/client/play')
const installKeepAlive = require('../src/client/keepalive')

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

  it('drops packets queued for the previous state at a switch boundary', function () {
    const client = new (require('../src/client'))(false, '1.20.4', undefined, true)
    client._writeQueue.push({ name: 'position', params: {} })
    client._priorityWriteQueue.push({ name: 'keep_alive', params: {} })
    client.state = states.CONFIGURATION

    assert.deepStrictEqual(client._writeQueue, [])
    assert.deepStrictEqual(client._priorityWriteQueue, [])
  })

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
