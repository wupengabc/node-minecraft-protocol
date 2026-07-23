'use strict'

module.exports = function (client, options) {
  const keepAlive = options.keepAlive == null ? true : options.keepAlive
  if (!keepAlive) return

  const checkTimeoutInterval = options.checkTimeoutInterval || 30 * 1000

  client.on('keep_alive', onKeepAlive)

  let timeout = null

  client.on('end', () => clearTimeout(timeout))

  function onKeepAlive (packet) {
    scheduleTimeout(checkTimeoutInterval)
    client.write('keep_alive', {
      keepAliveId: packet.keepAliveId
    })
  }

  function scheduleTimeout (delay) {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => {
      const elapsed = Date.now() - client._lastSocketActivity

      // Packet parsing may be backlogged, but incoming socket data proves the
      // connection is alive. Do not turn a local processing delay into a timeout.
      if (client._lastSocketActivity && elapsed < checkTimeoutInterval) {
        scheduleTimeout(checkTimeoutInterval - elapsed)
        return
      }

      client.emit('error', new Error(`client timed out after ${checkTimeoutInterval} milliseconds`))
      client.end('keepAliveError')
    }, delay)
  }
}
