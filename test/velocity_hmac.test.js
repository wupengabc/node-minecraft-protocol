'use strict'
/* eslint-env mocha */

// Task 6.4 — Property 4: Velocity HMAC self-verification
//
// Validates: Requirements 9.5, 10.1, 10.2, 10.3, 10.6
//
// Property: For any (secret, version, address, uuid, username, properties),
//   buildForwardingResponse(...) returns `data` such that
//     data[0..32] === HMAC-SHA256(utf8(secret), data[32..])
//   (the response is self-verifying: the 32-byte signature exactly authenticates
//   the trailing forwardingPayloadBytes).
//   Additionally:
//     - Bit-flipping any byte in the response makes verification fail
//     - version outside [1, 4] throws VELOCITY_VERSION_OUT_OF_RANGE
//     - version defaults to 1 when undefined

const assert = require('assert')
const crypto = require('crypto')
const fc = require('fast-check')
const {
  buildForwardingResponse,
  deriveOfflineUuid
} = require('../src/transforms/velocityForwarding')

// --- Generators ---

// Non-empty UTF-8 string for the HMAC secret. fast-check 4.x's fc.string
// already produces full Unicode (including surrogate-paired code points), so
// the secret is encoded as utf8 before being fed to HMAC over a wide range
// of byte sequences.
const secretArb = fc.string({ minLength: 1, maxLength: 64 })

const versionArb = fc.integer({ min: 1, max: 4 })

// Mix of IPv4 and IPv6 string forms.
const ipv4Arb = fc
  .tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 })
  )
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`)

const ipv6Hextet = fc
  .integer({ min: 0, max: 0xffff })
  .map((n) => n.toString(16))
const ipv6Arb = fc
  .tuple(
    ipv6Hextet,
    ipv6Hextet,
    ipv6Hextet,
    ipv6Hextet,
    ipv6Hextet,
    ipv6Hextet,
    ipv6Hextet,
    ipv6Hextet
  )
  .map((parts) => parts.join(':'))

const addressArb = fc.oneof(ipv4Arb, ipv6Arb)

// 16-byte UUID buffer.
const uuidArb = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((arr) => Buffer.from(arr))

// ASCII username, length 1..16, restricted to chars Mojang would accept.
const usernameArb = fc.stringMatching(/^[A-Za-z0-9_]{1,16}$/)

// GameProfile property: { name, value, signature? }
const propertyArb = fc.record(
  {
    name: fc.string({ minLength: 1, maxLength: 32 }),
    value: fc.string({ maxLength: 64 }),
    // signature is optional; when present it's an arbitrary string.
    signature: fc.option(fc.string({ maxLength: 64 }), { nil: undefined })
  },
  { requiredKeys: ['name', 'value'] }
)

// 0..4 properties is plenty; bigger arrays don't add coverage.
const propertiesArb = fc.array(propertyArb, { maxLength: 4 })

// --- Helpers ---

/**
 * Independent verifier: given a secret and a response Buffer, return whether
 * the first 32 bytes are exactly HMAC-SHA256(utf8(secret), tail-bytes).
 * This is the "PaperMC-side" verification, deliberately reimplemented in the
 * test rather than reusing buildForwardingResponse internals.
 */
function verifyForwardingResponse (secret, response) {
  if (!Buffer.isBuffer(response) || response.length < 32) return false
  const signature = response.subarray(0, 32)
  const payload = response.subarray(32)
  const expected = crypto
    .createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(payload)
    .digest()
  return signature.equals(expected)
}

describe('Velocity Modern Forwarding HMAC (Property 4)', function () {
  this.timeout(30000)

  it('signature equals HMAC-SHA256(utf8(secret), payload) for any valid input', function () {
    fc.assert(
      fc.property(
        secretArb,
        versionArb,
        addressArb,
        uuidArb,
        usernameArb,
        propertiesArb,
        (secret, version, address, uuid, username, properties) => {
          const response = buildForwardingResponse({
            secret,
            version,
            address,
            uuid,
            username,
            properties
          })

          assert.ok(Buffer.isBuffer(response), 'response must be a Buffer')
          assert.ok(response.length >= 32, 'response must be at least 32 bytes')

          // Self-verification: the prepended signature must authenticate the tail.
          const signature = response.subarray(0, 32)
          const payload = response.subarray(32)
          const expectedSig = crypto
            .createHmac('sha256', Buffer.from(secret, 'utf8'))
            .update(payload)
            .digest()
          assert.ok(
            signature.equals(expectedSig),
            'signature must equal HMAC-SHA256(utf8(secret), payload)'
          )
          assert.ok(
            verifyForwardingResponse(secret, response),
            'independent verifier must accept the response'
          )
        }
      ),
      { numRuns: 200 }
    )
  })

  it('bit-flipping any single byte in the response makes verification fail', function () {
    fc.assert(
      fc.property(
        secretArb,
        versionArb,
        addressArb,
        uuidArb,
        usernameArb,
        propertiesArb,
        // index of the byte to flip — drawn separately so fast-check can shrink it
        fc.integer({ min: 0, max: 4096 }),
        (secret, version, address, uuid, username, properties, flipIdx) => {
          const response = buildForwardingResponse({
            secret,
            version,
            address,
            uuid,
            username,
            properties
          })

          // Sanity: the unmodified response must verify.
          assert.ok(verifyForwardingResponse(secret, response))

          // Project flipIdx into the response's actual byte range.
          const idx = flipIdx % response.length
          const tampered = Buffer.from(response)
          tampered[idx] = tampered[idx] ^ 0xff // flip all 8 bits at this offset

          assert.strictEqual(
            verifyForwardingResponse(secret, tampered),
            false,
            'flipping byte at idx ' + idx + ' must invalidate the signature'
          )
        }
      ),
      { numRuns: 200 }
    )
  })

  it('version outside [1, 4] throws VELOCITY_VERSION_OUT_OF_RANGE', function () {
    fc.assert(
      fc.property(
        secretArb,
        // pull versions strictly outside [1, 4]
        fc.oneof(
          fc.integer({ min: -1000, max: 0 }),
          fc.integer({ min: 5, max: 1000 })
        ),
        usernameArb,
        (secret, badVersion, username) => {
          let thrown = null
          try {
            buildForwardingResponse({
              secret,
              version: badVersion,
              username
            })
          } catch (err) {
            thrown = err
          }
          assert.ok(thrown, 'expected throw for version=' + badVersion)
          assert.strictEqual(thrown.code, 'VELOCITY_VERSION_OUT_OF_RANGE')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('version defaults to 1 when undefined (response equals explicit version=1)', function () {
    fc.assert(
      fc.property(
        secretArb,
        addressArb,
        uuidArb,
        usernameArb,
        propertiesArb,
        (secret, address, uuid, username, properties) => {
          const responseDefault = buildForwardingResponse({
            secret,
            // version intentionally omitted
            address,
            uuid,
            username,
            properties
          })
          const responseExplicit = buildForwardingResponse({
            secret,
            version: 1,
            address,
            uuid,
            username,
            properties
          })
          assert.ok(
            responseDefault.equals(responseExplicit),
            'omitting version must produce the same bytes as version=1'
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  it('uuid missing falls back to deriveOfflineUuid(username)', function () {
    fc.assert(
      fc.property(secretArb, usernameArb, (secret, username) => {
        const responseNoUuid = buildForwardingResponse({
          secret,
          username
        })
        const responseExplicit = buildForwardingResponse({
          secret,
          username,
          uuid: deriveOfflineUuid(username)
        })
        assert.ok(
          responseNoUuid.equals(responseExplicit),
          'omitting uuid must produce the same bytes as passing the offline UUID'
        )
      }),
      { numRuns: 100 }
    )
  })
})
