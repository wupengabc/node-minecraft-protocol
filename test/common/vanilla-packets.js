const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')

const protocols = { handshake: 'handshaking', status: 'status', login: 'login', configuration: 'configuration', game: 'play' }

function walk (directory, suffix) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(name, suffix) : name.endsWith(suffix) ? [name] : []
  })
}

function inventory (sourceRoot, schema, handlerRoots = []) {
  const files = walk(sourceRoot, '.java')
  const sources = new Map(files.map(file => [path.basename(file, '.java'), { file, text: fs.readFileSync(file, 'utf8') }]))
  const types = new Map()
  for (const { text } of sources.values()) {
    for (const match of text.matchAll(/PacketType<([^>]+)>\s+(\w+)\s*=\s*create(?:Clientbound|Serverbound)\(\s*"([^"]+)"\s*\)/g)) {
      types.set(match[2], { class: match[1], identifier: match[3] })
    }
  }
  const handlers = handlerRoots.flatMap(root => walk(root, '.js')).map(file => ({ file, text: fs.readFileSync(file, 'utf8') }))
  const packets = []
  const states = []
  for (const [directory, state] of Object.entries(protocols)) {
    const source = sources.get(`${directory[0].toUpperCase()}${directory.slice(1)}Protocols`)
    if (!source) throw new Error(`Missing ${directory} protocol source`)
    for (const direction of ['SERVERBOUND', 'CLIENTBOUND']) {
      const start = source.text.indexOf(` ${direction}_TEMPLATE =`)
      if (start < 0) continue
      const end = source.text.indexOf('\n  );', start)
      const body = source.text.slice(start, end < 0 ? source.text.indexOf('\n  public static', start + 1) : end)
      const registered = [...body.matchAll(/\.(addPacket|withBundlePacket)\(\s*\w+\.(\w+)\s*,\s*([\w.]+)/g)]
      const wireDirection = direction === 'SERVERBOUND' ? 'toServer' : 'toClient'
      const definitions = schema[state]?.[wireDirection]?.types
      const container = definitions?.packet?.[1]
      const names = container?.find(field => field.name === 'name')?.type?.[1]?.mappings ?? {}
      const packetTypes = container?.find(field => field.name === 'params')?.type?.[1]?.fields ?? {}
      states.push({ state, direction: wireDirection, vanillaCount: registered.length, schemaCount: Object.keys(names).length })
      for (const [id, match] of registered.entries()) {
        const type = types.get(match[2])
        if (!type) throw new Error(`Unknown registered packet ${match[2]}`)
        const name = names[`0x${id.toString(16).padStart(2, '0')}`] ?? names[id]
        const className = match[1] === 'withBundlePacket' ? 'ClientboundBundleDelimiterPacket' : type.class
        const implementation = sources.get(className.split('.')[0])
        const handlerFiles = handlers.filter(handler => new RegExp(`\\.(?:on|once|prependListener)\\(['"]${name}['"]`).test(handler.text)).map(handler => handler.file)
        packets.push({
          state,
          direction: wireDirection,
          id,
          identifier: match[1] === 'withBundlePacket' ? 'bundle_delimiter' : type.identifier,
          class: className,
          schemaName: name ?? null,
          schemaType: packetTypes[name] ?? null,
          source: implementation && path.relative(sourceRoot, implementation.file),
          sourceSha256: implementation && createHash('sha256').update(implementation.text).digest('hex'),
          handlerFiles: handlerFiles.map(file => path.relative(path.resolve(__dirname, '../../..'), file)),
          verification: 'registration-inventory-only'
        })
      }
    }
  }
  return { sourceFileCount: files.length, packetSourceCount: files.filter(file => /(?:bound\w*(?:Packet|Packs)|ClientIntentionPacket)\.java$/.test(file)).length, states, packets }
}

module.exports = { inventory }

if (require.main === module) {
  const [sourceRoot, protocolPath, output] = process.argv.slice(2)
  const report = inventory(sourceRoot, JSON.parse(fs.readFileSync(protocolPath, 'utf8')), [path.resolve(__dirname, '../../src/client'), path.resolve(__dirname, '../../../mineflayer/lib/plugins')])
  const json = JSON.stringify(report, null, 2) + '\n'
  if (output) fs.writeFileSync(output, json)
  else process.stdout.write(json)
}
