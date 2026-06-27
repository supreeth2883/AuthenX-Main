'use strict';
/**
 * AuthenX — Mock Connector Detection
 *
 * Single check for whether a connector_url represents a mock/internal
 * placeholder rather than a real HTTP endpoint.  Previously duplicated
 * in verify.js, connector-proxy.js, and server.js.
 */

/**
 * @param {string|null|undefined} url
 * @returns {boolean} true when the URL is missing or a mock placeholder
 */
function isMockConnectorUrl(url) {
  return !url || url === 'mock' || url.startsWith('internal://');
}

module.exports = { isMockConnectorUrl };
