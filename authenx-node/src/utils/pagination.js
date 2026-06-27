'use strict';
/**
 * AuthenX — Pagination Helper
 *
 * Extracts and validates limit/offset query parameters.
 * Replaces identical parsing in audit.js, server.js (security events,
 * fraud alerts), and any future paginated endpoint.
 */

/**
 * Parse pagination params from a URL object.
 *
 * @param {URL} urlObj
 * @param {object} [defaults]
 * @param {number} [defaults.limit=50]
 * @param {number} [defaults.offset=0]
 * @param {number} [defaults.maxLimit=1000]
 * @returns {{ limit: number, offset: number }}
 */
function parsePagination(urlObj, { limit: defLimit = 50, offset: defOffset = 0, maxLimit = 1000 } = {}) {
  let limit  = parseInt(urlObj.searchParams.get('limit')  || String(defLimit),  10);
  let offset = parseInt(urlObj.searchParams.get('offset') || String(defOffset), 10);
  if (isNaN(limit)  || limit  < 1)  limit  = defLimit;
  if (isNaN(offset) || offset < 0)  offset = defOffset;
  if (limit > maxLimit)             limit  = maxLimit;
  return { limit, offset };
}

module.exports = { parsePagination };
