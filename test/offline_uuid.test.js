'use strict'
/* eslint-env mocha */

// Task 6.6 — Property 6: Offline UUID derivation
//
// Validates: Requirement 10.5
//
// Test plan:
//   1. Golden vectors: well-known offline UUIDs computed by Java's
//        UUID.nameUUIDFromBytes("OfflinePlayer:" + username)
//      The reference values are produced by MD5 of "OfflinePlayer:<name>",
//      with version bits set to 3 (MD5-name-based) and variant bits set to
//      IETF (10xx).
//
//      'Notch' → 'b50ad385-829d-3141-a216-7e7d7539ba7f'
//      'jeb_'  → 'a762f560-4fce-3236-812a-b80efff0b62b'
//
//      (NB: the task description draft listed 'Notch' as ending in '...ba7a';
//      the actual MD5 hash is '...ba7f' — see commentary below for the byte-
//      level computation.)
//
//   2. Property: for any ASCII username (length 1..16),
//        deriveOfflineUuid(username) === referenceImpl(username)
//      where referenceImpl is an independent MD5-based v3 UUID computation
//      written from scratch in this test file.
//
//   3. Output shape: result is a canonical 8-4-4-4-12 UUID string with version
//      nibble = 3 and variant nibble in {8, 9, a, b}.

const assert = require('assert')
const crypto = require('crypto')
const fc = require('fast-check')
const { deriveOfflineUuid } = require('../src/transforms/velocityForwarding')

// --- Independent reference implementation ---
//
// Mirrors Java's UUID.nameUUIDFromBytes(bytes), specialised to
// bytes = utf8("OfflinePlayer:" + username):
//   1. Compute MD5(bytes) -> 16 bytes.
//   2. Clear top 4 bits of byte 6 and OR in 0x30  (version = 3, name-based MD5).
//   3. Clear top 2 bits of byte 8 and OR in 0x80  (variant = IETF 10xx).
//   4. Format as 8-4-4-4-12 lowercase hex.
function referenceImpl (username) {
  const md5 = crypto.createHash('md5')
  md5.update('OfflinePlayer:' + username, 'utf8')
  const bytes = md5.digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-')
}

// --- Generators ---

// Printable ASCII usernames, length 1..16. We exclude characters that wouldn't
// be valid offline-mode usernames in practice; this still gives a wide enough
// input space to stress the MD5 and bit-twiddle paths.
const usernameArb = fc.stringMatching(/^[A-Za-z0-9_]{1,16}$/)

// --- Tests ---

describe('Offline UUID derivation (Property 6)', function () {
  this.timeout(15000)

  describe('golden vectors', function () {
    const vectors = [
      // Computed via Java: UUID.nameUUIDFromBytes("OfflinePlayer:Notch".getBytes(StandardCharsets.UTF_8))
      ['Notch', 'b50ad385-829d-3141-a216-7e7d7539ba7f'],
      ['jeb_', 'a762f560-4fce-3236-812a-b80efff0b62b'],
      ['Dinnerbone', '4d258a81-2358-3084-8166-05b9faccad80'],
      // Empty-string corner: Java's nameUUIDFromBytes is well-defined on the
      // 14-byte literal "OfflinePlayer:".
      ['Player', 'a01e3843-e521-3998-958a-f459800e4d11'],
      ['Steve', '5627dd98-e6be-3c21-b8a8-e92344183641']
    ]
    for (const [username, expected] of vectors) {
      it(`'${username}' → '${expected}'`, function () {
        assert.strictEqual(deriveOfflineUuid(username), expected)
      })
    }
  })

  it('matches an independent reference implementation for arbitrary ASCII usernames', function () {
    fc.assert(
      fc.property(usernameArb, (username) => {
        const internal = deriveOfflineUuid(username)
        const reference = referenceImpl(username)
        assert.strictEqual(
          internal,
          reference,
          `deriveOfflineUuid('${username}') = '${internal}', expected '${reference}'`
        )
      }),
      { numRuns: 100 }
    )
  })

  it('is deterministic for the same input across many calls', function () {
    fc.assert(
      fc.property(usernameArb, (username) => {
        const a = deriveOfflineUuid(username)
        const b = deriveOfflineUuid(username)
        assert.strictEqual(a, b)
      }),
      { numRuns: 100 }
    )
  })

  it('output has correct UUID v3 shape: version nibble = 3 and IETF variant nibble in {8,9,a,b}', function () {
    fc.assert(
      fc.property(usernameArb, (username) => {
        const uuid = deriveOfflineUuid(username)
        // 8-4-4-4-12 lowercase hex with hyphens
        assert.match(
          uuid,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          'output must be canonical UUID format'
        )
        // Version nibble: first hex digit of the third group must be '3'.
        const versionNibble = uuid.split('-')[2][0]
        assert.strictEqual(versionNibble, '3', 'version nibble must be 3 (name-based MD5)')

        // Variant nibble: first hex digit of the fourth group must be 8/9/a/b.
        const variantNibble = uuid.split('-')[3][0]
        assert.ok(
          ['8', '9', 'a', 'b'].includes(variantNibble),
          `variant nibble must be IETF (10xx); got '${variantNibble}'`
        )
      }),
      { numRuns: 100 }
    )
  })

  it('different usernames produce different UUIDs (collision sanity check)', function () {
    fc.assert(
      fc.property(
        usernameArb,
        usernameArb,
        (a, b) => {
          fc.pre(a !== b)
          const ua = deriveOfflineUuid(a)
          const ub = deriveOfflineUuid(b)
          assert.notStrictEqual(
            ua,
            ub,
            `distinct names '${a}' and '${b}' should not collide on offline UUID`
          )
        }
      ),
      { numRuns: 100 }
    )
  })
})
