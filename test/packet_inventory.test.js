/* eslint-env mocha */
const assert = require('assert')
const path = require('path')
const { inventory } = require('./common/vanilla-packets')
const { createSerializer, createDeserializer } = require('../src/transforms/serializer')

// These source inventories pin registration coverage, not field/behavior parity.
for (const version of ['26.2', '26.3']) {
  describe(`vanilla packet registration inventory ${version}`, function () {
    const snapshot = require(`./common/vanilla-packets-${version}.json`)
    const protocol = require('minecraft-data')(version).protocol
    for (const { state, direction, vanillaCount, schemaCount } of snapshot.states) {
      it(`${state}/${direction}: preserves all ${vanillaCount} vanilla registrations and compiles their codec`, function () {
        const fields = protocol[state][direction].types.packet[1]
        const names = fields.find(field => field.name === 'name').type[1].mappings
        const types = fields.find(field => field.name === 'params').type[1].fields
        assert.strictEqual(Object.keys(names).length, schemaCount)
        for (const packet of snapshot.packets.filter(packet => packet.state === state && packet.direction === direction)) {
          const id = `0x${packet.id.toString(16).padStart(2, '0')}`
          assert.strictEqual(names[id], packet.schemaName, `${packet.class} (0x${packet.id.toString(16)})`)
          assert.ok(types[packet.schemaName], `${packet.class} has a payload schema`)
          assert.ok(packet.source && packet.sourceSha256)
        }
        createSerializer({ version, state, isServer: direction === 'toClient' }).destroy()
        createDeserializer({ version, state, isServer: direction === 'toServer' }).destroy()
      })
    }
    if (process.env.MINECRAFT_VANILLA_SOURCES) {
      it('reproduces registrations from a full Mojmap decompilation', function () {
        const source = path.join(process.env.MINECRAFT_VANILLA_SOURCES, version, 'mojmap/net/minecraft/network/protocol')
        const current = inventory(source, protocol)
        assert.deepStrictEqual(current.states, snapshot.states)
        const select = packets => packets.map(({ state, direction, id, identifier, class: className, schemaName, sourceSha256 }) => ({ state, direction, id, identifier, className, schemaName, sourceSha256 }))
        assert.deepStrictEqual(select(current.packets), select(snapshot.packets))
      })
    }
  })
}
