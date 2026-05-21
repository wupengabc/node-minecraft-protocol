'use strict'

/**
 * Injects protocolVersion=775 onto an error object for 26.1 protocol diagnostics.
 * Used by NMP and mineflayer to tag errors originating from the 26.1 protocol path.
 *
 * @param {Error|object} err - The error object to tag
 * @returns {Error|object} The same error object with protocolVersion set to 775
 */
function tagWith261 (err) {
  err.protocolVersion = 775
  return err
}

module.exports = tagWith261
