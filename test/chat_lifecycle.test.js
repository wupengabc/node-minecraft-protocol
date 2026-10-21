'use strict'
/* eslint-env mocha */

const assert = require('assert')
const crypto = require('crypto')
const EventEmitter = require('events')
const installPlay = require('../src/client/play')
const installChat = require('../src/client/chat')
const states = require('../src/states')
const { createSerializer, createDeserializer } = require('../src/transforms/serializer')
const { stalledClient, decodeWire } = require('./common/outbound')

const playerUuid = '00000000-0000-0000-0000-000000000001'
const senderUuid = '00000000-0000-0000-0000-000000000002'

function receiveChat (client, value = 1) {
  client.emit('player_chat', {
    senderUuid,
    signature: Buffer.alloc(256, value),
    plainMessage: 'incoming',
    index: value,
    timestamp: BigInt(Date.now()),
    salt: 1n,
    previousMessages: []
  })
}

function fixture (version, options = {}) {
  const client = new EventEmitter()
  client.version = version
  client.state = states.LOGIN
  client.cipher = {}
  client.session = { selectedProfile: { id: playerUuid.replace(/-/g, '') } }
  client.profileKeys = {
    private: 'stub-private-key',
    public: { export: () => Buffer.from('stub-public-key') },
    expiresOn: new Date(Date.now() + 3600000),
    signatureV2: Buffer.alloc(256, 7)
  }
  const writes = []
  client.write = (name, params) => {
    const serializer = createSerializer({ state: client.state, version, isServer: false })
    const parser = createDeserializer({ state: client.state, version, isServer: true, noErrorLogging: true })
    const buffer = serializer.createPacketBuffer({ name, params })
    const parsed = parser.parsePacketBuffer(buffer)
    assert.strictEqual(parsed.metadata.size, buffer.length)
    writes.push({ name, params: parsed.data.params, state: client.state })
    serializer.destroy()
    parser.destroy()
  }
  installPlay(client, options)
  client.emit('success', { uuid: playerUuid, username: 'test' })
  client.emit('finish_configuration', {})
  client.emit('login', { onlineMode: true })
  return { client, writes }
}

describe('chat signing across configuration', function () {
  let originalSign
  let signed
  beforeEach(function () {
    originalSign = crypto.sign
    signed = []
    crypto.sign = (algorithm, buffer, key) => {
      assert.strictEqual(algorithm, 'RSA-SHA256')
      assert.strictEqual(key, 'stub-private-key')
      signed.push(Buffer.from(buffer))
      return Buffer.alloc(256, signed.length)
    }
  })
  afterEach(function () {
    crypto.sign = originalSign
  })

  for (const version of ['26.2', '26.3']) {
    it(`acknowledges pending chat before configuration and retains caches until login (${version})`, function () {
      const { client, writes } = fixture(version)
      for (let i = 1; i <= 3; i++) receiveChat(client, i)
      client._signatureCache.push(Buffer.alloc(256, 9))
      const seen = client._lastSeenMessages
      const cache = client._signatureCache
      const session = client._session
      const history = client._lastChatHistory
      const start = writes.length
      client.emit('start_configuration', {})
      assert.deepStrictEqual(writes.slice(start).map(p => [p.state, p.name]), [
        [states.PLAY, 'message_acknowledgement'],
        [states.PLAY, 'configuration_acknowledged'],
        [states.CONFIGURATION, 'settings']
      ])
      assert.strictEqual(writes[start].params.count, 3)
      assert.strictEqual(seen.pending, 0)
      client.emit('reset_chat', {})
      client.emit('finish_configuration', {})
      assert.strictEqual(client._lastSeenMessages, seen)
      assert.strictEqual(client._signatureCache, cache)
      assert.strictEqual(client._session, session)
      client.emit('login', { onlineMode: true })
      assert.notStrictEqual(client._lastSeenMessages, seen)
      assert.notStrictEqual(client._signatureCache, cache)
      assert.strictEqual(client._lastSeenMessages.pending, 0)
      assert.strictEqual(client._lastSeenMessages.offset, 0)
      assert.strictEqual(client._signatureCache.length, 0)
      assert.notStrictEqual(client._session.uuid, session.uuid)
      assert.strictEqual(client._session.index, 0)
      assert.strictEqual(client._lastChatHistory, history, 'report history survives the signing reset')
    })

    it(`restarts signed indices and acknowledgements on every login (${version})`, function () {
      const { client, writes } = fixture(version)
      const sessions = new Set()
      for (let cycle = 0; cycle < 3; cycle++) {
        sessions.add(client._session.uuid)
        client.chat('first', { timestamp: 1000n, salt: 1n })
        const first = writes.at(-1).params
        assert.strictEqual(first.offset, 0)
        assert.strictEqual(first.checksum, 1)
        assert.deepStrictEqual(first.acknowledged, Buffer.alloc(3))
        assert.strictEqual(signed.at(-1).readInt32BE(36), 0)
        receiveChat(client)
        client.chat('second', { timestamp: 2000n, salt: 1n })
        assert.strictEqual(writes.at(-1).params.offset, 1)
        assert.strictEqual(signed.at(-1).readInt32BE(36), 1)
        assert.ok(signed.at(-1).includes(Buffer.alloc(256, 1)))
        client._signatureCache.push(Buffer.alloc(256, 8))
        client._players[senderUuid] = { stale: true }
        client.emit('start_configuration', {})
        client.emit('finish_configuration', {})
        client.emit('login', { onlineMode: true })
        assert.deepStrictEqual(client._players, {})
      }
      assert.strictEqual(sessions.size, 3)
      assert.strictEqual(writes.filter(p => p.name === 'chat_session_update').length, 4)
    })

    it(`does not reset signing on respawn or reset_chat (${version})`, function () {
      const { client } = fixture(version)
      receiveChat(client)
      const seen = client._lastSeenMessages
      const cache = client._signatureCache
      const session = client._session
      client.emit('respawn', {})
      client.emit('reset_chat', {})
      assert.strictEqual(client._lastSeenMessages, seen)
      assert.strictEqual(seen.pending, 1)
      assert.strictEqual(client._signatureCache, cache)
      assert.strictEqual(client._session, session)
    })

    it(`does not duplicate acknowledgements after a send or configuration entry (${version})`, function () {
      const { client, writes } = fixture(version)
      receiveChat(client)
      client.chat('reply')
      client.emit('start_configuration', {})
      client.emit('start_configuration', {})
      assert.strictEqual(writes.filter(p => p.name === 'message_acknowledgement').length, 0)
      client.emit('finish_configuration', {})
      client.emit('login', { onlineMode: true })
      for (let i = 1; i <= 65; i++) receiveChat(client, i)
      assert.strictEqual(writes.filter(p => p.name === 'message_acknowledgement').length, 1)
      assert.strictEqual(writes.find(p => p.name === 'message_acknowledgement').params.count, 65)
      client.emit('start_configuration', {})
      assert.strictEqual(writes.filter(p => p.name === 'message_acknowledgement').length, 1)
    })

    it(`discards an old signing session when the next login cannot sign (${version})`, function () {
      const { client, writes } = fixture(version)
      client.chat('signed')
      client.emit('start_configuration', {})
      client.emit('finish_configuration', {})
      delete client.profileKeys
      client.emit('login', { onlineMode: true })
      assert.strictEqual(client._session, undefined)
      client.chat('unsigned')
      assert.strictEqual(writes.at(-1).params.signature, undefined)
      assert.strictEqual(signed.length, 1)
    })

    it(`does not reuse an online session for an offline login (${version})`, function () {
      const { client, writes } = fixture(version)
      client.chat('signed')
      client.emit('start_configuration', {})
      client.emit('finish_configuration', {})
      client.emit('login', { onlineMode: false })
      assert.strictEqual(client._session, undefined)
      client.chat('unsigned')
      assert.strictEqual(writes.at(-1).params.signature, undefined)
      assert.strictEqual(writes.filter(p => p.name === 'chat_session_update').length, 1)
      assert.strictEqual(signed.length, 1)
    })

    it(`keeps signing disabled across repeated logins (${version})`, function () {
      const { client, writes } = fixture(version, { disableChatSigning: true })
      for (let cycle = 0; cycle < 3; cycle++) {
        assert.strictEqual(client._session, undefined)
        client.chat('unsigned')
        assert.strictEqual(writes.at(-1).params.signature, undefined)
        client.emit('start_configuration', {})
        client.emit('finish_configuration', {})
        client.emit('login', { onlineMode: true })
      }
      assert.strictEqual(writes.filter(p => p.name === 'chat_session_update').length, 0)
      assert.strictEqual(signed.length, 0)
    })

    for (const transport of ['plain', 'compressed', 'encrypted', 'compressed+encrypted']) {
      it(`preserves acknowledgement FIFO through three stalled transitions (${version}, ${transport})`, async function () {
        const f = stalledClient(version)
        const { client, socket } = f
        try {
          const secret = transport.includes('encrypted') ? Buffer.alloc(16, 7) : undefined
          const compression = transport.includes('compressed')
          if (compression) client.setCompressionThreshold(0)
          if (secret) client.setEncryption(secret)
          client.state = states.LOGIN
          installPlay(client, {})
          client.emit('success', { uuid: playerUuid, username: 'test' })
          const expected = [
            [states.LOGIN, 'login_acknowledged'],
            [states.CONFIGURATION, 'custom_payload'],
            [states.CONFIGURATION, 'settings'],
            [states.CONFIGURATION, 'finish_configuration']
          ]
          client.emit('finish_configuration', {})
          client.emit('login', { onlineMode: false })
          for (let cycle = 0; cycle < 3; cycle++) {
            for (let i = 0; i <= cycle; i++) receiveChat(client, i + 1)
            client.write('tick_end', {})
            client.emit('start_configuration', {})
            client.emit('reset_chat', {})
            client.emit('finish_configuration', {})
            client.emit('login', { onlineMode: false })
            expected.push(
              [states.PLAY, 'tick_end'],
              [states.PLAY, 'message_acknowledgement'],
              [states.PLAY, 'configuration_acknowledged'],
              [states.CONFIGURATION, 'settings'],
              [states.CONFIGURATION, 'finish_configuration']
            )
          }
          assert.strictEqual(f.chunks.length, 1, 'all protocol bytes remain backpressured')
          await f.flush()
          const packets = decodeWire(f.wire(), expected, { version, secret, compression })
          assert.deepStrictEqual(packets.filter((p, i) => expected[i][1] === 'message_acknowledgement').map(p => p.count), [1, 2, 3])
        } finally {
          socket.destroy()
        }
      })
    }
  }

  it('preserves pre-session chat lifecycle behavior', function () {
    const client = new EventEmitter()
    client.version = '1.19.2'
    installChat(client, {})
    const seen = client._lastSeenMessages
    client._lastChatSignature = Buffer.from('legacy-chain')
    client.emit('login', {})
    client.emit('start_configuration', {})
    assert.strictEqual(client._lastSeenMessages, seen)
    assert.strictEqual(client._lastChatSignature.toString(), 'legacy-chain')
  })
})
