/* eslint-env mocha */

const assert = require('assert')
const Client = require('../src/client')

describe('outbound packet queue', function () {
  function makeClient () {
    const client = new Client(false, '26.1.2', undefined, true)
    const writes = []
    client.serializer = {
      writable: true,
      write: (packet) => {
        writes.push(packet)
        return true
      }
    }
    client.socket = { writableNeedDrain: true }
    client.framer = { readableLength: 0, readableHighWaterMark: 16 * 1024 }
    return { client, writes }
  }

  it('sends keepalive replies before queued normal packets after a stall', function () {
    const { client, writes } = makeClient()
    client.write('position', { x: 1 })
    client.write('block_dig', { status: 0 })
    client.writePriority('keep_alive', { keepAliveId: 1 })

    client.socket.writableNeedDrain = false
    client._drainWriteQueue()

    assert.deepStrictEqual(writes.map(packet => packet.name), ['keep_alive', 'position', 'block_dig'])
  })

  it('keeps only the latest queued movement packet', function () {
    const { client, writes } = makeClient()
    client.write('position', { x: 1 })
    client.write('position', { x: 2 })
    client.write('position', { x: 3 })

    client.socket.writableNeedDrain = false
    client._drainWriteQueue()

    assert.deepStrictEqual(writes, [{ name: 'position', params: { x: 3 } }])
  })
})
