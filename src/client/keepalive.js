'use strict'

module.exports = function (client, options) {
  const keepAlive = options.keepAlive == null ? true : options.keepAlive
  if (!keepAlive) return

  const checkTimeoutInterval = options.checkTimeoutInterval || 30 * 1000
  const keepAliveTimeoutGracePeriod = Math.max(0, options.keepAliveTimeoutGracePeriod ?? 5 * 1000)

  client.on('keep_alive', onKeepAlive)
  client.on('state', onState)
  client.on('socketActivity', onSocketActivity)

  let timeout = null
  let graceTimeout = null
  let timeoutDeadline = null
  let graceStartedAt = null
  let graceActivityAt = null
  let graceActivityCount = null
  let lastKeepAliveAt = null
  let lastKeepAliveId = null
  let lastKeepAliveReplyQueuedAt = null

  client._keepAliveConfig = {
    checkTimeoutInterval,
    keepAliveTimeoutGracePeriod
  }

  client.on('end', clearTimers)

  function onKeepAlive (packet) {
    lastKeepAliveAt = Date.now()
    lastKeepAliveId = serializableValue(packet.keepAliveId)
    client._lastKeepAliveAt = lastKeepAliveAt
    client._lastKeepAliveId = lastKeepAliveId
    recoverFromGrace('keep_alive')
    scheduleTimeout(checkTimeoutInterval)
    lastKeepAliveReplyQueuedAt = Date.now()
    client._lastKeepAliveReplyQueuedAt = lastKeepAliveReplyQueuedAt
    client.writePriority('keep_alive', {
      keepAliveId: packet.keepAliveId
    })
  }

  function onState (state) {
    clearTimers()
    // Configuration also carries keep_alive packets (added in 1.20.2) and is
    // where a Velocity backend switch parks the client while it dials the
    // target server. If a failed switch never sends finish_configuration (or
    // any further bytes) while redirecting back to the original backend, the
    // watchdog must still be armed here — otherwise it stays disarmed forever
    // (onState only re-armed for 'play') and the connection hangs with no
    // timeout, no error, and no reconnect.
    if (state === 'play' || state === 'configuration') {
      scheduleTimeout(checkTimeoutInterval)
    }
  }

  function onSocketActivity () {
    recoverFromGrace('socket_activity')
  }

  function scheduleTimeout (delay) {
    clearNormalTimeout()
    timeoutDeadline = Date.now() + delay
    const deadline = timeoutDeadline
    timeout = setTimeout(() => {
      timeout = null
      timeoutDeadline = null
      const now = Date.now()
      const elapsed = client._lastSocketActivity ? now - client._lastSocketActivity : Infinity

      if (client._lastSocketActivity && elapsed < checkTimeoutInterval) {
        scheduleTimeout(checkTimeoutInterval - elapsed)
        return
      }

      startGracePeriod(now, Math.max(0, now - deadline))
    }, delay)
  }

  function startGracePeriod (startedAt, timerDelay) {
    if (graceStartedAt !== null) return

    graceStartedAt = startedAt
    graceActivityAt = client._lastSocketActivity || null
    graceActivityCount = client._socketActivityCount ?? null
    emitDiagnostic('keepAliveWarning', {
      timerDelay,
      graceStartedAt,
      graceActivityAt,
      graceActivityCount
    })

    if (keepAliveTimeoutGracePeriod === 0) {
      finishTimeout(startedAt, timerDelay)
      return
    }

    graceTimeout = setTimeout(() => {
      graceTimeout = null
      if (hasActivitySinceGraceStarted()) {
        recoverFromGrace('socket_activity')
        return
      }
      const now = Date.now()
      finishTimeout(now, Math.max(0, now - (startedAt + keepAliveTimeoutGracePeriod)))
    }, keepAliveTimeoutGracePeriod)
  }

  function finishTimeout (timedOutAt, timerDelay) {
    const diagnostics = emitDiagnostic('keepAliveTimeout', {
      timerDelay,
      graceStartedAt,
      graceElapsed: graceStartedAt === null ? 0 : timedOutAt - graceStartedAt
    })
    const error = new Error(`client timed out after ${checkTimeoutInterval} milliseconds`)
    error.code = 'KEEPALIVE_TIMEOUT'
    error.keepAliveDiagnostics = diagnostics
    client.emit('error', error)
    client.end('keepAliveError')
  }

  function recoverFromGrace (reason) {
    if (graceStartedAt === null) return false

    const recoveredAt = Date.now()
    emitDiagnostic('keepAliveRecovered', {
      recovery: reason,
      graceStartedAt,
      graceElapsed: recoveredAt - graceStartedAt
    })
    clearGraceTimeout()
    graceStartedAt = null
    graceActivityAt = null
    graceActivityCount = null
    scheduleTimeout(checkTimeoutInterval)
    return true
  }

  function hasActivitySinceGraceStarted () {
    if (graceActivityCount !== null && client._socketActivityCount !== undefined) {
      return client._socketActivityCount > graceActivityCount
    }
    return graceActivityAt !== null && client._lastSocketActivity > graceActivityAt
  }

  function emitDiagnostic (event, extra) {
    const now = Date.now()
    const lastSocketActivityAt = client._lastSocketActivity || null
    const diagnostics = {
      at: now,
      phase: event,
      protocolState: client.protocolState,
      protocolVersion: client.protocolVersion,
      checkTimeoutInterval,
      keepAliveTimeoutGracePeriod,
      lastSocketActivityAt,
      socketIdleFor: lastSocketActivityAt === null ? null : now - lastSocketActivityAt,
      socketActivityCount: client._socketActivityCount ?? null,
      lastSocketDataAt: client._lastSocketDataAt ?? null,
      lastSocketEvent: client._lastSocketEvent ?? null,
      socketEventHistory: client._socketEventHistory?.slice() ?? [],
      lastKeepAliveAt,
      lastKeepAliveId,
      lastKeepAliveReplyQueuedAt,
      lastKeepAliveWriteAt: client._lastKeepAliveWriteAt ?? null,
      ...extra
    }
    client._keepAliveDiagnostics = diagnostics
    client.emit(event, diagnostics)
    return diagnostics
  }

  function clearTimers () {
    clearNormalTimeout()
    clearGraceTimeout()
    timeoutDeadline = null
    graceStartedAt = null
    graceActivityAt = null
    graceActivityCount = null
  }

  function clearNormalTimeout () {
    if (timeout) {
      globalThis.clearTimeout(timeout)
      timeout = null
    }
  }

  function clearGraceTimeout () {
    if (graceTimeout) {
      globalThis.clearTimeout(graceTimeout)
      graceTimeout = null
    }
  }

  function serializableValue (value) {
    return typeof value === 'bigint' ? value.toString() : value
  }
}
