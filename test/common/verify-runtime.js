'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

// Verify what the application resolves, including aliases and transitive copies.
const runtime = createRequire(path.resolve(process.argv[2], 'package.json'))
const sources = path.resolve(__dirname, '../../..')
const mfEntry = runtime.resolve('mineflayer')
assert.strictEqual(runtime.resolve('@wp2508/mineflayer'), mfEntry)
const mf = createRequire(mfEntry)
const nmp = createRequire(mf.resolve('minecraft-protocol'))
assert.strictEqual(runtime.resolve('minecraft-protocol'), mf.resolve('minecraft-protocol'))
const mfRoot = path.dirname(mfEntry)
const nmpRoot = path.resolve(path.dirname(nmp.resolve('./index')), '..')
const mfFiles = [
  'docs/api.md', 'index.d.ts', 'lib/interaction_sequence.js', 'lib/item_hash.js', 'lib/player_action.js',
  ...['blocks', 'creative', 'digging', 'entities', 'game', 'generic_place', 'inventory', 'physics', 'place_entity', 'resource_pack'].map(name => `lib/plugins/${name}.js`)
]
const nmpFiles = [
  'src/client.js', 'src/createClient.js', 'src/index.d.ts', 'src/transforms/serializer.js',
  ...['chat', 'cookie', 'encrypt', 'play'].map(name => `src/client/${name}.js`),
  'src/datatypes/minecraft.js', 'src/datatypes/compiler-minecraft.js'
]

function same (first, second) {
  assert.ok(fs.readFileSync(first).equals(fs.readFileSync(second)), `${first} differs from ${second}`)
}

for (const file of mfFiles) same(path.join(sources, 'mineflayer', file), path.join(mfRoot, file))
for (const file of nmpFiles) same(path.join(sources, 'node-minecraft-protocol', file), path.join(nmpRoot, file))
for (const version of ['26.2', '26.3']) {
  const relative = `minecraft-data/data/pc/${version}/protocol.json`
  const canonical = path.join(sources, 'minecraft-data/data/pc', version, 'protocol.json')
  same(canonical, path.join(sources, 'node-minecraft-data', relative))
  for (const resolve of [runtime, mf, nmp]) {
    const installed = resolve.resolve(`minecraft-data/${relative}`)
    // pnpm preserves the published 26.3 file's absent final newline.
    assert.strictEqual(fs.readFileSync(canonical, 'utf8').replace(/\n$/, ''), fs.readFileSync(installed, 'utf8').replace(/\n$/, ''))
  }
}

const chunks = []
for (const resolve of [runtime, mf]) {
  const entry = resolve.resolve('prismarine-chunk')
  const registry = createRequire(entry)('prismarine-registry')('26.3')
  const Chunk = resolve('prismarine-chunk')(registry)
  const chunk = new Chunk({ minY: -16, worldHeight: 32 })
  const sections = chunk.sections.slice()
  chunk.loadBiomes(Buffer.from([0, 4, 0, 2]))
  assert.strictEqual(chunk.getBiome({ x: 0, y: -16, z: 0 }), 4)
  assert.strictEqual(chunk.getBiome({ x: 0, y: 0, z: 0 }), 2)
  sections.forEach((section, index) => assert.strictEqual(chunk.sections[index], section))
  chunks.push({ version: createRequire(entry)('./package.json').version, entry })
}

console.log(JSON.stringify({ mineflayerFiles: mfFiles.length, protocolFiles: nmpFiles.length, schemas: 2, schemaComparison: 'bytes-except-optional-final-LF', aliasesMatch: true, chunks }, null, 2))
