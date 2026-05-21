const ProtoDef = require('protodef').ProtoDef
const minecraft = require('../datatypes/minecraft')
const debug = require('debug')('minecraft-protocol')
const nbt = require('prismarine-nbt')
const [readVarInt] = require('protodef').types.varint
const velocityForwarding = require('../transforms/velocityForwarding')
const tagWith261 = require('../utils/tagWith261')

module.exports = function (client, options) {
  const mcdata = require('minecraft-data')(options.version || require('../version').defaultVersion)
  const channels = []
  const proto = new ProtoDef(options.validateChannelProtocol ?? true)
  nbt.addTypesToInterpreter('big', proto)
  proto.addTypes(mcdata.protocol.types)
  proto.addTypes(minecraft)
  proto.addType('registerarr', [readDumbArr, writeDumbArr, sizeOfDumbArr])

  client.registerChannel = registerChannel
  client.unregisterChannel = unregisterChannel
  client.writeChannel = writeChannel

  const above385 = mcdata.version.version >= 385
  if (above385) { // 1.13-pre3 (385) added Added Login Plugin Message (https://wiki.vg/Protocol_History#1.13-pre3)
    client.on('login_plugin_request', onLoginPluginRequest)
  }
  const channelNames = above385 ? ['minecraft:register', 'minecraft:unregister'] : ['REGISTER', 'UNREGISTER']

  client.registerChannel(channelNames[0], ['registerarr', []])
  client.registerChannel(channelNames[1], ['registerarr', []])

  function registerChannel (name, parser, custom) {
    if (custom) {
      client.writeChannel(channelNames[0], [name])
    }
    if (parser) proto.addType(name, parser)
    channels.push(name)
    if (channels.length === 1) { client.on('custom_payload', onCustomPayload) }
  }

  function unregisterChannel (channel, custom) {
    if (custom) {
      client.writeChannel(channelNames[1], [channel])
    }
    const index = channels.find(function (name) {
      return channel === name
    })
    if (index) {
      proto.types[channel] = undefined
      channels.splice(index, 1)
      if (channels.length === 0) { client.removeListener('custom_payload', onCustomPayload) }
    }
  }

  function onCustomPayload (packet) {
    const channel = channels.find(function (channel) {
      return channel === packet.channel
    })
    if (channel) {
      if (proto.types[channel]) {
        try {
          packet.data = proto.parsePacketBuffer(channel, packet.data).data
        } catch (error) {
          client.emit('error', error)
          return
        }
      }
      debug('read custom payload ' + channel + ' ' + packet.data)
      client.emit(channel, packet.data)
    }
  }

  function onLoginPluginRequest (packet) {
    if (velocityForwarding.isVelocityChallenge(packet)) {
      // Parse the version (single VarInt at the start of packet.data). Default to 1 on failure.
      let parsedVersion = 1
      try {
        if (packet.data && packet.data.length > 0) {
          const result = readVarInt(packet.data, 0)
          if (result && typeof result.value === 'number') {
            parsedVersion = result.value
          }
        }
      } catch (_) {
        parsedVersion = 1
      }

      // Requirement 15.2: emit the challenge event before responding so observers can react.
      client.emit('velocityForwardingChallenge', { version: parsedVersion })

      if (options.velocityForwardingSecret == null) {
        // Requirement 9.4: respond with successful=false (omit data field) and emit a tagged error.
        client.write('login_plugin_response', {
          messageId: packet.messageId
        })
        const err = new Error('Velocity Modern Forwarding challenge received but velocityForwardingSecret is not configured')
        err.code = 'VELOCITY_SECRET_MISSING'
        tagWith261(err)
        client.emit('error', err)
        // Do NOT disconnect the socket — let the proxy decide connection lifecycle.
        return
      }

      // Requirements 9.1, 9.2, 9.5: build and send the HMAC-signed forwarding response.
      const responseBuffer = velocityForwarding.buildForwardingResponse({
        secret: options.velocityForwardingSecret,
        version: options.velocityForwardingVersion ?? 1,
        address: options.localAddress ?? '127.0.0.1',
        uuid: client.uuid,
        username: client.username,
        properties: client.session?.selectedProfile?.properties ?? []
      })
      client.write('login_plugin_response', {
        messageId: packet.messageId,
        data: responseBuffer
      })
      return
    }

    client.write('login_plugin_response', { // write that login plugin request is not understood, just like the Notchian client
      messageId: packet.messageId
    })
  }

  function writeChannel (channel, params) {
    debug('write custom payload ' + channel + ' ' + params)
    client.write('custom_payload', {
      channel,
      data: proto.createPacketBuffer(channel, params)
    })
  }

  function readDumbArr (buf, offset) {
    const ret = {
      value: [],
      size: 0
    }
    let results
    while (offset < buf.length) {
      if (buf.indexOf(0x0, offset) === -1) { results = this.read(buf, offset, 'restBuffer', {}) } else { results = this.read(buf, offset, 'cstring', {}) }
      ret.size += results.size
      ret.value.push(results.value.toString())
      offset += results.size
    }
    return ret
  }

  function writeDumbArr (value, buf, offset) {
    // TODO: Remove trailing \0
    value.forEach(function (v) {
      offset += proto.write(v, buf, offset, 'cstring')
    })
    return offset
  }

  function sizeOfDumbArr (value) {
    return value.reduce((acc, v) => acc + this.sizeOf(v, 'cstring', {}), 0)
  }
}
