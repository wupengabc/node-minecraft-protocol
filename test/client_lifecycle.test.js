'use strict'
/* eslint-env mocha */

const assert = require('assert')
const crypto = require('crypto')
const EventEmitter = require('events')
const yggdrasil = require('yggdrasil')
const installCookie = require('../src/client/cookie')
const installEncrypt = require('../src/client/encrypt')
const installPlay = require('../src/client/play')
const createClient = require('../src/createClient')
const { createSerializer, createDeserializer } = require('../src/transforms/serializer')

// Vanilla26.2/26.3: Handshake listener129-145,198-201,242-244;
// common listener cookie handlers; StoreCookie/ServerboundCookieResponse nullable 5120-byte codec.
function fixture (version, state = 'login') {
  const client = new EventEmitter()
  Object.assign(client, { version, state, writes: [], errors: [] })
  client.write = (name, params) => {
    const serializer = createSerializer({ version, state: client.state })
    const deserializer = createDeserializer({ version, state: client.state, isServer: true })
    const buffer = serializer.createPacketBuffer({ name, params })
    const parsed = deserializer.parsePacketBuffer(buffer)
    assert.strictEqual(parsed.metadata.size, buffer.length)
    client.writes.push({ state: client.state, ...parsed.data, buffer })
    serializer.destroy()
    deserializer.destroy()
  }
  client.end = (reason) => {
    client.endReason = reason
    client.emit('end', reason)
  }
  client.on('error', err => client.errors.push(err))
  client.receive = (name, params) => {
    const serializer = createSerializer({ version, state: client.state, isServer: true })
    const deserializer = createDeserializer({ version, state: client.state })
    const buffer = serializer.createPacketBuffer({ name, params })
    const parsed = deserializer.parsePacketBuffer(buffer)
    assert.strictEqual(parsed.metadata.size, buffer.length)
    client.emit(parsed.data.name, parsed.data.params)
    serializer.destroy()
    deserializer.destroy()
  }
  return client
}

describe('source-backed client lifecycle', function () {
  for (const version of ['26.2', '26.3']) {
    describe(version, function () {
      it('responds to absent, present and empty cookies across login, configuration and play', function () {
        const client = fixture(version)
        const seed = Buffer.from([1, 2, 3])
        const options = { cookies: new Map([['test:seed', seed]]) }
        installCookie(client, options)
        seed.fill(0)
        client.receive('cookie_request', { cookie: 'test:absent' })
        client.receive('cookie_request', { cookie: 'test:seed' })
        assert.strictEqual(client.writes[0].params.value, undefined)
        assert.deepStrictEqual(client.writes[1].params.value, Buffer.from([1, 2, 3]))
        assert.deepStrictEqual(client.writes[0].buffer, Buffer.concat([Buffer.from([4, 11]), Buffer.from('test:absent'), Buffer.from([0])]))
        assert.deepStrictEqual(client.writes[1].buffer, Buffer.concat([Buffer.from([4, 9]), Buffer.from('test:seed'), Buffer.from([1, 3, 1, 2, 3])]))

        client.state = 'configuration'
        client.receive('store_cookie', { key: 'test:seed', value: Buffer.alloc(0) })
        client.receive('cookie_request', { cookie: 'test:seed' })
        assert.deepStrictEqual(client.writes[2].params.value, Buffer.alloc(0))
        assert.deepStrictEqual(client.writes[2].buffer, Buffer.concat([Buffer.from([1, 9]), Buffer.from('test:seed'), Buffer.from([1, 0])]))
        const maxPayload = Buffer.alloc(5120, 0xab)
        client.receive('store_cookie', { key: 'test:max', value: maxPayload })
        client.state = 'play'
        client.receive('cookie_request', { cookie: 'test:max' })
        assert.deepStrictEqual(client.writes[3].params.value, maxPayload)
        assert.deepStrictEqual(client.writes[3].buffer, Buffer.concat([Buffer.from([0x15, 8]), Buffer.from('test:max'), Buffer.from([1, 0x80, 0x28]), maxPayload]))
        client.state = 'configuration'
        client.receive('cookie_request', { cookie: 'test:max' })
        assert.deepStrictEqual(client.writes[4].params.value, maxPayload)
        assert.deepStrictEqual(options.cookies.get('test:seed'), seed)
        assert.strictEqual(options.cookies.has('test:max'), false)
      })

      it('rejects oversized store payloads without caching or echoing them', function () {
        const client = fixture(version, 'configuration')
        installCookie(client, {})
        client.receive('store_cookie', { key: 'test:large', value: Buffer.alloc(5121) })
        assert.strictEqual(client.endReason, 'invalidCookie')
        assert.match(client.errors[0].message, /5120/)
        assert.strictEqual(client.cookies.size, 0)
        assert.strictEqual(client.writes.length, 0)
      })

      it('rejects oversized or invalid seed cookies before connecting', function () {
        assert.throws(() => installCookie(fixture(version), { cookies: new Map([['test:key', Buffer.alloc(5121)]]) }), /5120/)
        assert.throws(() => installCookie(fixture(version), { cookies: new Map([['test:key', 'not bytes']]) }), /Buffer/)
      })

      it('copies stored payloads and refuses invalid direct cache mutations', function () {
        const client = fixture(version, 'configuration')
        installCookie(client, {})
        const payload = Buffer.from([8, 9])
        client.emit('store_cookie', { key: 'test:key', value: payload })
        payload.fill(0)
        client.receive('cookie_request', { cookie: 'test:key' })
        assert.deepStrictEqual(client.writes[0].params.value, Buffer.from([8, 9]))
        client.cookies.set('test:key', Buffer.alloc(5121))
        client.receive('cookie_request', { cookie: 'test:key' })
        assert.strictEqual(client.writes.length, 1)
        assert.strictEqual(client.endReason, 'invalidCookie')
      })

      for (const state of ['configuration', 'play']) {
        it(`notifies transfer in ${state} with an explicit isolated cookie handoff`, function () {
          const client = fixture(version, state)
          installCookie(client, {})
          client.receive('store_cookie', { key: 'test:key', value: Buffer.from([7]) })
          let request
          let rawTransfer
          client.on('transferRequested', packet => { request = packet })
          client.on('transfer', packet => { rawTransfer = packet })
          client.receive('transfer', { host: 'destination.invalid', port: 25566 })
          assert.deepStrictEqual(rawTransfer, { host: 'destination.invalid', port: 25566 })
          assert.strictEqual(request.host, rawTransfer.host)
          assert.strictEqual(request.port, rawTransfer.port)
          assert.notStrictEqual(request.cookies, client.cookies)
          assert.notStrictEqual(request.cookies.get('test:key'), client.cookies.get('test:key'))
          assert.strictEqual(client.endReason, undefined)
          assert.strictEqual(client.writes.length, 0)
          client.end('test')
          assert.strictEqual(client.cookies.size, 0)
          const target = fixture(version)
          installCookie(target, { cookies: request.cookies })
          request.cookies.get('test:key').fill(0)
          target.receive('cookie_request', { cookie: 'test:key' })
          assert.deepStrictEqual(target.writes[0].params.value, Buffer.from([7]))
          const unrelated = fixture(version)
          installCookie(unrelated, {})
          unrelated.receive('cookie_request', { cookie: 'test:key' })
          assert.strictEqual(unrelated.writes[0].params.value, undefined)
        })
      }

      it('installs cookie handling through createClient without opening a connection', function () {
        let connections = 0
        const client = createClient({
          username: 'test',
          version,
          auth: 'offline',
          autoConnect: false,
          keepAlive: false,
          connect: () => { connections++ },
          cookies: new Map([['test:key', Buffer.from([42])]])
        })
        client.state = 'login'
        const replies = []
        client.write = (name, params) => replies.push({ name, params })
        client.emit('cookie_request', { cookie: 'test:key' })
        client.emit('transfer', { host: 'destination.invalid', port: 25566 })
        assert.strictEqual(connections, 0)
        assert.deepStrictEqual(replies, [{ name: 'cookie_response', params: { key: 'test:key', value: Buffer.from([42]) } }])
        client.emit('end')
      })

      it('answers configuration pings exactly once without taking over play ping handling', function () {
        const client = fixture(version, 'configuration')
        installPlay(client, {})
        for (const id of [-2147483648, 0, 2147483647]) client.receive('ping', { id })
        assert.deepStrictEqual(client.writes.map(p => p.params), [{ id: -2147483648 }, { id: 0 }, { id: 2147483647 }])
        assert.ok(client.writes.every(p => p.name === 'pong'))
        client.state = 'play'
        client.receive('ping', { id: 4 })
        assert.strictEqual(client.writes.length, 3)
      })

      for (const brand of [undefined, 'mineflayer', 'custom-client', 'client-\u00e9', 'x'.repeat(130)]) {
        it(`sends initial configuration brand ${brand ?? '(default)'} before settings, without repeating on reconfiguration`, function () {
          const client = fixture(version)
          installPlay(client, { brand })
          client.receive('success', {
            uuid: '00000000-0000-0000-0000-000000000001',
            sessionId: '00000000-0000-0000-0000-000000000001',
            username: 'test',
            properties: []
          })
          assert.deepStrictEqual(client.writes.map(p => [p.state, p.name]), [
            ['login', 'login_acknowledged'], ['configuration', 'custom_payload'], ['configuration', 'settings']
          ])
          const payload = client.writes[1].params
          const expectedBrand = brand ?? 'minecraft-protocol'
          assert.strictEqual(payload.channel, 'minecraft:brand')
          const length = Buffer.byteLength(expectedBrand)
          const prefix = length > 127 ? Buffer.from([0x82, 0x01]) : Buffer.from([length])
          assert.deepStrictEqual(payload.data, Buffer.concat([prefix, Buffer.from(expectedBrand)]))
          client.receive('finish_configuration', {})
          client.receive('start_configuration', {})
          client.receive('finish_configuration', {})
          assert.strictEqual(client.writes.filter(p => p.name === 'custom_payload').length, 1)
          assert.strictEqual(client.writes.filter(p => p.name === 'configuration_acknowledged').length, 1)
          assert.strictEqual(client.listenerCount('finish_configuration'), 0)
        })
      }

      it('renews chat sessions on each online play login and skips offline or disabled signing', function () {
        const client = fixture(version)
        installPlay(client, {})
        client.receive('success', {
          uuid: '00000000-0000-0000-0000-000000000001',
          sessionId: '00000000-0000-0000-0000-000000000001',
          username: 'test',
          properties: []
        })
        client.receive('finish_configuration', {})
        const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
        client.profileKeys = { public: keys.publicKey, private: keys.privateKey, expiresOn: new Date(0), signatureV2: Buffer.alloc(256) }
        client.cipher = true
        client.session = { selectedProfile: { id: '00000000000000000000000000000001' } }
        client.emit('login', { onlineMode: true })
        const firstSession = client._session
        firstSession.index = 10
        client.receive('start_configuration', {})
        client.receive('finish_configuration', {})
        client.emit('login', { onlineMode: true })
        assert.notStrictEqual(client._session.uuid, firstSession.uuid)
        assert.strictEqual(client._session.index, 0)
        assert.strictEqual(client.writes.filter(p => p.name === 'chat_session_update').length, 2)
        client.receive('start_configuration', {})
        client.receive('finish_configuration', {})
        client.emit('login', { onlineMode: false })
        assert.strictEqual(client._session, undefined)
        assert.strictEqual(client.writes.filter(p => p.name === 'chat_session_update').length, 2)

        const disabled = fixture(version, 'play')
        installPlay(disabled, { disableChatSigning: true })
        Object.assign(disabled, { uuid: client.uuid, session: client.session, cipher: true, profileKeys: client.profileKeys })
        disabled.emit('login', { onlineMode: true })
        assert.strictEqual(disabled._session, undefined)
        assert.strictEqual(disabled.writes.length, 0)
      })
    })
  }

  it('does not send configuration brand for versions without configuration state', function () {
    const client = fixture('1.8.9')
    installPlay(client, {})
    client.emit('success', { username: 'test', uuid: '00000000-0000-0000-0000-000000000001' })
    assert.strictEqual(client.state, 'play')
    assert.deepStrictEqual(client.writes, [])
  })

  describe('session authentication flag', function () {
    let originalServer
    let joins
    let joinError
    let publicKey

    before(function () {
      originalServer = yggdrasil.server
      publicKey = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' })
      // Stub the factory before installing encryption: no real session client or API is used.
      yggdrasil.server = () => ({
        join: (...args) => {
          joins.push(args.slice(0, -1))
          args.at(-1)(joinError)
        }
      })
    })
    beforeEach(function () {
      joins = []
      joinError = undefined
    })
    after(function () { yggdrasil.server = originalServer })

    for (const version of ['26.2', '26.3']) {
      for (const shouldAuthenticate of [false, true]) {
        it(`${version} ${shouldAuthenticate ? 'joins the session' : 'skips session authentication'} while still enabling encryption`, async function () {
          const client = fixture(version)
          client.session = { selectedProfile: { id: '00000000000000000000000000000001' } }
          const encrypted = new Promise(resolve => { client.setEncryption = resolve })
          installEncrypt(client, { haveCredentials: true, accessToken: 'stub-only-token' })
          client.receive('encryption_begin', { serverId: '', publicKey, verifyToken: Buffer.from([1, 2, 3, 4]), shouldAuthenticate })
          const secret = await encrypted
          assert.strictEqual(secret.length, 16)
          assert.strictEqual(joins.length, shouldAuthenticate ? 1 : 0)
          if (shouldAuthenticate) {
            assert.strictEqual(joins[0][0], 'stub-only-token')
            assert.strictEqual(joins[0][1], client.session.selectedProfile.id)
            assert.deepStrictEqual(joins[0][3], secret)
          }
          assert.strictEqual(client.writes.length, 1)
          assert.strictEqual(client.writes[0].name, 'encryption_begin')
          assert.strictEqual(client.writes[0].params.sharedSecret.length, 128)
          assert.strictEqual(client.writes[0].params.verifyToken.length, 128)
          assert.strictEqual(client.errors.length, 0)
        })
      }

      it(`${version} remains compatible with offline encrypted servers without credentials`, async function () {
        const client = fixture(version)
        const encrypted = new Promise(resolve => { client.setEncryption = resolve })
        installEncrypt(client, {})
        client.receive('encryption_begin', { serverId: '-', publicKey, verifyToken: Buffer.alloc(4), shouldAuthenticate: false })
        await encrypted
        assert.strictEqual(joins.length, 0)
        assert.strictEqual(client.writes.length, 1)
      })

      it(`${version} ends login on session failure without sending the encryption response`, async function () {
        const client = fixture(version)
        client.session = { selectedProfile: { id: '00000000000000000000000000000001' } }
        client.setEncryption = () => assert.fail('must not enable encryption after failed authentication')
        joinError = new Error('stubbed session rejection')
        const ended = new Promise(resolve => client.once('end', resolve))
        installEncrypt(client, { haveCredentials: true, accessToken: 'stub-only-token' })
        client.receive('encryption_begin', { serverId: '', publicKey, verifyToken: Buffer.alloc(4), shouldAuthenticate: true })
        assert.strictEqual(await ended, 'encryptionLoginError')
        assert.strictEqual(joins.length, 1)
        assert.strictEqual(client.writes.length, 0)
        assert.strictEqual(client.errors[0], joinError)
      })
    }

    it('keeps session authentication for legacy login packets without the flag', async function () {
      const client = fixture('1.8.9')
      client.session = { selectedProfile: { id: '00000000000000000000000000000001' } }
      const encrypted = new Promise(resolve => { client.setEncryption = resolve })
      installEncrypt(client, { haveCredentials: true, accessToken: 'stub-only-token' })
      client.receive('encryption_begin', { serverId: '', publicKey, verifyToken: Buffer.alloc(4) })
      await encrypted
      assert.strictEqual(joins.length, 1)
      assert.strictEqual(client.writes.length, 1)
    })
  })
})
