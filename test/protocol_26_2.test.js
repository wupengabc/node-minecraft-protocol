'use strict'
/* eslint-env mocha */

const assert = require('assert')
const Client = require('../src/client')
const states = require('../src/states')
const minecraftData = require('minecraft-data')
const protocol = require('../')
const [, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const tagWith261 = require('../src/utils/tagWith261')

describe('protocol 26.2 (776)', function () {
  it('resolves and compiles protocol 776', function (done) {
    const data = minecraftData('26.2')
    assert.ok(data)
    assert.strictEqual(data.version.version, 776)
    assert.ok(protocol.supportedVersions.includes('26.2'))

    const client = new Client(false, '26.2', undefined, true)
    client.state = states.PLAY
    client.once('error', done)
    client.once('rawPacket', (packet) => {
      assert.strictEqual(packet.protocolVersion, 776)
      assert.strictEqual(packet.packetId, 0xff)
      done()
    })

    const packetId = 0xff
    const buffer = Buffer.alloc(sizeOfVarInt(packetId))
    writeVarInt(packetId, buffer, 0)
    client.deserializer.write(buffer)
  })

  it('tags 26.2 diagnostics with protocol 776', function () {
    const error = tagWith261(new Error('missing protocol'), 776)
    assert.strictEqual(error.protocolVersion, 776)
  })

  it('uses the official 26.2 Play packet IDs', function () {
    const data = minecraftData('26.2').protocol.play
    const clientbound = data.toClient.types.packet[1][0].type[1].mappings
    const serverbound = data.toServer.types.packet[1][0].type[1].mappings
    const slotDisplay = data.toClient.types.SlotDisplay[1][0].type[1].mappings
    const updateTime = data.toClient.types.packet_update_time[1]

    assert.strictEqual(Object.keys(clientbound).length, 141)
    assert.strictEqual(clientbound['0x27'], 'game_rule_values')
    assert.strictEqual(clientbound['0x31'], 'login')
    assert.strictEqual(clientbound['0x32'], 'low_disk_space_warning')
    assert.strictEqual(clientbound['0x8c'], 'show_dialog')

    assert.strictEqual(Object.keys(serverbound).length, 69)
    assert.strictEqual(serverbound['0x01'], 'attack')
    assert.strictEqual(serverbound['0x15'], 'cookie_response')
    assert.strictEqual(serverbound['0x16'], 'custom_payload')
    assert.strictEqual(serverbound['0x39'], 'set_game_rule')
    assert.strictEqual(serverbound['0x3e'], 'spectate')
    assert.strictEqual(serverbound['0x3f'], 'arm_animation')
    assert.strictEqual(serverbound['0x40'], 'teleport_to_entity')
    assert.strictEqual(serverbound['0x44'], 'custom_click_action')

    assert.deepStrictEqual(slotDisplay, {
      0: 'empty',
      1: 'any_fuel',
      2: 'with_any_potion',
      3: 'only_with_component',
      4: 'item',
      5: 'item_stack',
      6: 'tag',
      7: 'dyed',
      8: 'smithing_trim',
      9: 'with_remainder',
      10: 'composite'
    })
    assert.strictEqual(updateTime[0].name, 'gameTime')
    assert.strictEqual(updateTime[1].name, 'clockUpdates')

    const metadataTypes = minecraftData('26.2').protocol.types.entityMetadataEntry[1][1].type[1].mappings
    assert.strictEqual(Object.keys(metadataTypes).length, 43)
    assert.strictEqual(metadataTypes['29'], 'pig_sound_variant')
    assert.strictEqual(metadataTypes['33'], 'optional_global_pos')
    assert.strictEqual(metadataTypes['42'], 'humanoid_arm')
  })

  it('decodes captured 26.2 pig sound metadata', function () {
    const client = new Client(false, '26.2', undefined, true)
    client.state = states.PLAY

    const parsed = client.deserializer.parsePacketBuffer(
      Buffer.from('63c140090341200000141d02ff', 'hex')
    )

    assert.strictEqual(parsed.data.name, 'entity_metadata')
    assert.deepStrictEqual(parsed.data.params.metadata[1], {
      key: 20,
      type: 'pig_sound_variant',
      value: 2
    })
  })

  it('loads the generated 26.2 static registries and collision shapes', function () {
    const data = minecraftData('26.2')

    assert.strictEqual(data.blocksArray.length, 1196)
    assert.strictEqual(data.itemsArray.length, 1537)
    assert.strictEqual(data.blocksByName.sulfur.id, 998)
    assert.strictEqual(data.blocksByStateId[24687].name, 'sulfur')
    assert.strictEqual(data.blocksByStateId[30234].name, 'sulfur_spike')
    assert.strictEqual(data.itemsByName.sulfur_cube_bucket.id, 1052)
    assert.strictEqual(data.itemsByName.music_disc_bounce.id, 1342)
    assert.ok(Object.prototype.hasOwnProperty.call(data.blockCollisionShapes.blocks, 'sulfur_spike'))
  })
})
