'use strict';
/**
 * AuthenX — JSON Response Helpers
 *
 * Eliminates the repetitive pattern:
 *   res.writeHead(XXX, { 'Content-Type': 'application/json' });
 *   res.end(JSON.stringify({ ... }));
 *
 * which appears 60+ times across route handlers.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Send a JSON response with the given status code and payload. */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(data));
}

/** Send a JSON error response. */
function sendError(res, statusCode, error, extra) {
  sendJson(res, statusCode, extra ? { error, ...extra } : { error });
}

module.exports = { sendJson, sendError };
