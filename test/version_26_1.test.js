'use strict'
/* eslint-env mocha */

// Task 5.4 — example tests for Requirements 8.1, 8.5, 8.6
//
// Verifies, for protocol 775 (Minecraft 26.1.2):
//   1. The minecraft-data version utility resolves '26.1.2' to protocol 775
//      (this is what NMP relies on instead of a duplicate version table — see design.md).
//   2. The outbound `set_protocol` packet on the wire carries protocolVersion = 775
//      when createClient is constructed with version = '26.1.2'.
//   3. When `data/pc/26.1/protocol.json` is missing (mcData.protocol is null) for
//      a 26.1.x version, createClient throws a clear error tagged with
//      protocolVersion = 775 via tagWith261.

const assert = require('assert')
const net = require('net')
const mc = require('../')
const minecraftData = require('minecraft-data')
const [readVarInt] = require('protodef').types.varint
const { getPort } = require('./common/util')

describe('protocol 26.1.2 (775) registration and handshake', function () {
  this.timeout(10000)

  describe('Requirement 8.6 — version → protocol mapping', function () {
    it("require('minecraft-data')('26.1.2').version.version === 775", function () {
      // NMP intentionally does not maintain a duplicate {version → protocol}
      // table; it always reads from minecraft-data (see design.md). This is
      // the canonical "mcVersionToProtocolVersion" path for 26.1.2.
      const mcData = minecraftData('26.1.2')
      assert.ok(mcData, "minecraft-data should resolve '26.1.2'")
      assert.strictEqual(mcData.version.version, 775)
      assert.strictEqual(mcData.version.majorVersion, '26.1')
      assert.strictEqual(mcData.version.minecraftVersion, '26.1.2')
    })

    it("NMP supportedVersions includes '26.1.2'", function () {
      assert.ok(
        mc.supportedVersions.includes('26.1.2'),
        "'26.1.2' should be present in NMP supportedVersions"
      )
    })
  })

  describe('Requirement 8.1 — outbound set_protocol carries protocolVersion=775', function () {
    let server
    let client

    afterEach(function (done) {
      const cleanupClient = () => {
        if (client && !client.ended) {
          try { client.end() } catch (_) {}
        }
      }
      cleanupClient()
      if (server && server.listening) {
        server.close(() => done())
      } else {
        done()
      }
    })

    it('writes set_protocol with protocolVersion=775 when version="26.1.2"', async function () {
      const port = await getPort()

      const firstFrameProtocolVersion = new Promise((resolve, reject) => {
        server = net.createServer((socket) => {
          let buffer = Buffer.alloc(0)
          let resolved = false
          socket.on('data', (chunk) => {
            if (resolved) return
            buffer = Buffer.concat([buffer, chunk])
            try {
              // Outer framing: VarInt frame length || frame bytes
              const { value: frameLen, size: frameLenSize } = readVarInt(buffer, 0)
              if (buffer.length < frameLenSize + frameLen) return // wait for more bytes
              const frame = buffer.subarray(frameLenSize, frameLenSize + frameLen)

              // Frame body: VarInt packet id (must be 0x00 for set_protocol in HANDSHAKING)
              //          || VarInt protocolVersion
              //          || String serverHost (VarInt-prefixed UTF-8)
              //          || u16 serverPort
              //          || VarInt nextState
              const { value: packetId, size: packetIdSize } = readVarInt(frame, 0)
              if (packetId !== 0x00) {
                return reject(new Error(`expected set_protocol packet id 0x00, got 0x${packetId.toString(16)}`))
              }
              const { value: protocolVersion } = readVarInt(frame, packetIdSize)
              resolved = true
              socket.destroy()
              resolve(protocolVersion)
            } catch (err) {
              if (err && err.partialReadError) return // wait for more bytes
              reject(err)
            }
          })
          socket.on('error', () => {}) // ignore RST after we destroy
        })
        server.on('error', reject)
        server.listen(port, '127.0.0.1')
      })

      client = mc.createClient({
        username: 'TestPlayer261',
        host: '127.0.0.1',
        port,
        version: '26.1.2',
        auth: 'offline',
        keepAlive: false,
        hideErrors: true
      })
      // The TCP server slams the socket shut after capturing the frame, so
      // suppress the resulting connection-reset error.
      client.on('error', () => {})

      const protocolVersion = await firstFrameProtocolVersion
      assert.strictEqual(protocolVersion, 775)
    })
  })

  describe('Requirement 8.5 — missing protocol.json throws tagged error', function () {
    // NMP loads minecraft-data lazily inside createClient(), so swapping the
    // module export in require.cache before the call is sufficient to exercise
    // the missing-protocol error path without touching real data files.
    const minecraftDataPath = require.resolve('minecraft-data')
    let originalExport

    beforeEach(function () {
      originalExport = require.cache[minecraftDataPath].exports
    })

    afterEach(function () {
      require.cache[minecraftDataPath].exports = originalExport
    })

    it('throws "Missing protocol data" with protocolVersion=775 for 26.1.x without protocol.json', function () {
      require.cache[minecraftDataPath].exports = function fakeMcData (version) {
        if (version === '26.1.99-no-protocol') {
          return {
            version: {
              version: 775,
              majorVersion: '26.1',
              minecraftVersion: '26.1.99-no-protocol',
              dataVersion: 4790,
              releaseType: 'release'
            },
            supportFeature: () => false,
            protocol: null
          }
        }
        return originalExport(version)
      }

      let thrown = null
      try {
        mc.createClient({
          username: 'Test',
          host: '127.0.0.1',
          port: 25565,
          version: '26.1.99-no-protocol',
          auth: 'offline'
        })
      } catch (err) {
        thrown = err
      }

      assert.ok(thrown, 'expected createClient to throw when protocol.json is missing')
      assert.match(thrown.message, /Missing protocol data/i)
      assert.match(thrown.message, /26\.1/)
      assert.strictEqual(thrown.protocolVersion, 775,
        'error must be tagged with protocolVersion=775 via tagWith261 (Requirement 15.5)')
    })

    it('throws an untagged error when an unrelated version has no protocol', function () {
      // Sanity check: tagWith261 should NOT tag errors for non-26.1 versions.
      require.cache[minecraftDataPath].exports = function fakeMcData (version) {
        if (version === '99.99-no-protocol') {
          return {
            version: {
              version: 999,
              majorVersion: '99.99',
              minecraftVersion: '99.99-no-protocol',
              releaseType: 'release'
            },
            supportFeature: () => false,
            protocol: null
          }
        }
        return originalExport(version)
      }

      let thrown = null
      try {
        mc.createClient({
          username: 'Test',
          host: '127.0.0.1',
          port: 25565,
          version: '99.99-no-protocol',
          auth: 'offline'
        })
      } catch (err) {
        thrown = err
      }

      assert.ok(thrown, 'expected createClient to throw')
      assert.match(thrown.message, /Missing protocol data/i)
      assert.notStrictEqual(thrown.protocolVersion, 775,
        '26.1 tag should not leak onto errors for unrelated versions')
    })
  })
})
