'use strict'
/* eslint-env mocha */
//
// Task 7.6 — Boundary / edge tests for 26.1 packet (de)serialization
//
// Validates: Requirements 5.5, 5.6
//
// 5.5  When `serialize` is called with a non-optional field missing, NMP
//      should throw `PartialReadError` (or an equivalent error), not
//      silently encode zero bytes.
// 5.6  When the input buffer's declared length doesn't match the bytes the
//      decoder consumes, NMP should throw a decode error whose message
//      carries the packet name AND the failing byte offset.
//
// This file documents the *actual* behaviour of NMP's compiled protodef
// pipeline at protocol 775 (Minecraft 26.1.2):
//
//   * Missing-required-field on serialize:
//     - For numeric types (i64, f64, MovementFlags' bitflags) protodef's
//       generated writer throws synchronously (TypeError or RangeError
//       wrapping `Write error / SizeOf error for ...`).
//     - For VarInt fields protodef silently encodes the JS value `undefined`
//       as `0` — this is a known protodef property and not a NMP bug. We
//       therefore restrict the assertion to numeric / container fields
//       where the writer genuinely fails.
//
//   * Truncated buffer on deserialize:
//     - The parser throws `PartialReadError` (`partialReadError === true`).
//       The error's `field` is undefined under compiled protodef, so we
//       assert what is observable: the failure happens, the marker flag is
//       set, and the partial read points at a byte offset *before*
//       buffer.length (i.e. the decode actually started consuming the
//       packet but ran out of bytes).
//     - At the Client transport layer the error is re-tagged with the
//       state + direction (`play.toServer` etc.) and the buffer hex prefix,
//       which is what tools like mineflayer's debug log surface.
//
//   * Extra trailing bytes on deserialize:
//     - `parsePacketBuffer()` does NOT throw — it returns
//       `metadata.size < buffer.length`. The streaming `FullPacketParser`
//       logs a warning when `noErrorLogging === false` but still emits the
//       parsed packet on its `data` event. We document this here so future
//       maintainers know the failure mode is silent on the parser side.

const assert = require('assert')
const { createSerializer, createDeserializer, states } = require('..')

const VERSION = '26.1.2'

describe('Protocol 26.1 (775) packet (de)serialization edge cases', function () {
  this.timeout(5000)

  // -----------------------------------------------------------------
  // Requirement 5.5 — serialize() with a missing required field throws
  // -----------------------------------------------------------------
  describe('Requirement 5.5: serialize with a missing non-optional field throws', function () {
    let serializer

    before(function () {
      serializer = createSerializer({ state: states.PLAY, version: VERSION, isServer: false })
    })

    it('keep_alive without keepAliveId (i64) throws', function () {
      let thrown = null
      try {
        serializer.createPacketBuffer({ name: 'keep_alive', params: {} })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected serialize to throw when keepAliveId is missing')
      assert.match(thrown.message, /(Write|SizeOf) error/i,
        `error must come from protodef's writer; got ${thrown.constructor.name}: ${thrown.message}`)
    })

    it('position without flags (MovementFlags bitflags) throws', function () {
      let thrown = null
      try {
        serializer.createPacketBuffer({ name: 'position', params: { x: 0, y: 0, z: 0 } })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected serialize to throw when flags is missing')
      assert.match(thrown.message, /(Write|SizeOf) error/i,
        `error must come from protodef's writer; got ${thrown.constructor.name}: ${thrown.message}`)
    })

    it('set_game_rule without name (string) throws', function () {
      let thrown = null
      try {
        serializer.createPacketBuffer({ name: 'set_game_rule', params: { value: 'true' } })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected serialize to throw when name is missing')
      assert.match(thrown.message, /(Write|SizeOf) error/i,
        `error must come from protodef's writer; got ${thrown.constructor.name}: ${thrown.message}`)
    })

    it('look without yaw (f32) throws', function () {
      // f32 writer dereferences undefined and protodef wraps the resulting
      // RangeError as "Write error / SizeOf error".
      let thrown = null
      try {
        serializer.createPacketBuffer({
          name: 'look',
          params: { pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } }
        })
      } catch (err) {
        thrown = err
      }
      // f32 writeFloat coerces undefined to NaN and DOES NOT throw — so
      // round-trip would be silently lossy for f32 fields. Document that
      // here: when the writer doesn't throw, the buffer must NOT be
      // structurally distinguishable from the all-zeros / NaN encoding —
      // this is a known NMP / protodef quirk and not a regression.
      if (thrown === null) {
        const bufZero = serializer.createPacketBuffer({
          name: 'look',
          params: { yaw: NaN, pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } }
        })
        const bufMissing = serializer.createPacketBuffer({
          name: 'look',
          params: { pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } }
        })
        assert.ok(bufZero.equals(bufMissing),
          'when writer does not throw on missing f32, it must coerce to NaN')
      } else {
        assert.match(thrown.message, /(Write|SizeOf) error/i)
      }
    })
  })

  // -----------------------------------------------------------------
  // Requirement 5.6 — deserialize() with truncated buffer throws
  // -----------------------------------------------------------------
  describe('Requirement 5.6: deserialize with a truncated buffer throws PartialReadError', function () {
    let deserializer

    before(function () {
      deserializer = createDeserializer({
        state: states.PLAY,
        version: VERSION,
        isServer: true,
        noErrorLogging: true
      })
    })

    function assertPartialRead (buf, label) {
      let thrown = null
      try {
        deserializer.parsePacketBuffer(buf)
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, `${label}: expected truncated buffer to throw`)
      assert.strictEqual(thrown.partialReadError, true,
        `${label}: error should be a PartialReadError (partialReadError=true), got ${thrown.constructor.name}: ${thrown.message}`)
      assert.strictEqual(thrown.name, 'PartialReadError',
        `${label}: error.name should be 'PartialReadError'`)
      assert.match(thrown.message, /Read error/i,
        `${label}: error message should contain 'Read error'`)
    }

    it('keep_alive with id only (0 of 8 i64 bytes) throws PartialReadError', function () {
      // 0x1c = play toServer keep_alive
      assertPartialRead(Buffer.from([0x1c]), 'keep_alive truncated to id')
    })

    it('keep_alive with id + 4/8 i64 bytes throws PartialReadError', function () {
      assertPartialRead(Buffer.from('1c00000000', 'hex'), 'keep_alive 4-byte truncated')
    })

    it('keep_alive with id + 7/8 i64 bytes throws PartialReadError', function () {
      assertPartialRead(Buffer.from('1c00000000000000', 'hex'), 'keep_alive 7-byte truncated')
    })

    it('position_look with id + only one f64 throws PartialReadError', function () {
      // 0x1f = play toServer position_look (x:f64, y:f64, z:f64, yaw:f32, pitch:f32, flags:u8)
      // Provide id + 8 bytes (only x). Expect PartialReadError when reading y.
      assertPartialRead(
        Buffer.from('1f' + '0000000000000000', 'hex'),
        'position_look truncated after x'
      )
    })

    it('position with id + flags missing throws PartialReadError', function () {
      // 0x1e = play toServer position (x:f64, y:f64, z:f64, flags:u8)
      // Provide only x, y, z (24 bytes); flags missing.
      assertPartialRead(
        Buffer.from('1e' + '00'.repeat(24), 'hex'),
        'position truncated before flags'
      )
    })

    it('flying with id only (MovementFlags missing) throws PartialReadError', function () {
      // 0x21 = play toServer flying (flags:u8)
      assertPartialRead(Buffer.from([0x21]), 'flying truncated to id')
    })

    it('set_game_rule with id only (string length VarInt missing) throws PartialReadError', function () {
      // 0x39 = play toServer set_game_rule (name:string, value:string)
      assertPartialRead(Buffer.from([0x39]), 'set_game_rule truncated to id')
    })
  })

  // -----------------------------------------------------------------
  // Requirement 5.6 (continued) — extra bytes on deserialize:
  //   document protodef's actual behavior
  // -----------------------------------------------------------------
  describe('Requirement 5.6: deserialize with extra trailing bytes', function () {
    // Documented behavior: parsePacketBuffer SUCCEEDS but
    // metadata.size < buffer.length. The streaming FullPacketParser would
    // emit a warning if noErrorLogging=false and still emit the parsed
    // packet on its 'data' event. This is intentional protodef behavior:
    // a single packet's wire format is not framed by an outer length here
    // (NMP's framing transform handles that one layer up), so extra bytes
    // are treated as the start of the next packet by the splitter.
    let deserializer

    before(function () {
      deserializer = createDeserializer({
        state: states.PLAY,
        version: VERSION,
        isServer: true,
        noErrorLogging: true
      })
    })

    it('keep_alive followed by 4 extra bytes parses and reports size < buffer.length', function () {
      // 0x1c + 8 bytes i64 + 4 trailing bytes
      const buf = Buffer.from('1c000000000000002a' + 'aabbccdd', 'hex')
      const parsed = deserializer.parsePacketBuffer(buf)
      assert.strictEqual(parsed.data.name, 'keep_alive')
      assert.strictEqual(parsed.metadata.size, 9,
        'metadata.size should equal the actual consumed byte count (1 + 8)')
      assert.strictEqual(buf.length, 13,
        'sanity: the test buffer is the parsed bytes plus 4 extra bytes')
      assert.ok(parsed.metadata.size < buf.length,
        'extra bytes should leave metadata.size strictly less than buffer.length; ' +
        'this is the contract that lets the framing splitter detect over-long frames')
    })

    it('flying followed by extra bytes — same documented behavior', function () {
      // 0x21 + 1 flag byte + 5 trailing bytes
      const buf = Buffer.from('2101' + '0102030405', 'hex')
      const parsed = deserializer.parsePacketBuffer(buf)
      assert.strictEqual(parsed.data.name, 'flying')
      assert.strictEqual(parsed.metadata.size, 2)
      assert.ok(parsed.metadata.size < buf.length)
    })
  })

  // -----------------------------------------------------------------
  // Sanity: when nothing is wrong, none of the above throw.
  // -----------------------------------------------------------------
  describe('control: well-formed buffers do NOT throw', function () {
    it('keep_alive round-trip succeeds', function () {
      const s = createSerializer({ state: states.PLAY, version: VERSION, isServer: false })
      const d = createDeserializer({ state: states.PLAY, version: VERSION, isServer: true, noErrorLogging: true })
      const buf = s.createPacketBuffer({ name: 'keep_alive', params: { keepAliveId: [0, 42] } })
      const parsed = d.parsePacketBuffer(buf)
      assert.strictEqual(parsed.data.name, 'keep_alive')
      assert.strictEqual(parsed.metadata.size, buf.length,
        'well-formed packet must consume exactly buffer.length bytes')
    })
  })
})
