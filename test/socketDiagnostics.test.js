/* eslint-env mocha */

const assert = require('assert')
const EventEmitter = require('events')
const Client = require('../src/client')

describe('client socket diagnostics', function () {
  it('records inbound data before packet parsing', function () {
    const client = new Client(false, '1.20.4', undefined, true)
    const socket = new EventEmitter()
    socket.setNoDelay = () => {}
    socket.pipe = () => {}

    client.setSocket(socket)
    const activityAt = Date.now()
    socket.emit('data', Buffer.from([1, 2, 3]))

    assert.ok(client._lastSocketDataAt >= activityAt)
    assert.strictEqual(client._socketActivityCount, 1)
    assert.strictEqual(client._lastSocketEvent.event, 'data')
    assert.strictEqual(client._lastSocketEvent.bytes, 3)

    client.ended = true
  })

  it('records socket errors before ending the client', function () {
    const client = new Client(false, '1.20.4', undefined, true)
    const socket = new EventEmitter()
    socket.setNoDelay = () => {}
    socket.pipe = () => {}
    let endReason

    client.on('end', reason => { endReason = reason })
    client.on('error', () => {})
    client.setSocket(socket)
    socket.emit('error', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))

    assert.strictEqual(endReason, 'socketClosed')
    assert.strictEqual(client._lastSocketEvent.event, 'error')
    assert.strictEqual(client._lastSocketEvent.code, 'ECONNRESET')
    assert.strictEqual(client._lastSocketEvent.message, 'connection reset')
    assert.strictEqual(client._socketEventHistory.length, 1)
  })
})
