'use strict'
/* eslint-env mocha */

const assert = require('assert')
const Client = require('../src/client')
const states = require('../src/states')
const minecraftData = require('minecraft-data')
const protocol = require('../')
const [, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const tagWith261 = require('../src/utils/tagWith261')

// Real frames captured from an official 26.3 server (see the capture notes in
// each spec). Kept inline so the suite needs no server.
const CAPTURED_CHUNK_HEX = '2effffffff0000000003042501008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080400000000201008040125010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804000000002010080405250100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040100804020100804010080402010080401008040201008040000000020100804c411040000000404580a0900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222233333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333300290000000000000029000000000000002900000000000000290000000000000029000000000000002900000000000000290000000000000029000000000000002900000000000000290000000000000029000000000000002900000000000000290000000000000029000000000000002900000000000000290000000000000029000000000000002900000000000000290000000000000029000000000000002900000000000000290000000000000029000000000000002900010600010101070280100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8010ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00'
const CAPTURED_RECIPE_ADD_HEX = '4b01d302010202040600106d696e6563726166743a706c616e6b730600106d696e6563726166743a706c616e6b730600106d696e6563726166743a706c616e6b730600106d696e6563726166743a706c616e6b730595030100000495030003010400106d696e6563726166743a706c616e6b7300106d696e6563726166743a706c616e6b7300106d696e6563726166743a706c616e6b7300106d696e6563726166743a706c616e6b730200'

describe('protocol 26.3 (777)', function () {
  it('resolves and compiles protocol 777', function (done) {
    const data = minecraftData('26.3')
    assert.ok(data)
    assert.strictEqual(data.version.version, 777)
    assert.ok(protocol.supportedVersions.includes('26.3'))

    const client = new Client(false, '26.3', undefined, true)
    client.state = states.PLAY
    client.once('error', done)
    client.once('rawPacket', (packet) => {
      assert.strictEqual(packet.protocolVersion, 777)
      assert.strictEqual(packet.packetId, 0xff)
      done()
    })

    const packetId = 0xff
    const buffer = Buffer.alloc(sizeOfVarInt(packetId))
    writeVarInt(packetId, buffer, 0)
    client.deserializer.write(buffer)
  })

  it('tags 26.3 diagnostics with protocol 777', function () {
    const error = tagWith261(new Error('missing protocol'), 777)
    assert.strictEqual(error.protocolVersion, 777)
  })

  // The upstream pc_26_3 branch shipped 141 clientbound / 69 serverbound
  // mappings with three clientbound packets missing and `swing` still present,
  // which shifts every id from 0x25 (clientbound) and 0x2e (serverbound)
  // onward. These pins come from the official 26.3 server's packets.json
  // report and its GameProtocols addPacket() order.
  it('uses the official 26.3 Play packet IDs', function () {
    const data = minecraftData('26.3').protocol.play
    const clientbound = data.toClient.types.packet[1][0].type[1].mappings
    const serverbound = data.toServer.types.packet[1][0].type[1].mappings

    assert.strictEqual(Object.keys(clientbound).length, 144)
    assert.strictEqual(clientbound['0x25'], 'add_transient_block')
    assert.strictEqual(clientbound['0x26'], 'unload_chunk')
    assert.strictEqual(clientbound['0x32'], 'login')
    assert.strictEqual(clientbound['0x33'], 'low_disk_space_warning')
    assert.strictEqual(clientbound['0x53'], 'post_effects')
    assert.strictEqual(clientbound['0x7b'], 'swing_animation')
    assert.strictEqual(clientbound['0x8c'], 'server_links')
    assert.strictEqual(clientbound['0x8e'], 'clear_dialog')
    assert.strictEqual(clientbound['0x8f'], 'show_dialog')

    assert.strictEqual(Object.keys(serverbound).length, 69)
    assert.strictEqual(serverbound['0x01'], 'attack')
    assert.strictEqual(serverbound['0x15'], 'cookie_response')
    assert.strictEqual(serverbound['0x2c'], 'player_loaded')
    assert.strictEqual(serverbound['0x2e'], 'punch')
    assert.strictEqual(serverbound['0x3a'], 'set_game_rule')
    assert.strictEqual(serverbound['0x3f'], 'spectate')
    assert.strictEqual(serverbound['0x40'], 'teleport_to_entity')
    assert.strictEqual(serverbound['0x44'], 'custom_click_action')
  })

  it('replaces serverbound swing with the empty punch packet', function () {
    const serverboundTypes = minecraftData('26.3').protocol.play.toServer.types
    // 26.3 deleted ServerboundSwingPacket; ServerboundPunchPacket has no fields.
    assert.strictEqual(serverboundTypes.packet_arm_animation, undefined)
    assert.deepStrictEqual(serverboundTypes.packet_punch, ['container', []])

    const serializer = protocol.createSerializer({
      state: states.PLAY,
      version: '26.3',
      isServer: false
    })
    assert.strictEqual(serializer.createPacketBuffer({ name: 'punch', params: {} }).toString('hex'), '2e')
  })

  it('adds post_effects to configuration/clientbound at 0x0a', function () {
    const configCb = minecraftData('26.3').protocol.configuration.toClient
    const mappings = configCb.types.packet[1][0].type[1].mappings
    assert.strictEqual(mappings['0x0a'], 'post_effects')
    assert.strictEqual(mappings['0x08'], 'remove_resource_pack')
    assert.strictEqual(mappings['0x13'], 'show_dialog')
  })

  it('keeps sessionId on the login success packet', function () {
    const success = minecraftData('26.3').protocol.login.toClient.types.packet_success
    assert.deepStrictEqual(success[1].map(f => f.name), ['uuid', 'username', 'properties', 'sessionId'])
  })

  it('appends DYE_COLOR to the entity data serializers', function () {
    const metadataTypes = minecraftData('26.3').protocol.types.entityMetadataEntry[1][1].type[1].mappings
    assert.strictEqual(Object.keys(metadataTypes).length, 44)
    assert.strictEqual(metadataTypes['13'], 'optional_living_entity_reference')
    assert.strictEqual(metadataTypes['42'], 'humanoid_arm')
    assert.strictEqual(metadataTypes['43'], 'dye_color')
  })

  it('rebuilds the data component ids from the official registry', function () {
    const components = minecraftData('26.3').protocol.types.SlotComponentType[1].mappings
    assert.strictEqual(Object.keys(components).length, 122)
    assert.strictEqual(components['40'], 'attack_animation')
    assert.strictEqual(components['41'], 'interact_animation')
    assert.strictEqual(components['43'], 'block_transformer')
    assert.strictEqual(components['121'], 'cushion/color')
  })

  it('round-trips the new 26.3 clientbound packets', function () {
    const serializer = protocol.createSerializer({
      state: states.PLAY,
      version: '26.3',
      isServer: true
    })
    const deserializer = protocol.createDeserializer({
      state: states.PLAY,
      version: '26.3',
      isServer: false,
      noErrorLogging: true
    })

    const packet = {
      name: 'swing_animation',
      params: {
        entityId: 42,
        hand: 1,
        animation: { type: 1, duration: 7 }
      }
    }
    const buffer = serializer.createPacketBuffer(packet)
    const parsed = deserializer.parsePacketBuffer(buffer)

    assert.strictEqual(parsed.metadata.size, buffer.length)
    assert.strictEqual(parsed.data.name, 'swing_animation')
    assert.strictEqual(parsed.data.params.entityId, 42)
    assert.strictEqual(parsed.data.params.hand, 1)
    assert.strictEqual(parsed.data.params.animation.type, 1)
    assert.strictEqual(parsed.data.params.animation.duration, 7)
  })

  it('round-trips the new 26.3 add_transient_block packet', function () {
    const serializer = protocol.createSerializer({
      state: states.PLAY,
      version: '26.3',
      isServer: true
    })
    const deserializer = protocol.createDeserializer({
      state: states.PLAY,
      version: '26.3',
      isServer: false,
      noErrorLogging: true
    })

    const packet = {
      name: 'add_transient_block',
      params: { position: { x: 1, y: 64, z: -3 }, blockState: 9 }
    }
    const buffer = serializer.createPacketBuffer(packet)
    const parsed = deserializer.parsePacketBuffer(buffer)

    assert.strictEqual(parsed.metadata.size, buffer.length)
    assert.strictEqual(parsed.data.name, 'add_transient_block')
    assert.strictEqual(parsed.data.params.blockState, 9)
    assert.ok(buffer.equals(serializer.createPacketBuffer(parsed.data)))
  })

  it('loads the generated 26.3 static registries', function () {
    const data = minecraftData('26.3')
    // Official reports give 1286 blocks and 1658 items for 26.3.
    assert.strictEqual(data.blocksArray.length, 1286)
    assert.strictEqual(data.itemsArray.length, 1658)
    assert.ok(data.blockCollisionShapes)
    assert.ok(data.entitiesArray.length > 0)
    assert.strictEqual(Object.keys(data.recipes).length, 1010)
  })

  // The remaining cases pin structures that only differ deep inside a packet,
  // so each one is exercised with a real frame captured from an official 26.3
  // server (see the fixtures inline as hex).

  it('encodes the 26.3 light masks as BitSet byte arrays', function () {
    const mapChunk = minecraftData('26.3').protocol.play.toClient.types.packet_map_chunk
    for (const name of ['skyLightMask', 'blockLightMask', 'emptySkyLightMask', 'emptyBlockLightMask']) {
      const field = mapChunk[1].find(f => f.name === name)
      // 26.2 used countType varint + i64; 26.3 uses ByteArray (varint len + bytes)
      assert.strictEqual(field.type, 'ByteArray', name)
    }
    const updateLight = minecraftData('26.3').protocol.play.toClient.types.packet_update_light
    assert.strictEqual(updateLight[1].find(f => f.name === 'skyLightMask').type, 'ByteArray')
  })

  it('parses a captured 26.3 chunk packet to its exact end', function () {
    const frame = Buffer.from(CAPTURED_CHUNK_HEX, 'hex')
    const deserializer = protocol.createDeserializer({
      state: states.PLAY,
      version: '26.3',
      isServer: false,
      noErrorLogging: true
    })
    const parsed = deserializer.parsePacketBuffer(frame)
    assert.strictEqual(parsed.metadata.size, frame.length)
    assert.strictEqual(parsed.data.name, 'map_chunk')
    assert.strictEqual(parsed.data.params.skyLightMask.length, 1)
    assert.strictEqual(parsed.data.params.blockLightMask.length, 0)
    assert.strictEqual(parsed.data.params.skyLight.length, 2)
    assert.strictEqual(parsed.data.params.skyLight[0].length, 2048)
  })

  it('parses a captured 26.3 entity position sync packet', function () {
    const frame = Buffer.from('23b61b01014018154e3d1bf799c04dca3d70c000004013cd2514ae9c300243a30be80000000000', 'hex')
    const deserializer = protocol.createDeserializer({
      state: states.PLAY,
      version: '26.3',
      isServer: false,
      noErrorLogging: true
    })
    const parsed = deserializer.parsePacketBuffer(frame)
    assert.strictEqual(parsed.metadata.size, frame.length)
    assert.strictEqual(parsed.data.name, 'sync_entity_position')
    assert.strictEqual(parsed.data.params.entityId, 3510)
    assert.strictEqual(parsed.data.params.position.type, 'stepped')
    assert.strictEqual(parsed.data.params.position.path.steps.length, 1)
    assert.strictEqual(parsed.data.params.position.path.steps[0].tickOffset, 2)
  })

  it('parses a captured 26.3 recipe book add packet', function () {
    const frame = Buffer.from(CAPTURED_RECIPE_ADD_HEX, 'hex')
    const deserializer = protocol.createDeserializer({
      state: states.PLAY,
      version: '26.3',
      isServer: false,
      noErrorLogging: true
    })
    const parsed = deserializer.parsePacketBuffer(frame)
    assert.strictEqual(parsed.metadata.size, frame.length)
    assert.strictEqual(parsed.data.name, 'recipe_book_add')
    assert.strictEqual(parsed.data.params.entries.length, 1)
  })

  it('round-trips the 26.3 VecDelta linear and stepped movement forms', function () {
    const serializer = protocol.createSerializer({ state: states.PLAY, version: '26.3', isServer: true })
    const deserializer = protocol.createDeserializer({
      state: states.PLAY,
      version: '26.3',
      isServer: false,
      noErrorLogging: true
    })

    const linear = {
      name: 'rel_entity_move',
      params: { entityId: 7, delta: { onGround: true, dX: 0.25, dY: -0.5, dZ: 1.5, steps: [] } }
    }
    const lb = serializer.createPacketBuffer(linear)
    const lp = deserializer.parsePacketBuffer(lb)
    assert.strictEqual(lp.metadata.size, lb.length)
    assert.strictEqual(lp.data.params.delta.onGround, true)
    assert.strictEqual(lp.data.params.delta.dX, 0.25)
    assert.strictEqual(lp.data.params.delta.dZ, 1.5)

    const stepped = {
      name: 'rel_entity_move',
      params: {
        entityId: 9,
        delta: {
          onGround: false,
          dX: 0,
          dY: 0,
          dZ: 0,
          steps: [{ ticks: 1, x: 0.25, y: 0, z: -0.25 }, { ticks: 3, x: 0.5, y: 0.5, z: 0 }]
        }
      }
    }
    const sb = serializer.createPacketBuffer(stepped)
    const sp = deserializer.parsePacketBuffer(sb)
    assert.strictEqual(sp.metadata.size, sb.length)
    assert.strictEqual(sp.data.params.delta.steps.length, 2)
    assert.strictEqual(sp.data.params.delta.steps[1].ticks, 3)
    assert.strictEqual(sp.data.params.delta.dX, 0.5)
  })

  it('decodes a captured 26.3 entity move packet sent with VecDelta', function () {
    const frame = Buffer.from('36ea0d0103560555ffe2', 'hex')
    const deserializer = protocol.createDeserializer({
      state: states.PLAY,
      version: '26.3',
      isServer: false,
      noErrorLogging: true
    })
    const parsed = deserializer.parsePacketBuffer(frame)
    assert.strictEqual(parsed.metadata.size, frame.length)
    assert.strictEqual(parsed.data.name, 'rel_entity_move')
    assert.strictEqual(parsed.data.params.entityId, 1770)
    assert.strictEqual(parsed.data.params.delta.onGround, true)
    assert.ok(Math.abs(parsed.data.params.delta.dY - 0.333251953125) < 1e-12)
  })
})
