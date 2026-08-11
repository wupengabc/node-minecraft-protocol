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

  it('decodes and round-trips a captured 26.2 teams packet', function () {
    const raw = Buffer.from(
      '6d0467637a410008000467637a410800000800000001010f00010367637a',
      'hex'
    )
    const deserializer = protocol.createDeserializer({
      state: states.PLAY,
      version: '26.2',
      isServer: false,
      noErrorLogging: true
    })
    const serializer = protocol.createSerializer({
      state: states.PLAY,
      version: '26.2',
      isServer: true
    })
    const parsed = deserializer.parsePacketBuffer(raw)
    const packet = parsed.data.params

    assert.strictEqual(parsed.metadata.size, raw.length)
    assert.strictEqual(packet.team, 'gczA')
    assert.strictEqual(packet.mode, 'add')
    assert.strictEqual(packet.name.value, 'gczA')
    assert.strictEqual(packet.prefix.value, '')
    assert.strictEqual(packet.suffix.value, '')
    assert.strictEqual(packet.nameTagVisibility, 'always')
    assert.strictEqual(packet.collisionRule, 'never')
    assert.strictEqual(packet.formatting, 15)
    assert.deepStrictEqual(packet.players, ['gcz'])
    assert.ok(raw.equals(serializer.createPacketBuffer(parsed.data)))
  })

  // The 26.1 and 26.2 teams payloads carry the same fields in a DIFFERENT order,
  // and 26.2 made `formatting` optional. Verified against the decompiled
  // ClientboundSetPlayerTeamPacket.Parameters for each version:
  //
  //   26.1: displayName, options, nameTagVisibility, collisionRule,
  //         color(enum), prefix, suffix
  //   26.2: displayName, prefix, suffix, nameTagVisibility, collisionRule,
  //         optional(color), options
  //
  // Both schemas are correct for their own version. The danger is that neither
  // one THROWS on the other's payload -- the wire format stays self-consistent
  // enough to decode into silently wrong values with trailing bytes left over.
  // These two tests pin the field order so a future data regen cannot quietly
  // copy one version's layout onto the other.
  it('round-trips a 26.1 teams packet with the 26.1 field order', function () {
    const deserializer = protocol.createDeserializer({
      state: states.PLAY,
      version: '26.1',
      isServer: false,
      noErrorLogging: true
    })
    const serializer = protocol.createSerializer({
      state: states.PLAY,
      version: '26.1',
      isServer: true
    })

    // 26.1 layout: flags(0x01) BEFORE visibility/collision/color, then prefix/suffix.
    const raw = Buffer.from('6d0467637a410008000467637a410100010f080000080000010367637a', 'hex')

    const parsed = deserializer.parsePacketBuffer(raw)
    const packet = parsed.data.params

    assert.strictEqual(parsed.metadata.size, raw.length, 'the whole frame must be consumed')
    assert.strictEqual(parsed.data.name, 'teams')
    assert.strictEqual(packet.team, 'gczA')
    assert.strictEqual(packet.mode, 'add')
    assert.strictEqual(packet.name.value, 'gczA')
    assert.strictEqual(packet.flags.friendly_fire, true)
    assert.strictEqual(packet.nameTagVisibility, 'always')
    assert.strictEqual(packet.collisionRule, 'never')
    assert.strictEqual(packet.formatting, 15)
    assert.strictEqual(packet.prefix.value, '')
    assert.strictEqual(packet.suffix.value, '')
    assert.deepStrictEqual(packet.players, ['gcz'])
    assert.ok(raw.equals(serializer.createPacketBuffer(parsed.data)))
  })

  it('mis-parses a teams packet across 26.1/26.2 without throwing (version mismatch is silent)', function () {
    const raw261 = Buffer.from('6d0467637a410008000467637a410100010f080000080000010367637a', 'hex')
    const raw262 = Buffer.from('6d0467637a410008000467637a410800000800000001010f00010367637a', 'hex')

    const des261 = protocol.createDeserializer({ state: states.PLAY, version: '26.1', isServer: false, noErrorLogging: true })
    const des262 = protocol.createDeserializer({ state: states.PLAY, version: '26.2', isServer: false, noErrorLogging: true })

    // A 26.2 frame fed to the 26.1 schema: decodes, but stops early and the
    // values are wrong. This is the real "malformed teams packet" signature --
    // it is a version mismatch, not a corrupt packet.
    const wrong = des261.parsePacketBuffer(raw262)
    assert.strictEqual(wrong.data.name, 'teams')
    assert.ok(
      wrong.metadata.size < raw262.length,
      'the 26.1 schema must under-consume a 26.2 frame (this is how the corruption shows up)'
    )
    assert.notStrictEqual(wrong.data.params.collisionRule, 'never', 'value is silently wrong')
    assert.deepStrictEqual(wrong.data.params.players, [], 'players are silently lost')

    // And the mirror image: a 26.1 frame fed to the 26.2 schema.
    const wrong2 = des262.parsePacketBuffer(raw261)
    assert.strictEqual(wrong2.data.name, 'teams')
    assert.ok(
      wrong2.metadata.size < raw261.length,
      'the 26.2 schema must under-consume a 26.1 frame'
    )
    assert.deepStrictEqual(wrong2.data.params.players, [], 'players are silently lost')
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
