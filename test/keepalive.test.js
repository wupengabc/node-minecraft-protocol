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
    installKeepAlive(client, { checkTimeoutInterval: interval })

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
    installKeepAlive(client, { checkTimeoutInterval: interval })
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
})
