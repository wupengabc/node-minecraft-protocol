/* eslint-env mocha */
const assert = require('assert')
const { createSerializer, createDeserializer } = require('../src/transforms/serializer')
const native = require('../src/datatypes/minecraft')
const [readVarInt] = require('protodef').types.varint

function vint (number) {
  let value = BigInt.asUintN(64, BigInt(number))
  const bytes = []
  do {
    const byte = Number(value & 127n)
    value >>= 7n
    bytes.push(byte | (value ? 128 : 0))
  } while (value)
  return Buffer.from(bytes)
}

function numbers (type, values) {
  const size = type === 'Double' ? 8 : 4
  const bytes = Buffer.alloc(size * values.length)
  values.forEach((value, index) => bytes[`write${type}BE`](value, index * size))
  return bytes
}

function string (value) {
  const bytes = Buffer.from(value)
  return Buffer.concat([vint(bytes.length), bytes])
}

for (const version of ['26.2', '26.3']) {
  describe(`vanilla field layouts ${version}`, function () {
    function codec (name, isServer = false, state = 'play') {
      const schema = require('minecraft-data')(version).protocol[state][isServer ? 'toClient' : 'toServer'].types.packet[1][0].type[1].mappings
      const id = Number(Object.entries(schema).find(([, value]) => value === name)[0])
      return {
        id,
        encode: params => createSerializer({ version, state, isServer }).createPacketBuffer({ name, params }),
        decode: payload => {
          const frame = Buffer.concat([vint(id), payload])
          const parsed = createDeserializer({ version, state, isServer: !isServer }).parsePacketBuffer(frame)
          assert.strictEqual(parsed.metadata.size, frame.length)
          return parsed.data.params
        }
      }
    }

    it('uses a VarInt container button, including IDs beyond signed byte range', function () {
      const c = codec('enchant_item')
      const bytes = Buffer.concat([vint(c.id), vint(2), vint(300)])
      assert.deepStrictEqual(c.encode({ windowId: 2, enchantment: 300 }), bytes)
    })

    it('encodes optional spectator IDs with zero sentinel and offset, without a boolean', function () {
      const c = codec('spectate')
      for (const id of [undefined, 0, 127, 300]) {
        assert.deepStrictEqual(c.encode({ spectateEntityId: id }), Buffer.concat([vint(c.id), vint(id === undefined ? 0 : id + 1)]))
        assert.strictEqual(c.decode(vint(id === undefined ? 0 : id + 1)).spectateEntityId, id)
      }
    })

    it('reads complete position, velocity, float rotations and relative flags for entity teleport', function () {
      const c = codec('entity_teleport', true)
      const result = c.decode(Buffer.concat([vint(42), numbers('Double', [1, 2, 3, 0.5, -1, 2]), numbers('Float', [75, -20]), numbers('Int32', [0x105]), Buffer.from([1])]))
      assert.deepStrictEqual(result, { entityId: 42, x: 1, y: 2, z: 3, dx: 0.5, dy: -1, dz: 2, yaw: 75, pitch: -20, flags: 0x105, onGround: true })
    })

    it('decodes independent player-info order and hat bits', function () {
      const c = codec('player_info', true)
      const uuid = Buffer.alloc(16)
      const order = c.decode(Buffer.concat([Buffer.from([0x40, 1]), uuid, vint(300)]))
      assert.strictEqual(order.action.update_list_order, true)
      assert.strictEqual(order.data[0].listPriority, 300)
      const hat = c.decode(Buffer.concat([Buffer.from([0x80, 1]), uuid, Buffer.from([1])]))
      assert.strictEqual(hat.action.update_hat, true)
      assert.strictEqual(hat.data[0].showHat, true)
    })

    it('uses doubles and packed rotation bytes in minecart interpolation steps', function () {
      const c = codec('move_minecart', true)
      const result = c.decode(Buffer.concat([vint(42), vint(1), numbers('Double', [1, 2, 3, 0.5, 0, -0.5]), Buffer.from([64, 224]), numbers('Float', [1])]))
      assert.deepStrictEqual(result.steps[0], { position: { x: 1, y: 2, z: 3 }, velocity: { x: 0.5, y: 0, z: -0.5 }, yaw: 64, pitch: -32, weight: 1 })
    })

    it('pins all attribute and particle mapper IDs to the per-version registries', function () {
      const data = require('minecraft-data')(version)
      const schema = data.protocol
      const attributes = schema.play.toClient.types.packet_entity_update_attributes[1][1].type[1].type[1][0].type[1].mappings
      assert.strictEqual(attributes[0], 'air_drag_modifier')
      assert.strictEqual(attributes[26], 'generic.movement_speed')
      assert.strictEqual(Object.keys(attributes).length, 40)
      const particles = schema.types.Particle[1][0].type[1].mappings
      assert.deepStrictEqual(Object.entries(particles).map(([id, name]) => ({ id: Number(id), name })), data.particlesArray)
    })

    it('decodes vanilla particle payloads without truncating following fields', function () {
      const data = require('minecraft-data')(version)
      const proto = createSerializer({ version, state: 'play', isServer: true }).proto
      const fixtures = [
        ['dust', Buffer.concat([numbers('Int32', [0xabcdef]), numbers('Float', [1])]), { color: 0xabcdef, scale: 1 }],
        ['dust_color_transition', Buffer.concat([numbers('Int32', [1, 2]), numbers('Float', [1])]), { fromColor: 1, toColor: 2, scale: 1 }],
        ['trail', Buffer.concat([numbers('Double', [1, 2, 3]), numbers('Int32', [0xabcdef]), vint(300)]), { target: { x: 1, y: 2, z: 3 }, color: 0xabcdef, duration: 300 }],
        ['geyser', numbers('Int32', [6]), { waterBlocks: 6 }],
        ['geyser_base', Buffer.concat([numbers('Int32', [6]), numbers('Float', [2])]), { waterBlocks: 6, burstImpulseBase: 2 }]
      ]
      for (const [name, payload, expected] of fixtures) {
        const frame = Buffer.concat([vint(data.particlesByName[name].id), payload])
        const parsed = proto.parsePacketBuffer('Particle', frame)
        assert.strictEqual(parsed.metadata.size, frame.length)
        assert.deepStrictEqual(parsed.data, { type: name, data: expected })
      }
    })

    it('uses every structure flag bit and a full-width seed', function () {
      const c = codec('update_structure_block')
      const params = { location: { x: 0, y: 0, z: 0 }, action: 0, mode: 0, name: '', offset_x: 0, offset_y: 0, offset_z: 0, size_x: 1, size_y: 1, size_z: 1, mirror: 0, rotation: 0, metadata: '', integrity: 1, seed: 9223372036854775807n, flags: { ignore_entities: true, show_air: true, show_bounding_box: true, strict: true } }
      const encoded = c.encode(params)
      assert.deepStrictEqual(encoded.subarray(-10), Buffer.concat([vint(params.seed), Buffer.from([15])]))
      const result = c.decode(encoded.subarray(vint(c.id).length))
      assert.strictEqual(result.seed, params.seed)
      assert.strictEqual(result.flags._value, 15)
    })

    it('preserves versioned spawn-info previous gamemode sentinels', function () {
      const proto = createSerializer({ version, state: 'play', isServer: true }).proto
      for (const previous of [undefined, 0, 3]) {
        const frame = Buffer.concat([
          vint(0), string('minecraft:overworld'), Buffer.alloc(8),
          Buffer.from([1, version === '26.3' ? previous == null ? 0 : previous + 1 : previous == null ? 255 : previous]),
          Buffer.from([0, 1, 0]), vint(300), vint(63)
        ])
        const parsed = proto.parsePacketBuffer('SpawnInfo', frame)
        assert.strictEqual(parsed.metadata.size, frame.length)
        assert.strictEqual(parsed.data.gamemode, 'creative')
        assert.strictEqual(parsed.data.previousGamemode, previous ?? (version === '26.3' ? undefined : -1))
        assert.strictEqual(parsed.data.portalCooldown, 300)
        assert.strictEqual(parsed.data.seaLevel, 63)
      }
    })

    it('decodes the complete versioned particle packet with a large count', function () {
      const c = codec('world_particles', true)
      const data = require('minecraft-data')(version)
      const particle = Buffer.concat([vint(data.particlesByName.dust.id), numbers('Int32', [0xabcdef]), numbers('Float', [1])])
      const common = Buffer.concat([Buffer.from([1, 0]), numbers('Double', [1, 2, 3])])
      const payload = version === '26.3'
        ? Buffer.concat([particle, common, numbers('Float', [1, 2, 3, 4, 5, 6]), vint(300), vint(2)])
        : Buffer.concat([common, numbers('Float', [1, 2, 3, 4]), numbers('Int32', [300]), particle])
      const parsed = c.decode(payload)
      assert.strictEqual(parsed.amount, 300)
      assert.deepStrictEqual(parsed.particle, { type: 'dust', data: { color: 0xabcdef, scale: 1 } })
      if (version === '26.3') assert.strictEqual(parsed.randomizationType, 'alternative_with_speed')
    })

    it('decodes advancement template icons and versioned display positions', function () {
      const c = codec('advancements', true)
      const display = Buffer.concat([
        Buffer.from('0800017408000164', 'hex'), // Trusted title/description NBT strings.
        vint(300), vint(2), vint(0), vint(0), // ItemStackTemplate itemId,count,patch.
        vint(0), numbers('Int32', [3]), string('minecraft:background'),
        ...(version === '26.2' ? [numbers('Float', [1, 2])] : [])
      ])
      const payload = Buffer.concat([
        Buffer.from([1, 1]), string('minecraft:a'), Buffer.from([0, 1]), display,
        vint(0), Buffer.from([0]), ...(version === '26.3' ? [numbers('Float', [1, 2])] : []),
        vint(0), vint(0), Buffer.from([1])
      ])
      const parsed = c.decode(payload)
      const entry = parsed.advancementMapping[0].value
      assert.strictEqual(entry.displayData.icon.itemId, 300)
      assert.strictEqual(entry.displayData.icon.itemCount, 2)
      assert.strictEqual(version === '26.3' ? entry.x : entry.displayData.xCord, 1)
      assert.strictEqual(version === '26.3' ? entry.y : entry.displayData.yCord, 2)
    })

    for (const state of ['configuration', 'play']) {
      it(`${state}: length-prefixes click NBT and uses TAG_END for absence`, function () {
        const c = codec('custom_click_action', false, state)
        assert.deepStrictEqual(c.encode({ id: 'x', nbt: undefined }), Buffer.concat([vint(c.id), Buffer.from([1, 120, 1, 0])]))
        const tag = { type: 'compound', value: { n: { type: 'int', value: 42 } } }
        const encoded = c.encode({ id: 'x', nbt: tag })
        const offset = vint(c.id).length + 2
        const size = readVarInt(encoded, offset)
        assert.strictEqual(size.value, 10)
        assert.strictEqual(encoded[offset + size.size], 10)
        assert.deepStrictEqual(c.decode(encoded.subarray(vint(c.id).length)).nbt, tag)
      })
    }
  })
}

describe('vanilla signed 64-bit VarLong', function () {
  for (const value of [0, 127, 128, 2 ** 40, -1, 9223372036854775807n, -9223372036854775808n]) {
    it(`preserves ${value}`, function () {
      const bytes = vint(value)
      const output = Buffer.alloc(native.varlong[2](value))
      assert.strictEqual(native.varlong[1](value, output, 0), bytes.length)
      assert.deepStrictEqual(output, bytes)
      const decoded = native.varlong[0](bytes, 0)
      assert.strictEqual(BigInt(decoded.value), BigInt(value))
      assert.strictEqual(decoded.size, bytes.length)
    })
  }
})
