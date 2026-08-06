'use strict'

/**
 * Injects the negotiated protocol version onto an error object for 26.1+ diagnostics.
 *
 * @param {Error|object} err - The error object to tag
 * @param {number} [protocolVersion=775] - The negotiated protocol version
 * @returns {Error|object} The same error object with protocolVersion set
 */
function tagWith261 (err, protocolVersion = 775) {
  err.protocolVersion = protocolVersion
  return err
}

module.exports = tagWith261
