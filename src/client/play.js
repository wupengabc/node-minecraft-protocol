const states = require('../states')
const signedChatPlugin = require('./chat')
const uuid = require('uuid-1345')

module.exports = function (client, options) {
  client.serverFeatures = {}
  let configurationHandlers = null
  client.on('server_data', (packet) => {
    client.serverFeatures = {
      chatPreview: packet.previewsChat,
      enforcesSecureChat: packet.enforcesSecureChat // in LoginPacket v>=1.20.5
    }
  })

  client.once('login', (packet) => {
    if (packet.enforcesSecureChat) client.serverFeatures.enforcesSecureChat = packet.enforcesSecureChat
    const mcData = require('minecraft-data')(client.version)
    if (mcData.supportFeature('useChatSessions') && client.profileKeys && client.cipher && client.session.selectedProfile.id === client.uuid.replace(/-/g, '')) {
      client._session = {
        index: 0,
        uuid: uuid.v4fast()
      }

      client.write('chat_session_update', {
        sessionUUID: client._session.uuid,
        expireTime: client.profileKeys ? BigInt(client.profileKeys.expiresOn.getTime()) : undefined,
        publicKey: client.profileKeys ? client.profileKeys.public.export({ type: 'spki', format: 'der' }) : undefined,
        signature: client.profileKeys ? client.profileKeys.signatureV2 : undefined
      })
    }
  })

  client.once('success', onLogin)

  function onLogin (packet) {
    const mcData = require('minecraft-data')(client.version)
    client.uuid = packet.uuid
    client.username = packet.username

    if (mcData.supportFeature('hasConfigurationState')) {
      client.write('login_acknowledged', {})
      enterConfigState(onReady)
      // Server can tell client to re-enter config state
      client.on('start_configuration', () => enterConfigState())
    } else {
      client.state = states.PLAY
      onReady()
    }

    function enterConfigState (finishCb) {
      if (client.state === states.CONFIGURATION) return

      clearConfigurationHandlers()

      const returningFromPlay = client.state === states.PLAY
      // The acknowledgement is a play-state packet. It tells the server that
      // the client is about to switch its parser to configuration.
      if (returningFromPlay) client.write('configuration_acknowledged', {})
      client.state = states.CONFIGURATION

      const onSelectKnownPacks = () => {
        client.write('select_known_packs', { packs: [] })
      }
      const onCodeOfConduct = () => {
        client.write('accept_code_of_conduct', {})
      }
      const onFinishConfiguration = () => {
        clearConfigurationHandlers()
        client.write('finish_configuration', {})
        client.state = states.PLAY
        finishCb?.()
      }

      configurationHandlers = {
        onSelectKnownPacks,
        onCodeOfConduct,
        onFinishConfiguration
      }
      client.once('select_known_packs', onSelectKnownPacks)
      client.once('code_of_conduct', onCodeOfConduct)
      // Server should send finish_configuration on its own right after sending the client a dimension codec
      // for login (that has data about world height, world gen, etc) after getting a login success from client
      client.once('finish_configuration', onFinishConfiguration)
    }

    function clearConfigurationHandlers () {
      if (!configurationHandlers) return
      client.removeListener('select_known_packs', configurationHandlers.onSelectKnownPacks)
      client.removeListener('code_of_conduct', configurationHandlers.onCodeOfConduct)
      client.removeListener('finish_configuration', configurationHandlers.onFinishConfiguration)
      configurationHandlers = null
    }

    function onReady () {
      if (mcData.supportFeature('signedChat')) {
        if (options.disableChatSigning && client.serverFeatures.enforcesSecureChat) {
          throw new Error('"disableChatSigning" was enabled in client options, but server is enforcing secure chat')
        }
        signedChatPlugin(client, options)
      } else {
        client.on('chat', (packet) => {
          client.emit(packet.position === 0 ? 'playerChat' : 'systemChat', {
            formattedMessage: packet.message,
            sender: packet.sender,
            positionId: packet.position,
            verified: false
          })
        })
      }

      function unsignedChat (message) {
        client.write('chat', { message })
      }
      client.chat = client._signedChat || unsignedChat
      client.emit('playerJoin')
    }
  }
}
