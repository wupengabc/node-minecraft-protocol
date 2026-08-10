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

  it('cancels a stale keepalive timeout while switching state', function (done) {
    const client = new EventEmitter()
    const interval = 20
    let errors = 0

    client.writePriority = () => {}
    client.end = () => {}
    client.on('error', () => { errors++ })
    installKeepAlive(client, { checkTimeoutInterval: interval, keepAliveTimeoutGracePeriod: 0 })

    client.emit('keep_alive', { keepAliveId: 1 })
    client.emit('state', states.CONFIGURATION)

    setTimeout(() => {
      assert.strictEqual(errors, 0)
      client.emit('state', states.PLAY)
      client.emit('keep_alive', { keepAliveId: 2 })

      setTimeout(() => {
        assert.strictEqual(errors, 1)
        client.emit('end')
        done()
      }, interval + 10)
    }, interval + 10)
  })
})
