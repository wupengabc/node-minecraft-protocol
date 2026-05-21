'use strict'
/* eslint-env mocha */

// Task 6.5 — Property 5: Velocity challenge identification & missing-secret fallback
//
// Validates: Requirements 9.1, 9.2, 9.4, 15.2
//
// Two-part test:
//   (A) isVelocityChallenge is a strict, case-sensitive equality test on
//       packet.channel === 'velocity:player_info' (Requirements 9.1, 9.2).
//   (B) When velocityForwardingSecret is null and a velocity:player_info
//       Login Plugin Request arrives:
//         - 'velocityForwardingChallenge' is emitted (with the parsed version)
//           BEFORE the response is written
//         - login_plugin_response is written with successful=false (no data field)
//         - 'error' is emitted with code='VELOCITY_SECRET_MISSING'
//         - the error carries protocolVersion=775 (via tagWith261)
//         - the socket is NOT disconnected by NMP (Requirement 9.4)
//
// (B) is exercised by directly invoking the onLoginPluginRequest handler that
// pluginChannels installs on the client, using a minimal EventEmitter mock so
// the test does not require a real TCP server.

const assert = require('assert')
const EventEmitter = require('events')
const fc = require('fast-check')
const path = require('path')
const { isVelocityChallenge } = require('../src/transforms/velocityForwarding')

// --- Part A: isVelocityChallenge ---

describe('Velocity challenge identification (Property 5, Part A)', function () {
  this.timeout(15000)

  it('returns (channel === "velocity:player_info") for arbitrary channels', function () {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (channel) => {
        const expected = channel === 'velocity:player_info'
        assert.strictEqual(isVelocityChallenge({ channel }), expected)
      }),
      { numRuns: 200 }
    )
  })

  it('matches the canonical lowercase channel exactly', function () {
    assert.strictEqual(
      isVelocityChallenge({ channel: 'velocity:player_info' }),
      true
    )
  })

  it('rejects case variants like "Velocity:Player_Info"', function () {
    const variants = [
      'Velocity:Player_Info',
      'VELOCITY:PLAYER_INFO',
      'velocity:Player_Info',
      'Velocity:player_info',
      'velocity:PLAYER_INFO',
      ' velocity:player_info',
      'velocity:player_info ',
      'velocity:player_info\n',
      'minecraft:velocity:player_info'
    ]
    for (const channel of variants) {
      assert.strictEqual(
        isVelocityChallenge({ channel }),
        false,
        'expected ' + JSON.stringify(channel) + ' to NOT be a Velocity challenge'
      )
    }
  })
})

// --- Part B: missing-secret fallback through pluginChannels ---

/**
 * Build a minimal mock client that quacks like the NMP Client EventEmitter
 * surface used by pluginChannels.onLoginPluginRequest:
 *   - on/emit/removeListener (from EventEmitter)
 *   - write(packetName, params) — captured into client._writes
 *   - registerChannel/unregisterChannel/writeChannel are installed by pluginChannels
 *   - state, ended, socket — properties read by NMP elsewhere; harmless here
 */
function makeMockClient ({ uuid = '00000000-0000-0000-0000-000000000000', username = 'TestPlayer' } = {}) {
  const client = new EventEmitter()
  client._writes = []
  client.write = (name, params) => {
    client._writes.push({ name, params })
  }
  client.uuid = uuid
  client.username = username
  client.session = null
  // ended/end/destroy are observed in our assertions so we can detect a forced
  // disconnect (which Requirement 9.4 says NMP must NOT do).
  client.ended = false
  client._endCalls = 0
  client.end = () => {
    client._endCalls += 1
    client.ended = true
  }
  // socket end is the only path NMP could use to disconnect the underlying TCP
  // stream; we expose a stub so we can detect any attempt.
  client.socket = {
    _destroyed: 0,
    destroy () {
      this._destroyed += 1
    }
  }
  return client
}

/**
 * Wire the pluginChannels module onto a mock client. We need a stub
 * minecraft-data because pluginChannels reads `mcdata.protocol.types` and
 * `mcdata.version.version` for VarInt-array channel registration. The
 * substitution is scoped: we restore the real export in afterEach.
 */
function wirePluginChannels (client, options) {
  const pluginChannelsPath = path.resolve(__dirname, '../src/client/pluginChannels.js')
  delete require.cache[pluginChannelsPath]
  const pluginChannels = require(pluginChannelsPath)
  pluginChannels(client, options)
}

describe('Velocity missing-secret fallback (Property 5, Part B)', function () {
  this.timeout(15000)

  // We swap the minecraft-data export for the duration of these tests so
  // pluginChannels.js can construct its ProtoDef without needing the full
  // real data (it only reads mcdata.protocol.types / mcdata.version.version).
  const minecraftDataPath = require.resolve('minecraft-data')
  let originalExport

  before(function () {
    // Force minecraft-data into require.cache so beforeEach can swap its export.
    // (Reading any field is enough to load the module; we just need the cache
    // entry to exist.)
    require('minecraft-data')
  })

  beforeEach(function () {
    originalExport = require.cache[minecraftDataPath].exports
    require.cache[minecraftDataPath].exports = function fakeMcData () {
      return {
        version: { version: 775, majorVersion: '26.1', minecraftVersion: '26.1.2' },
        supportFeature: () => false,
        protocol: { types: {} }
      }
    }
  })

  afterEach(function () {
    require.cache[minecraftDataPath].exports = originalExport
  })

  it('emits velocityForwardingChallenge with parsed version, then writes successful=false response, then emits VELOCITY_SECRET_MISSING error', function () {
    const client = makeMockClient()
    wirePluginChannels(client, {
      version: '26.1.2',
      velocityForwardingSecret: null
    })

    const events = [] // ordered transcript of (name, payload)
    client.on('velocityForwardingChallenge', (p) => events.push(['challenge', p]))
    client.on('error', (e) => events.push(['error', e]))

    // payload data: a single VarInt = 1 (the Velocity challenge version)
    const challengePacket = {
      messageId: 7,
      channel: 'velocity:player_info',
      data: Buffer.from([0x01])
    }

    // Snapshot writes-so-far before invoking the handler.
    const writesBefore = client._writes.length
    client.emit('login_plugin_request', challengePacket)

    // 1. velocityForwardingChallenge MUST be emitted exactly once with version=1.
    const challengeEvents = events.filter((e) => e[0] === 'challenge')
    assert.strictEqual(challengeEvents.length, 1, 'expected exactly one velocityForwardingChallenge')
    assert.deepStrictEqual(challengeEvents[0][1], { version: 1 })

    // 2. login_plugin_response was written with successful=false (i.e. no data field).
    const newWrites = client._writes.slice(writesBefore)
    const responseWrite = newWrites.find((w) => w.name === 'login_plugin_response')
    assert.ok(responseWrite, 'expected a login_plugin_response write')
    assert.strictEqual(responseWrite.params.messageId, 7)
    assert.strictEqual(
      responseWrite.params.data,
      undefined,
      'successful=false requires the data field be absent (Requirement 9.4)'
    )

    // 3. An error event with code='VELOCITY_SECRET_MISSING' was emitted.
    const errorEvents = events.filter((e) => e[0] === 'error')
    assert.strictEqual(errorEvents.length, 1, 'expected exactly one error event')
    const err = errorEvents[0][1]
    assert.strictEqual(err.code, 'VELOCITY_SECRET_MISSING')
    assert.match(err.message, /velocity/i)

    // 4. error.protocolVersion === 775 (tagWith261).
    assert.strictEqual(err.protocolVersion, 775)

    // 5. The challenge event must precede the error event in the transcript.
    const challengeIdx = events.findIndex((e) => e[0] === 'challenge')
    const errorIdx = events.findIndex((e) => e[0] === 'error')
    assert.ok(
      challengeIdx >= 0 && errorIdx >= 0 && challengeIdx < errorIdx,
      "'velocityForwardingChallenge' must be emitted before 'error'"
    )

    // 6. Socket NOT disconnected.
    assert.strictEqual(client._endCalls, 0, 'NMP must not call client.end()')
    assert.strictEqual(
      client.socket._destroyed,
      0,
      'NMP must not destroy the underlying socket'
    )
    assert.strictEqual(client.ended, false)
  })

  it('handles arbitrary messageId and arbitrary VarInt version in the challenge payload', function () {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0x7fffffff }), // messageId
        fc.integer({ min: 1, max: 0x7f }), // version (single-byte VarInt for simplicity)
        (messageId, version) => {
          const client = makeMockClient()
          wirePluginChannels(client, {
            version: '26.1.2',
            velocityForwardingSecret: null
          })

          let observedChallenge = null
          let observedError = null
          client.on('velocityForwardingChallenge', (p) => { observedChallenge = p })
          client.on('error', (e) => { observedError = e })

          const writesBefore = client._writes.length
          client.emit('login_plugin_request', {
            messageId,
            channel: 'velocity:player_info',
            data: Buffer.from([version])
          })

          assert.deepStrictEqual(observedChallenge, { version })
          assert.ok(observedError)
          assert.strictEqual(observedError.code, 'VELOCITY_SECRET_MISSING')
          assert.strictEqual(observedError.protocolVersion, 775)

          const responseWrite = client._writes
            .slice(writesBefore)
            .find((w) => w.name === 'login_plugin_response')
          assert.ok(responseWrite)
          assert.strictEqual(responseWrite.params.messageId, messageId)
          assert.strictEqual(responseWrite.params.data, undefined)

          // Socket must remain intact across all randomized inputs.
          assert.strictEqual(client._endCalls, 0)
          assert.strictEqual(client.socket._destroyed, 0)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('non-velocity channels go through the default "not understood" path (no challenge event, no error)', function () {
    const client = makeMockClient()
    wirePluginChannels(client, {
      version: '26.1.2',
      velocityForwardingSecret: null
    })

    let challengeFired = false
    let errorFired = false
    client.on('velocityForwardingChallenge', () => { challengeFired = true })
    client.on('error', () => { errorFired = true })

    const writesBefore = client._writes.length
    client.emit('login_plugin_request', {
      messageId: 42,
      channel: 'fabric:something_else',
      data: Buffer.alloc(0)
    })

    assert.strictEqual(challengeFired, false)
    assert.strictEqual(errorFired, false)

    const responseWrite = client._writes
      .slice(writesBefore)
      .find((w) => w.name === 'login_plugin_response')
    assert.ok(responseWrite, 'still must respond per Notchian "not understood"')
    assert.strictEqual(responseWrite.params.messageId, 42)
    assert.strictEqual(responseWrite.params.data, undefined)
  })
})
