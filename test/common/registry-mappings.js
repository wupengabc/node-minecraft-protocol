const fs = require('fs')
const path = require('path')

function regenerate (filename, version, dataRoot, write = false) {
  let text = fs.readFileSync(filename, 'utf8')
  const schema = JSON.parse(text)
  const particles = JSON.parse(fs.readFileSync(path.join(dataRoot, version, 'particles.json'), 'utf8'))
  const attributes = JSON.parse(fs.readFileSync(path.join(dataRoot, version, 'attributes.json'), 'utf8'))
  const oldAttributes = schema.play.toClient.types.packet_entity_update_attributes[1][1].type[1].type[1][0].type[1].mappings
  const aliases = Object.values(oldAttributes)
  const mappings = {
    Particle: Object.fromEntries(particles.map(particle => [particle.id, particle.name])),
    packet_entity_update_attributes: Object.fromEntries(attributes.map((attribute, index) => {
      const name = attribute.resource.replace('minecraft:', '')
      return [index, aliases.find(alias => alias === name || alias.endsWith(`.${name}`)) ?? name]
    }))
  }
  for (const [section, mapping] of Object.entries(mappings)) {
    const start = text.indexOf(`"${section}":`)
    const mapper = text.indexOf('"mappings": {', start)
    if (start < 0 || mapper < 0) throw new Error(`Missing ${section}`)
    const from = text.indexOf('{', mapper)
    const end = text.indexOf('}', from)
    const indent = text.slice(text.lastIndexOf('\n', mapper) + 1, mapper).length
    const contents = Object.entries(mapping).map(([id, value]) => `${' '.repeat(indent + 2)}${JSON.stringify(id)}: ${JSON.stringify(value)}`).join(',\n')
    text = text.slice(0, from + 1) + '\n' + contents + '\n' + ' '.repeat(indent) + text.slice(end)
  }
  if (write) fs.writeFileSync(filename, text)
  return text
}

module.exports = { regenerate }

if (require.main === module) {
  const root = path.resolve(__dirname, '../../..')
  for (const version of ['26.2', '26.3']) {
    for (const repository of ['minecraft-data', 'node-minecraft-data/minecraft-data']) {
      regenerate(path.join(root, repository, 'data/pc', version, 'protocol.json'), version, path.join(root, 'minecraft-data/data/pc'), true)
    }
  }
}
