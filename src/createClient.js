'use strict'

const DefaultClientImpl = require('./client')
const assert = require('assert')

const encrypt = require('./client/encrypt')
const keepalive = require('./client/keepalive')
const compress = require('./client/compress')
const auth = require('./client/mojangAuth')
const microsoftAuth = require('./client/microsoftAuth')
const setProtocol = require('./client/setProtocol')
const play = require('./client/play')
const tcpDns = require('./client/tcp_dns')
const autoVersion = require('./client/autoVersion')
const pluginChannels = require('./client/pluginChannels')
const versionChecking = require('./client/versionChecking')
const uuid = require('./datatypes/uuid')
const tagWith261 = require('./utils/tagWith261')

module.exports = createClient

function createClient (options) {
  assert.ok(options, 'options is required')
  assert.ok(options.username, 'username is required')
  if (!options.version && !options.realms) { options.version = false }
  if (options.realms && options.auth !== 'microsoft') throw new Error('Currently Realms can only be joined with auth: "microsoft"')

  // TODO: avoid setting default version if autoVersion is enabled
  const optVersion = options.version || require('./version').defaultVersion
  const mcData = require('minecraft-data')(optVersion)
  if (!mcData) throw new Error(`unsupported protocol version: ${optVersion}`)
  if (!mcData.protocol) {
    const err = new Error(`Missing protocol data: the version directory for ${optVersion} (data/pc/${mcData.version.majorVersion}/) does not contain protocol.json`)
    if (mcData.version.version >= 775) tagWith261(err, mcData.version.version)
    throw err
  }
  const version = mcData.version
  options.majorVersion = version.majorVersion
  options.protocolVersion = version.version

  // Velocity Modern Forwarding options (Requirement 9.3, 10.3)
  if (options.velocityForwardingSecret === undefined) {
    options.velocityForwardingSecret = null
  }
  if (options.velocityForwardingVersion === undefined) {
    options.velocityForwardingVersion = 1
  }
  if (options.velocityForwardingVersion < 1 || options.velocityForwardingVersion > 4) {
    throw new Error('velocityForwardingVersion must be in range [1, 4]')
  }

  const hideErrors = options.hideErrors || false
  const Client = options.Client || DefaultClientImpl

  const client = new Client(false, version.minecraftVersion, options.customPackets, hideErrors)

  tcpDns(client, options)

  // Deferred-connection support: when options.autoConnect === false the socket
  // is not opened automatically. Instead the caller starts it by calling
  // client.startConnection(). All internal call sites that used to invoke
  // options.connect(client) directly are routed through a gate so the behavior
  // is identical once started, and the gate is idempotent.
  const autoConnect = options.autoConnect !== false
  const userConnect = options.connect
  let connectStarted = false
  let startRequested = false
  function startConnection () {
    if (connectStarted) return
    startRequested = true
    if (authPending) return // wait until auth finishes; it will re-enter via gatedConnect
    connectStarted = true
    userConnect(client)
  }
  // Auth flows call options.connect(client) when they finish. Replace it with a
  // gate that connects immediately by default, or only after startConnection().
  let authPending = !autoConnect
  function gatedConnect () {
    authPending = false
    if (autoConnect || startRequested) startConnection()
  }
  options.connect = gatedConnect
  client.startConnection = startConnection

  if (options.auth instanceof Function) {
    options.auth(client, options)
    onReady()
  } else {
    switch (options.auth) {
      case 'mojang':
        auth(client, options)
        onReady()
        break
      case 'microsoft':
        if (options.realms) {
          microsoftAuth.realmAuthenticate(client, options).then(() => microsoftAuth.authenticate(client, options)).catch((err) => client.emit('error', err)).then(onReady)
        } else {
          microsoftAuth.authenticate(client, options).catch((err) => client.emit('error', err))
          onReady()
        }
        break
      case 'offline':
      default:
        client.username = options.username
        client.uuid = uuid.nameToMcOfflineUUID(client.username)
        options.auth = 'offline'
        options.connect(client)
        onReady()
        break
    }
  }

  function onReady () {
    if (options.version === false) autoVersion(client, options)
    setProtocol(client, options)
    keepalive(client, options)
    encrypt(client, options)
    play(client, options)
    compress(client, options)
    pluginChannels(client, options)
    versionChecking(client, options)
  }

  return client
}
