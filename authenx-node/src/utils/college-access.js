'use strict';
/**
 * AuthenX — College Access Control Helpers
 *
 * Consolidates two patterns repeated across disclosure.js,
 * connector-config.js, tokens.js, and tokens-extra.js:
 *
 *   1) resolveCollegeId — super_admin can override college_id,
 *      college_admin is locked to their own.
 *
 *   2) enforceCollegeAccess — returns 403 if a college_admin
 *      tries to access another college's resource.
 */

/**
 * Determine the effective college_id for a request.
 * super_admin may specify an explicit override; college_admin is always
 * scoped to their own college_id from the JWT.
 *
 * @param {object} claims - JWT claims (must have .role, .college_id)
 * @param {string|null|undefined} requestedCollegeId - Explicit override from body/query
 * @returns {string|null} Effective college_id (null if none available)
 */
function resolveCollegeId(claims, requestedCollegeId) {
  if (claims.role === 'super_admin') {
    return requestedCollegeId || claims.college_id || null;
  }
  return claims.college_id || null;
}

/**
 * Check that a college_admin may access a resource belonging to the
 * given college.  Sends a 403 response and returns false when denied.
 *
 * @param {object} claims - JWT claims
 * @param {string} resourceCollegeId - college_id of the target resource
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} true if access is allowed
 */
function enforceCollegeAccess(claims, resourceCollegeId, res) {
  if (claims.role === 'college_admin' && claims.college_id !== resourceCollegeId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Access denied' }));
    return false;
  }
  return true;
}

module.exports = { resolveCollegeId, enforceCollegeAccess };
