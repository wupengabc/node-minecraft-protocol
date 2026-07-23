/* eslint-env mocha */

const assert = require('assert')
const framing = require('../src/transforms/framing')

describe('framing splitter', function () {
  it('keeps trailing packets reachable during a large inbound batch', function (done) {
    const splitter = framing.createSplitter()
    const packetCount = 128 * 3
    const frames = Array.from({ length: packetCount }, () => Buffer.from([1, 0x01]))
    frames.push(Buffer.from([1, 0x7f]))

    let eventLoopYielded = false
    let received = 0
    splitter.on('data', (packet) => {
      received += 1
      if (packet[0] !== 0x7f) return
      assert.strictEqual(received, packetCount + 1)
      assert.strictEqual(eventLoopYielded, true)
      done()
    })

    splitter.write(Buffer.concat(frames))
    setImmediate(() => { eventLoopYielded = true })
  })
})
