/* eslint-env mocha */

const assert = require('assert')
const { Writable } = require('stream')
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
    client.ended = false
    client.socket = { writableNeedDrain: true }
    client.framer = { readableLength: 0, readableHighWaterMark: 16 * 1024 }
    return { client, writes }
  }

  it('preserves caller order for movement, actions and keepalive replies after a stall', function () {
    const { client, writes } = makeClient()
    client.write('position', { x: 1 })
    client.write('block_dig', { status: 0 })
    client.writePriority('keep_alive', { keepAliveId: 1 })

    assert.deepStrictEqual(writes, [])
    client.socket.writableNeedDrain = false
    client._drainWriteQueue()

    assert.deepStrictEqual(writes.map(packet => packet.name), ['position', 'block_dig', 'keep_alive'])
    assert.strictEqual(typeof client._lastKeepAliveWriteAt, 'number')
  })

  it('preserves every queued position and mixed movement update after a stall', function () {
    const { client, writes } = makeClient()
    const packets = [
      { name: 'position', params: { x: 1 } },
      { name: 'position_look', params: { x: 2, yaw: 90 } },
      { name: 'position', params: { x: 3 } },
      { name: 'position', params: { x: 4 } }
    ]
    for (const packet of packets) client.write(packet.name, packet.params)

    assert.deepStrictEqual(writes, [])
    client.socket.writableNeedDrain = false
    client._drainWriteQueue()

    assert.deepStrictEqual(writes, packets)
  })

  it('keeps teleport acknowledgements between preceding movement and their echoes after a stall', function () {
    const { client, writes } = makeClient()
    const packets = [
      { name: 'position_look', params: { x: 1 } },
      { name: 'teleport_confirm', params: { teleportId: 7 } },
      { name: 'position_look', params: { x: 10 } },
      { name: 'teleport_confirm', params: { teleportId: 8 } },
      { name: 'position_look', params: { x: 20 } }
    ]
    for (const packet of packets) client.write(packet.name, packet.params)

    assert.deepStrictEqual(writes, [])
    client.socket.writableNeedDrain = false
    client._drainWriteQueue()

    assert.deepStrictEqual(writes, packets)
  })

  it('preserves every tick_end and movement boundary after a stall', function () {
    const { client, writes } = makeClient()
    const packets = [
      { name: 'position', params: { x: 1 } },
      { name: 'tick_end', params: {} },
      { name: 'look', params: { yaw: 90 } },
      { name: 'tick_end', params: {} },
      { name: 'position', params: { x: 2 } },
      { name: 'tick_end', params: {} },
      { name: 'tick_end', params: {} }
    ]
    for (const packet of packets) client.write(packet.name, packet.params)

    assert.deepStrictEqual(writes, [])
    client.socket.writableNeedDrain = false
    client._drainWriteQueue()

    assert.deepStrictEqual(writes, packets)
  })

  it('keeps a priority attack after preceding actions and movement and before the following tick_end', function () {
    const { client, writes } = makeClient()
    client.write('block_dig', { status: 5 })
    client.write('position', { x: 1 })
    client.writePriority('use_entity', { target: 42, mouse: 1, sneaking: false })
    client.writePriority('arm_animation', { hand: 0 })
    client.write('tick_end', {})

    assert.deepStrictEqual(writes, [])
    client.socket.writableNeedDrain = false
    client._drainWriteQueue()

    assert.deepStrictEqual(writes.map(packet => packet.name), [
      'block_dig', 'position', 'use_entity', 'arm_animation', 'tick_end'
    ])
  })

  it('keeps keepalive replies behind earlier non-movement packets after a stall', function () {
    const { client, writes } = makeClient()
    client.write('window_click', { windowId: 1 })
    client.writePriority('keep_alive', { keepAliveId: 1 })

    assert.deepStrictEqual(writes, [])
    assert.strictEqual(client._lastKeepAliveWriteAt, undefined)
    client.socket.writableNeedDrain = false
    client._drainWriteQueue()

    assert.deepStrictEqual(writes.map(packet => packet.name), ['window_click', 'keep_alive'])
  })

  it('waits for serializer drain without losing, duplicating or reordering queued packets', async function () {
    const { client, writes } = makeClient()
    let completeWrite
    client.serializer = new Writable({
      objectMode: true,
      highWaterMark: 1,
      write (packet, encoding, callback) {
        writes.push(packet)
        completeWrite = callback
      }
    })
    client.serializer.on('drain', () => client._drainWriteQueue())
    const position = { name: 'position', params: { x: 1 } }
    const attack = { name: 'use_entity', params: { target: 42, mouse: 1, sneaking: false } }
    const tickEnd = { name: 'tick_end', params: {} }
    client.write(position.name, position.params)
    client.writePriority(attack.name, attack.params)
    client.socket.writableNeedDrain = false
    client._drainWriteQueue()

    assert.deepStrictEqual(writes, [position])
    assert.strictEqual(client.serializer.writableNeedDrain, true)
    client.write(tickEnd.name, tickEnd.params)
    client._drainWriteQueue()
    assert.strictEqual(client.serializer.writableLength, 1, 'new writes must wait for serializer drain')
    assert.deepStrictEqual(client._writeQueue, [attack, tickEnd])

    completeWrite()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepStrictEqual(writes, [position, attack])
    assert.deepStrictEqual(client._writeQueue, [tickEnd])

    completeWrite()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepStrictEqual(writes, [position, attack, tickEnd])
    assert.deepStrictEqual(client._writeQueue, [])

    completeWrite()
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(client.serializer.writableNeedDrain, false)
    assert.deepStrictEqual(writes, [position, attack, tickEnd])
    client.serializer.destroy()
  })
})
