/* eslint-env mocha */
'use strict'

const assert = require('assert')
const { createSerializer, createDeserializer } = require('../src/transforms/serializer')

function item (itemId, itemCount = 1) {
  return { itemId, itemCount, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] }
}

describe('pot_decorations wire format', () => {
  for (const compiled of [true, false]) {
    const codec = compiled ? 'compiled' : 'interpreted'
    for (const { name, data, hex } of [
      { name: 'empty', data: { back: undefined, left: undefined, right: undefined, front: undefined }, hex: '4c00000000' },
      { name: 'partial', data: { back: item(1), left: undefined, right: item(300, 2), front: undefined }, hex: '4c01010100000001ac0202000000' },
      { name: 'all present', data: { back: item(1), left: item(2, 3), right: item(300, 2), front: item(4, 5) }, hex: '4c0101010000010203000001ac020200000104050000' }
    ]) {
      it(`uses four ordered optional item templates for 26.3: ${name} (${codec})`, () => {
        const serializer = createSerializer({ state: 'play', version: '26.3', isServer: true, compiled })
        const parser = createDeserializer({ state: 'play', version: '26.3', compiled })
        try {
          const component = { type: 'pot_decorations', data }
          const expected = Buffer.from(hex, 'hex')
          // Independent bytes pin option markers, field order, item ID BEFORE
          // count and the template's component-patch counts.
          assert.deepStrictEqual(serializer.proto.createPacketBuffer('SlotComponent', component), expected)
          const decoded = parser.proto.parsePacketBuffer('SlotComponent', expected)
          assert.strictEqual(decoded.metadata.size, expected.length)
          assert.deepStrictEqual(decoded.data, component)
        } finally {
          serializer.destroy()
          parser.destroy()
        }
      })
    }

    for (const version of ['26.1', '26.2']) {
      it(`preserves the item ID array for ${version} (${codec})`, () => {
        const serializer = createSerializer({ state: 'play', version, isServer: true, compiled })
        const parser = createDeserializer({ state: 'play', version, compiled })
        try {
          const component = { type: 'pot_decorations', data: { decorations: [1, 300, 2, 4] } }
          const expected = Buffer.from('4a0401ac020204', 'hex')
          assert.deepStrictEqual(serializer.proto.createPacketBuffer('SlotComponent', component), expected)
          const decoded = parser.proto.parsePacketBuffer('SlotComponent', expected)
          assert.strictEqual(decoded.metadata.size, expected.length)
          assert.deepStrictEqual(decoded.data, component)
        } finally {
          serializer.destroy()
          parser.destroy()
        }
      })
    }
  }
})
