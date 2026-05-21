'use strict'

const crypto = require('crypto')

// --- Constants ---

const CHANNEL = 'velocity:player_info'

// --- Error codes ---

const VELOCITY_VERSION_OUT_OF_RANGE = 'VELOCITY_VERSION_OUT_OF_RANGE'
const VELOCITY_USERNAME_MISSING = 'VELOCITY_USERNAME_MISSING'

// --- Inline serialization helpers (Minecraft VarInt / String / UUID) ---

/**
 * Encode a 32-bit integer as a Minecraft VarInt (1–5 bytes).
 * @param {number} value
 * @returns {Buffer}
 */
function writeVarInt (value) {
  const buf = Buffer.alloc(5)
  let offset = 0
  let v = value >>> 0 // treat as unsigned 32-bit
  while (v > 0x7f) {
    buf[offset++] = (v & 0x7f) | 0x80
    v >>>= 7
  }
  buf[offset++] = v & 0x7f
  return buf.slice(0, offset)
}

/**
 * Encode a UTF-8 string with a VarInt length prefix (Minecraft String).
 * @param {string} str
 * @returns {Buffer}
 */
function writeString (str) {
  const strBuf = Buffer.from(str, 'utf8')
  const lenBuf = writeVarInt(strBuf.length)
  return Buffer.concat([lenBuf, strBuf])
}

/**
 * Parse a UUID string 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' into a 16-byte Buffer.
 * Also accepts a Buffer directly (must be 16 bytes).
 * @param {string|Buffer} uuid
 * @returns {Buffer} 16-byte big-endian UUID
 */
function parseUuid (uuid) {
  if (Buffer.isBuffer(uuid)) {
    if (uuid.length !== 16) {
      throw new Error('velocityForwarding: uuid Buffer must be exactly 16 bytes')
    }
    return uuid
  }
  if (typeof uuid === 'string') {
    const hex = uuid.replace(/-/g, '')
    if (hex.length !== 32) {
      throw new Error('velocityForwarding: uuid must be 16-byte Buffer or UUID string')
    }
    return Buffer.from(hex, 'hex')
  }
  throw new Error('velocityForwarding: uuid must be 16-byte Buffer or UUID string')
}

// --- Core functions ---

/**
 * Returns true if the packet is a Velocity Modern Forwarding challenge.
 * Matches channel name 'velocity:player_info' case-sensitively.
 * @param {{ channel: string }} packet
 * @returns {boolean}
 */
function isVelocityChallenge (packet) {
  return packet.channel === CHANNEL
}

/**
 * Derive an offline-mode UUID from a username, matching Java's
 * UUID.nameUUIDFromBytes("OfflinePlayer:" + username).
 *
 * This produces a UUID v3 (MD5-based, with version/variant bits set).
 * @param {string} username
 * @returns {string} UUID string in 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' format
 */
function deriveOfflineUuid (username) {
  const hash = crypto.createHash('md5')
  hash.update('OfflinePlayer:' + username, 'utf8')
  const buf = hash.digest()
  // Set version to 3 (MD5 name-based)
  buf[6] = (buf[6] & 0x0f) | 0x30
  // Set variant to IETF (10xx)
  buf[8] = (buf[8] & 0x3f) | 0x80
  // Format as UUID string
  const hex = buf.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-')
}

/**
 * Serialize a GameProfile properties array in Minecraft's wire format:
 *   VarInt count, then for each property:
 *     String name, String value, Bool hasSignature, [String signature if true]
 * @param {Array<{name: string, value: string, signature?: string}>} properties
 * @returns {Buffer}
 */
function writeProperties (properties) {
  const parts = [writeVarInt(properties.length)]
  for (const prop of properties) {
    parts.push(writeString(prop.name))
    parts.push(writeString(prop.value))
    if (prop.signature) {
      parts.push(Buffer.from([0x01])) // hasSignature = true
      parts.push(writeString(prop.signature))
    } else {
      parts.push(Buffer.from([0x00])) // hasSignature = false
    }
  }
  return Buffer.concat(parts)
}

/**
 * Build the Velocity Modern Forwarding HMAC response.
 *
 * Output layout (HMAC_Response_Shape):
 *   signature (32 bytes, HMAC-SHA256) || forwardingPayloadBytes
 *
 * Where forwardingPayloadBytes =
 *   version (VarInt) || playerAddress (String) || playerUUID (16B big-endian)
 *   || playerUsername (String) || properties (GameProfile array)
 *
 * @param {{ secret: string, version?: number, address?: string, uuid?: string|Buffer, username: string, properties?: Array }} opts
 * @returns {Buffer}
 */
function buildForwardingResponse ({ secret, version, address, uuid, username, properties }) {
  // --- Input validation (BEFORE crypto) ---

  // version defaults to 1, must be in [1, 4]
  if (version === undefined || version === null) {
    version = 1
  }
  if (version < 1 || version > 4) {
    const err = new Error('velocityForwarding: version must be in range [1, 4]')
    err.code = VELOCITY_VERSION_OUT_OF_RANGE
    throw err
  }

  // username is required
  if (!username) {
    const err = new Error('velocityForwarding: username is required to build payload')
    err.code = VELOCITY_USERNAME_MISSING
    throw err
  }

  // uuid missing → derive offline UUID
  if (!uuid) {
    uuid = deriveOfflineUuid(username)
  }

  // properties non-array → []
  if (!Array.isArray(properties)) {
    properties = []
  }

  // address defaults to '127.0.0.1'
  if (!address) {
    address = '127.0.0.1'
  }

  // --- Serialize forwardingPayloadBytes ---

  const uuidBuf = parseUuid(uuid)

  const forwardingPayloadBytes = Buffer.concat([
    writeVarInt(version),
    writeString(address),
    uuidBuf,
    writeString(username),
    writeProperties(properties)
  ])

  // --- HMAC-SHA256 signature ---

  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
  hmac.update(forwardingPayloadBytes)
  const signature = hmac.digest() // 32 bytes

  // --- Assemble final response: signature || payload ---

  return Buffer.concat([signature, forwardingPayloadBytes])
}

module.exports = {
  CHANNEL,
  isVelocityChallenge,
  deriveOfflineUuid,
  buildForwardingResponse
}
