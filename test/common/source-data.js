'use strict'

// Optional pre-release test dependency. Redirect module resolution, never mutate
// installed packages or protocol objects. Omit the variable to test npm data.
if (process.env.MINECRAFT_PROTOCOL_TEST_DATA) {
  const Module = require('module')
  const path = require('path')
  const data = require(path.resolve(process.env.MINECRAFT_PROTOCOL_TEST_DATA))
  const load = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'minecraft-data') return data
    return load.call(this, request, parent, isMain)
  }
}
