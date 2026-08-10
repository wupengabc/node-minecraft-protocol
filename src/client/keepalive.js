'use strict'

module.exports = function (client, options) {
  const keepAlive = options.keepAlive == null ? true : options.keepAlive
  if (!keepAlive) return

  const checkTimeoutInterval = options.checkTimeoutInterval || 30 * 1000

  client.on('keep_alive', onKeepAlive)
  client.on('state', onState)

  let timeout = null

  client.on('end', clearTimeout)

  function onKeepAlive (packet) {
    scheduleTimeout(checkTimeoutInterval)
    client.writePriority('keep_alive', {
      keepAliveId: packet.keepAliveId
    })
  }

  function onState (state) {
    clearTimeout()
    if (state === 'play') {
      scheduleTimeout(checkTimeoutInterval)
    }
  }

  function scheduleTimeout (delay) {
    clearTimeout()
    timeout = setTimeout(() => {
      timeout = null
      const elapsed = Date.now() - client._lastSocketActivity

      if (client._lastSocketActivity && elapsed < checkTimeoutInterval) {
        scheduleTimeout(checkTimeoutInterval - elapsed)
        return
      }

      client.emit('error', new Error(`client timed out after ${checkTimeoutInterval} milliseconds`))
      client.end('keepAliveError')
    }, delay)
  }

  function clearTimeout () {
    if (timeout) {
      globalThis.clearTimeout(timeout)
      timeout = null
    }
  }
}
