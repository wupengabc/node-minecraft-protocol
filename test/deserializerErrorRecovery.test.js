/* eslint-env mocha */
'use strict'

const assert = require('assert')
const { PassThrough } = require('readable-stream')
const Client = require('../src/client')

// Reproduces the silent-freeze failure mode seen in production on 26.2:
//
//   socket_history=data,data,...,data   (never error/close/end)
//   readableEnded=false
//   ...then zero inbound bytes forever, until the keepalive watchdog fires.
//
// protodef's FullPacketParser distinguishes two failure kinds:
//
//   * PartialReadError  -> cb()      : the Transform SURVIVES.
//   * any other Error   -> cb(err)   : Node DESTROYS the Transform.
//
// Framed errors are recoverable because the splitter has already isolated the
// entire packet. The client reports its contents as malformedPacket and swaps
// the destroyed parser without disconnecting the socket.
function makeFakeSocket () {
  const socket = new PassThrough()
  socket.setNoDelay = () => {}
  socket.destroy = () => {}
  return socket
}

function frame (body) {
  const [, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
  const size = sizeOfVarInt(body.length)
  const out = Buffer.alloc(size + body.length)
  writeVarInt(body.length, out, 0)
  body.copy(out, size)
  return out
}

function buildKeepAlive (client) {
  const mcData = require('minecraft-data')(client.version)
  const mappings = mcData.protocol.play.toClient.types.packet[1][0].type[1].mappings
  let kaId = null
  for (const [id, name] of Object.entries(mappings)) {
    if (name === 'keep_alive') { kaId = parseInt(id, 16); break }
  }
  assert.ok(kaId !== null, 'keep_alive must exist in the Play toClient mappings')

  const [, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
  const idSize = sizeOfVarInt(kaId)
  const body = Buffer.alloc(idSize + 8)
  writeVarInt(kaId, body, 0)
  body.writeBigInt64BE(4242n, idSize)
  return body
}

describe('deserializer error recovery', () => {
  it('reports malformed packet contents and keeps consuming subsequent frames', function (done) {
    this.timeout(5000)

    const client = new Client(false, '26.2')
    client.state = 'play'

    const socket = makeFakeSocket()
    client.setSocket(socket)

    const errors = []
    client.on('error', (err) => errors.push(err))
    const malformedPackets = []
    client.on('malformedPacket', (packet) => malformedPackets.push(packet))

    let sawGoodPacket = false
    client.on('keep_alive', () => { sawGoodPacket = true })

    // Force exactly one hard (non-partial) parse failure, which is what a
    // malformed known packet produces and what destroys the Transform.
    const parser = client.deserializer
    const realParse = parser.parsePacketBuffer.bind(parser)
    let poisoned = false
    parser.parsePacketBuffer = (buffer) => {
      if (!poisoned) {
        poisoned = true
        const err = new Error('simulated malformed known packet')
        // Explicitly NOT a partialReadError: this is the destroy path.
        err.partialReadError = false
        throw err
      }
      return realParse(buffer)
    }

    const good = buildKeepAlive(client)

    const malformed = Buffer.from([0x14, 0x00, 0x01])
    socket.write(Buffer.concat([frame(malformed), frame(good)]))
    setTimeout(() => {
      assert.strictEqual(errors.length, 0, 'framed decode failures must not become global client errors')
      assert.strictEqual(malformedPackets.length, 1)
      assert.strictEqual(malformedPackets[0].packetId, 0x14)
      assert.strictEqual(malformedPackets[0].buffer.toString('hex'), malformed.toString('hex'))
      assert.match(malformedPackets[0].error.message, /simulated malformed known packet/)
      assert.strictEqual(malformedPackets[0].protocolVersion, client.protocolVersion)
      assert.strictEqual(malformedPackets[0].state, 'play')
      assert.strictEqual(socket.isPaused(), false)
      assert.ok(sawGoodPacket, 'valid packet after malformed frame must still be delivered')
      done()
    }, 200)
  })

  it('reports a malformed 26.3 advancements frame without raising a global error', function (done) {
    this.timeout(5000)
    const client = new Client(false, '26.3')
    client.state = 'play'
    const socket = makeFakeSocket()
    client.setSocket(socket)
    const errors = []
    const malformedPackets = []
    client.on('error', err => errors.push(err))
    client.on('malformedPacket', packet => malformedPackets.push(packet))
    let keepAlives = 0
    client.on('keep_alive', () => { keepAlives++ })

    const parser = client.deserializer
    const realParse = parser.parsePacketBuffer.bind(parser)
    let poisoned = false
    parser.parsePacketBuffer = buffer => {
      if (!poisoned) {
        poisoned = true
        const err = new RangeError('negative decoded offset')
        err.partialReadError = false
        err.buffer = malformed
        throw err
      }
      return realParse(buffer)
    }

    const malformed = Buffer.from([0x85, 0x01, 0x01, 0x02])
    const good = buildKeepAlive(client)
    socket.write(Buffer.concat([frame(malformed), frame(good)]))
    setTimeout(() => {
      assert.strictEqual(errors.length, 0)
      assert.strictEqual(malformedPackets.length, 1)
      assert.strictEqual(malformedPackets[0].packetId, 0x85)
      assert.strictEqual(malformedPackets[0].protocolVersion, 777)
      assert.strictEqual(malformedPackets[0].buffer.toString('hex'), malformed.toString('hex'))
      assert.match(malformedPackets[0].error.message, /negative decoded offset/)
      assert.strictEqual(keepAlives, 1)
      assert.strictEqual(socket.isPaused(), false)
      done()
    }, 200)
  })

  // The silent branch: an UNMAPPED packet id on 26.2. There is no schema for
  // such a packet, so the client reports it via 'rawPacket' and returns WITHOUT
  // emitting 'error'. If stream recovery is broken here the connection simply
  // goes quiet with nothing at all in the logs -- exactly the production
  // symptom. (teams/0x6d used to take this branch too; that special case was
  // removed once both versions' schemas were verified correct.)
  it('stays silent but keeps parsing after an unmapped packet id (26.2)', function (done) {
    this.timeout(5000)

    const client = new Client(false, '26.2')
    client.state = 'play'

    const socket = makeFakeSocket()
    client.setSocket(socket)

    const errors = []
    const rawPackets = []
    client.on('error', (err) => errors.push(err))
    client.on('rawPacket', (raw) => rawPackets.push(raw))

    let keepAlives = 0
    client.on('keep_alive', () => { keepAlives++ })

    const parser = client.deserializer
    const realParse = parser.parsePacketBuffer.bind(parser)
    let poisoned = false
    parser.parsePacketBuffer = (buffer) => {
      if (!poisoned) {
        poisoned = true
        // This is the exact message protodef raises for an id with no mapping,
        // which is what the client matches on to take the silent branch.
        const err = new Error('0x7f is not in the mappings value')
        err.partialReadError = false
        err.buffer = Buffer.from([0x7f, 0x00, 0x01, 0x02])
        throw err
      }
      return realParse(buffer)
    }

    const good = buildKeepAlive(client)
    socket.write(frame(Buffer.from([0x7f, 0x00, 0x01, 0x02])))

    setTimeout(() => {
      socket.write(frame(good))
      socket.write(frame(good))

      setTimeout(() => {
        assert.strictEqual(errors.length, 0, 'the unmapped-id branch must not surface an error')
        assert.strictEqual(rawPackets.length, 1, 'the unmapped packet must be reported once as rawPacket')
        assert.strictEqual(rawPackets[0].packetId, 0x7f)
        assert.strictEqual(
          keepAlives, 2,
          `every later keep_alive must still be parsed, got ${keepAlives}/2 -- ` +
          'a lower count is the silent production freeze'
        )
        done()
      }, 200)
    }, 50)
  })
})
