'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { ProtoDef } = require('protodef')
const { ProtoDefCompiler } = require('protodef').Compiler
const minecraft = require('../src/datatypes/minecraft')

describe('26.3 vecDelta', function () {
  for (const compiled of [false, true]) {
    const label = compiled ? 'compiled' : 'interpreted'
    let proto
    before(function () {
      if (compiled) {
        const compiler = new ProtoDefCompiler()
        compiler.addTypes(require('../src/datatypes/compiler-minecraft'))
        proto = compiler.compileProtoDefSync()
      } else {
        proto = new ProtoDef(false)
        proto.addTypes(minecraft)
      }
    })

    // ClientboundMoveEntityPacket packs stepCount << 1 | onGround, followed by
    // VecDelta.read: linear i16 triples or (ticks varint, i16 triple) per step.
    const fixtures = [
      { hex: '011000f8000001', value: { onGround: true, dX: 1, dY: -0.5, dZ: 1 / 4096, steps: [] } },
      {
        hex: '05021000f8000001800108000400ffff',
        value: {
          onGround: true,
          dX: 1.5,
          dY: -0.25,
          dZ: 0,
          steps: [
            { ticks: 2, x: 1, y: -0.5, z: 1 / 4096 },
            { ticks: 128, x: 0.5, y: 0.25, z: -1 / 4096 }
          ]
        }
      },
      {
        hex: '04017fff80000000017fff80000000',
        value: {
          onGround: false,
          dX: 65534 / 4096,
          dY: -16,
          dZ: 0,
          steps: [
            { ticks: 1, x: 32767 / 4096, y: -8, z: 0 },
            { ticks: 1, x: 32767 / 4096, y: -8, z: 0 }
          ]
        }
      }
    ]

    for (const fixture of fixtures) {
      it(`${label}: decodes and re-encodes vanilla layout ${fixture.hex}`, function () {
        const buffer = Buffer.from(fixture.hex, 'hex')
        const decoded = proto.read(buffer, 0, 'vecDelta')
        assert.strictEqual(decoded.size, buffer.length)
        assert.deepStrictEqual(decoded.value, fixture.value)
        assert.strictEqual(proto.sizeOf(decoded.value, 'vecDelta'), buffer.length)
        const encoded = Buffer.alloc(buffer.length)
        assert.strictEqual(proto.write(decoded.value, encoded, 0, 'vecDelta'), buffer.length)
        assert.deepStrictEqual(encoded, buffer)
      })
    }

    it(`${label}: reports partial reads for truncated headers and steps`, function () {
      for (const hex of ['80', '000000', '0480', '0401000000000000010000']) {
        assert.throws(() => proto.read(Buffer.from(hex, 'hex'), 0, 'vecDelta'), error => error.partialReadError)
      }
    })
  }
})
