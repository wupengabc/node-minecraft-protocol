'use strict'

const MAX_COOKIE_SIZE = 5120

module.exports = function (client, options) {
  // Cookies survive protocol-state switches, but are never shared implicitly between connections.
  const cookies = new Map()
  for (const [key, value] of options.cookies || []) {
    validateCookie(value)
    cookies.set(key, Buffer.from(value))
  }
  client.cookies = cookies

  client.on('cookie_request', ({ cookie }) => {
    const value = cookies.get(cookie)
    if (value !== undefined && !checkPayload(value)) return
    client.write('cookie_response', { key: cookie, value: value === undefined ? null : Buffer.from(value) })
  })

  client.on('store_cookie', ({ key, value }) => {
    if (!checkPayload(value)) return
    cookies.set(key, Buffer.from(value))
  })

  client.on('transfer', ({ host, port }) => {
    // The caller decides whether to connect; this is only a snapshot for an explicit handoff.
    const snapshot = new Map()
    for (const [key, value] of cookies) {
      if (!checkPayload(value)) return
      snapshot.set(key, Buffer.from(value))
    }
    client.emit('transferRequested', { host, port, cookies: snapshot })
  })

  client.once('end', () => cookies.clear())

  function checkPayload (value) {
    try {
      validateCookie(value)
      return true
    } catch (err) {
      client.end('invalidCookie')
      client.emit('error', err)
      return false
    }
  }
}

function validateCookie (value) {
  if (!Buffer.isBuffer(value)) throw new TypeError('Cookie payload must be a Buffer')
  if (value.length > MAX_COOKIE_SIZE) throw new RangeError('Cookie payload exceeds 5120 bytes')
}
