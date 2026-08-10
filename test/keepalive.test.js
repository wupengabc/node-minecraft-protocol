/* eslint-env mocha */

const EventEmitter = require('events')
const assert = require('power-assert')
const installKeepAlive = require('../src/client/keepalive')

describe('client keepalive', function () {
  it('does not time out while the socket is still receiving data', function (done) {
    const client = new EventEmitter()
    const interval = 30
    let errors = 0

    client.writePriority = () => {}
    client.end = () => {}
    client.on('error', () => { errors += 1 })
    installKeepAlive(client, { checkTimeoutInterval: interval, keepAliveTimeoutGracePeriod: 0 })

    client.emit('keep_alive', { keepAliveId: 1 })
    setTimeout(() => {
      client._lastSocketActivity = Date.now()
    }, interval - 10)

    setTimeout(() => {
      assert.strictEqual(errors, 0)
      client.emit('end')
      done()
    }, interval + 15)
  })

  it('times out after the server becomes inactive', function (done) {
    const client = new EventEmitter()
    const interval = 20
    let endReason

    client.writePriority = () => {}
    client.end = (reason) => { endReason = reason }
    installKeepAlive(client, { checkTimeoutInterval: interval, keepAliveTimeoutGracePeriod: 0 })
    client.on('error', (error) => {
      assert.strictEqual(error.message, `client timed out after ${interval} milliseconds`)
      setImmediate(() => {
        assert.strictEqual(endReason, 'keepAliveError')
        client.emit('end')
        done()
      })
    })

    client.emit('keep_alive', { keepAliveId: 1 })
  })

  it('recovers when socket data arrives during the bounded grace period', function (done) {
    const client = new EventEmitter()
    const interval = 20
    const gracePeriod = 40
    const diagnostics = {}
    let errors = 0

    client._lastSocketActivity = Date.now() - interval
    client._socketActivityCount = 0
    client.writePriority = () => {}
    client.end = () => {}
    client.on('error', () => { errors += 1 })
    client.on('keepAliveWarning', (data) => { diagnostics.warning = data })
    client.once('keepAliveWarning', () => {
      setTimeout(() => {
        client._lastSocketActivity = Date.now()
        client._socketActivityCount++
        client.emit('socketActivity')
      }, 5)
    })
    client.on('keepAliveRecovered', (data) => {
      diagnostics.recovered = data
      assert.strictEqual(errors, 0)
      assert.strictEqual(data.recovery, 'socket_activity')
      assert.ok(data.graceElapsed >= 0)
      client.emit('end')
      done()
    })
    installKeepAlive(client, {
      checkTimeoutInterval: interval,
      keepAliveTimeoutGracePeriod: gracePeriod
    })

    client.emit('keep_alive', { keepAliveId: 1 })
  })

  it('emits timeout diagnostics after the grace period expires', function (done) {
    const client = new EventEmitter()
    const interval = 20
    const gracePeriod = 10
    let warning
    let endReason

    client._lastSocketActivity = Date.now() - interval
    client.writePriority = () => {}
    client.end = (reason) => { endReason = reason }
    client.on('keepAliveWarning', (data) => { warning = data })
    installKeepAlive(client, {
      checkTimeoutInterval: interval,
      keepAliveTimeoutGracePeriod: gracePeriod
    })
    client.on('error', (error) => {
      assert.strictEqual(error.code, 'KEEPALIVE_TIMEOUT')
      assert.strictEqual(error.keepAliveDiagnostics.phase, 'keepAliveTimeout')
      assert.strictEqual(error.keepAliveDiagnostics.keepAliveTimeoutGracePeriod, gracePeriod)
      assert.ok(warning)
      setImmediate(() => {
        assert.strictEqual(endReason, 'keepAliveError')
        client.emit('end')
        done()
      })
    })

    client.emit('keep_alive', { keepAliveId: 1 })
  })
})
