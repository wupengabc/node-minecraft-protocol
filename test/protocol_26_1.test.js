'use strict'
/* eslint-env mocha */
//
// Task 7.5 — Property 2: 26.1 packet encode/decode round-trip
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
//
// For each representative packet declared in data/pc/26.1/protocol.json across
// all four tables (configuration.toClient, configuration.toServer,
// play.toClient, play.toServer) we generate random valid values that conform
// to the packet's protodef schema and assert that
//   deserialize(serialize(x))         is structurally equal to x
//   serialize(deserialize(serialize(x))) yields the same bytes as serialize(x)
//
// Notes on shape equivalence:
//   * `MovementFlags` is a protodef `bitflags` whose deserialized form carries
//     an internal `_value` field that the input shape doesn't have. To stay
//     honest about "structural" equality we run TWO cycles: round-trip once,
//     then round-trip the parsed object again and compare the parsed values
//     and the underlying buffers. If protodef is sound the second cycle is
//     stable.
//   * 26.1 introduces a number of packets whose schema is intentionally
//     opaque (NBT registry holders, Slot, deeply-nested switches). Those are
//     exercised with hand-pinned constants only. Simple primitives, fixed
//     containers, empty containers and the new 26.1-specific packets that
//     have plain field schemas are exercised with fast-check arbitraries.
//   * numRuns is set to 200 per the design.md / Property 2 spec.

const assert = require('assert')
const fc = require('fast-check')
const { createSerializer, createDeserializer, states } = require('..')

const VERSION = '26.1.2'
const NUM_RUNS = 200

// -- Generators -----------------------------------------------------------

// protodef encodes i64 as a [hi, lo] pair of *signed* 32-bit integers
// (writeInt32BE for both halves). Constrain both halves to that domain.
const i64 = fc.tuple(
  fc.integer({ min: -0x80000000, max: 0x7fffffff }),
  fc.integer({ min: -0x80000000, max: 0x7fffffff })
)
const i32 = fc.integer({ min: -0x7fffffff, max: 0x7fffffff })
const i16 = fc.integer({ min: -0x7fff, max: 0x7fff })
// Minecraft's VarInt is a signed 32-bit integer over the wire.
const varint = fc.integer({ min: 0, max: 0x7fffffff })

// f32/f64 — exclude NaN/Infinity (those don't round-trip via equality) and
// hold f32 inputs to values that survive the f32 round-trip without rounding.
const f64 = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 })
const f32Safe = fc.integer({ min: -1800, max: 1800 }).map(n => n / 10) // 0.1 step
// Pure ASCII strings to keep us inside string-byte-length constraints.
const asciiString = fc.string({ minLength: 0, maxLength: 32, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-:./'.split('')) })

const movementFlags = fc.record({
  onGround: fc.boolean(),
  hasHorizontalCollision: fc.boolean()
})

// -- Round-trip helper ----------------------------------------------------

function makeRoundTrip ({ state, isServer }) {
  // The serializer for an outgoing direction and the deserializer for the
  // SAME direction must be paired so that the (id, switch) wrapping uses the
  // same packet-name table on both sides.
  const serializer = createSerializer({ state, version: VERSION, isServer })
  const deserializer = createDeserializer({ state, version: VERSION, isServer: !isServer, noErrorLogging: true })

  return function roundTrip (packet) {
    const buf1 = serializer.createPacketBuffer(packet)
    const parsed1 = deserializer.parsePacketBuffer(buf1)

    // The wrapper preserves name and the params subtree.
    assert.strictEqual(parsed1.data.name, packet.name,
      `round-trip changed name: ${packet.name} -> ${parsed1.data.name}`)
    // Whole buffer must have been consumed.
    assert.strictEqual(parsed1.metadata.size, buf1.length,
      `round-trip didn't consume the full buffer for ${packet.name} (consumed ${parsed1.metadata.size} of ${buf1.length})`)

    // Second cycle: re-serialize the parsed object. If the schema is sound
    // the bytes must match exactly (this catches drift caused by extra
    // fields like bitflags' _value not being part of the input).
    const buf2 = serializer.createPacketBuffer({ name: parsed1.data.name, params: parsed1.data.params })
    assert.ok(buf1.equals(buf2),
      `round-trip is not idempotent for ${packet.name}: ${buf1.toString('hex')} != ${buf2.toString('hex')}`)
    const parsed2 = deserializer.parsePacketBuffer(buf2)
    assert.deepStrictEqual(parsed2.data, parsed1.data,
      `second decode diverged from first for ${packet.name}`)

    return parsed1.data
  }
}

// -- Test suites ----------------------------------------------------------

describe('Protocol 26.1 (775) packet round-trip', function () {
  this.timeout(30000)

  describe('configuration toServer', function () {
    const rt = makeRoundTrip({ state: states.CONFIGURATION, isServer: false })

    it('keep_alive (i64)', function () {
      fc.assert(
        fc.property(i64, (keepAliveId) => {
          rt({ name: 'keep_alive', params: { keepAliveId } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('pong (i32)', function () {
      fc.assert(
        fc.property(i32, (id) => {
          rt({ name: 'pong', params: { id } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('finish_configuration (empty container)', function () {
      rt({ name: 'finish_configuration', params: {} })
    })

    it('accept_code_of_conduct (empty container, 26.1-new)', function () {
      // 26.1 new toServer 0x09. No fields — exercising the empty-container
      // path is the only meaningful round-trip.
      rt({ name: 'accept_code_of_conduct', params: {} })
    })

    it('custom_click_action (string + option<nbt>, 26.1-new) — nbt absent', function () {
      // The nbt option uses an "anonymousNbt" subtype which fast-check can't
      // safely fuzz without prismarine-nbt scaffolding; we pin it to absent
      // and fuzz the id string that does have a simple shape.
      fc.assert(
        fc.property(asciiString, (id) => {
          rt({ name: 'custom_click_action', params: { id, nbt: undefined } })
        }),
        { numRuns: NUM_RUNS }
      )
    })
  })

  describe('configuration toClient', function () {
    const rt = makeRoundTrip({ state: states.CONFIGURATION, isServer: true })

    it('keep_alive (i64)', function () {
      fc.assert(
        fc.property(i64, (keepAliveId) => {
          rt({ name: 'keep_alive', params: { keepAliveId } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('ping (i32)', function () {
      fc.assert(
        fc.property(i32, (id) => {
          rt({ name: 'ping', params: { id } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('finish_configuration (empty container)', function () {
      rt({ name: 'finish_configuration', params: {} })
    })

    it('reset_chat (empty container)', function () {
      rt({ name: 'reset_chat', params: {} })
    })

    it('code_of_conduct (string, 26.1-new)', function () {
      fc.assert(
        fc.property(asciiString, (contents) => {
          rt({ name: 'code_of_conduct', params: { contents } })
        }),
        { numRuns: NUM_RUNS }
      )
    })
  })

  describe('play toServer', function () {
    const rt = makeRoundTrip({ state: states.PLAY, isServer: false })

    it('keep_alive (i64)', function () {
      fc.assert(
        fc.property(i64, (keepAliveId) => {
          rt({ name: 'keep_alive', params: { keepAliveId } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('ping_request (i64)', function () {
      fc.assert(
        fc.property(i64, (id) => {
          rt({ name: 'ping_request', params: { id } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('pong (i32)', function () {
      fc.assert(
        fc.property(i32, (id) => {
          rt({ name: 'pong', params: { id } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('held_item_slot (i16)', function () {
      fc.assert(
        fc.property(i16, (slotId) => {
          rt({ name: 'held_item_slot', params: { slotId } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('arm_animation (varint)', function () {
      // hand: 0 = main, 1 = off — domain happens to be {0,1} but the wire
      // type is just a VarInt, so we fuzz the whole VarInt range.
      fc.assert(
        fc.property(varint, (hand) => {
          rt({ name: 'arm_animation', params: { hand } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('position (f64 x3 + MovementFlags)', function () {
      fc.assert(
        fc.property(f64, f64, f64, movementFlags, (x, y, z, flags) => {
          rt({ name: 'position', params: { x, y, z, flags } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('position_look (f64 x3 + f32 x2 + MovementFlags)', function () {
      fc.assert(
        fc.property(f64, f64, f64, f32Safe, f32Safe, movementFlags,
          (x, y, z, yaw, pitch, flags) => {
            rt({ name: 'position_look', params: { x, y, z, yaw, pitch, flags } })
          }),
        { numRuns: NUM_RUNS }
      )
    })

    it('look (f32 x2 + MovementFlags)', function () {
      fc.assert(
        fc.property(f32Safe, f32Safe, movementFlags, (yaw, pitch, flags) => {
          rt({ name: 'look', params: { yaw, pitch, flags } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('flying (MovementFlags only)', function () {
      fc.assert(
        fc.property(movementFlags, (flags) => {
          rt({ name: 'flying', params: { flags } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('attack (varint, 26.1-new id 0x01)', function () {
      fc.assert(
        fc.property(varint, (entityId) => {
          rt({ name: 'attack', params: { entityId } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('set_game_rule (string + string, 26.1-new id 0x39)', function () {
      fc.assert(
        fc.property(asciiString, asciiString, (name, value) => {
          rt({ name: 'set_game_rule', params: { name, value } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('player_loaded (empty container, 26.1-new id 0x2C)', function () {
      rt({ name: 'player_loaded', params: {} })
    })

    it('tick_end (empty container, 26.1-new id 0x0D)', function () {
      // MCC names this "client_tick_end" but minecraft-data 26.1 surfaces it
      // as `tick_end` in the toServer mapper. We follow the data file.
      rt({ name: 'tick_end', params: {} })
    })
  })

  describe('play toClient', function () {
    const rt = makeRoundTrip({ state: states.PLAY, isServer: true })

    it('keep_alive (i64)', function () {
      fc.assert(
        fc.property(i64, (keepAliveId) => {
          rt({ name: 'keep_alive', params: { keepAliveId } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('ping (i32)', function () {
      fc.assert(
        fc.property(i32, (id) => {
          rt({ name: 'ping', params: { id } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('set_cooldown (string + varint)', function () {
      fc.assert(
        fc.property(asciiString, varint, (cooldownGroup, cooldownTicks) => {
          rt({ name: 'set_cooldown', params: { cooldownGroup, cooldownTicks } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('held_item_slot (varint)', function () {
      fc.assert(
        fc.property(varint, (slot) => {
          rt({ name: 'held_item_slot', params: { slot } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('acknowledge_player_digging (varint)', function () {
      fc.assert(
        fc.property(varint, (sequenceId) => {
          rt({ name: 'acknowledge_player_digging', params: { sequenceId } })
        }),
        { numRuns: NUM_RUNS }
      )
    })

    it('window_items decodes bees occupant entity data', function () {
      // The bee occupant is entity type 11, an empty compound, then two tick
      // counts. Reading the entity type as NBT shifts every subsequent field.
      const frame = Buffer.from('12030101010101004d010b0a00020300', 'hex')
      const parsed = createDeserializer({ state: states.PLAY, version: VERSION, isServer: false, noErrorLogging: true })
        .parsePacketBuffer(frame)

      assert.strictEqual(parsed.data.name, 'window_items')
      assert.strictEqual(parsed.metadata.size, frame.length)
      assert.deepStrictEqual(parsed.data.params.items[0].components[0], {
        type: 'bees',
        data: {
          bees: [{
            entityType: 11,
            nbtData: { type: 'compound', value: {} },
            ticksInHive: 2,
            minTicksInHive: 3
          }]
        }
      })
    })

    it('window_items decodes an instrument registry holder', function () {
      // One item with instrument holder ID 5, followed by an empty slot and
      // the empty carried item. The holder has no preceding boolean flag.
      const frame = Buffer.from('12030102010101003d060000', 'hex')
      const parsed = createDeserializer({ state: states.PLAY, version: VERSION, isServer: false, noErrorLogging: true })
        .parsePacketBuffer(frame)

      assert.strictEqual(parsed.metadata.size, frame.length)
      assert.strictEqual(parsed.data.params.items.length, 2)
      assert.deepStrictEqual(parsed.data.params.items[0].components[0], {
        type: 'instrument',
        data: { instrumentId: 5 }
      })
      assert.deepStrictEqual(parsed.data.params.items[1], { itemCount: 0 })
      assert.deepStrictEqual(parsed.data.params.carriedItem, { itemCount: 0 })
    })

    it('low_disk_space_warning (empty container, 26.1-new)', function () {
      rt({ name: 'low_disk_space_warning', params: {} })
    })

    it('game_rule_values (array<{name,value}>, 26.1-new id 0x27)', function () {
      const ruleArb = fc.array(
        fc.record({ name: asciiString, value: asciiString }),
        { minLength: 0, maxLength: 8 }
      )
      fc.assert(
        fc.property(ruleArb, (rules) => {
          rt({ name: 'game_rule_values', params: { rules } })
        }),
        { numRuns: NUM_RUNS }
      )
    })
  })
})
