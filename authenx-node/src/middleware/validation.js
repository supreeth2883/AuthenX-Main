'use strict';
/**
 * AuthenX Input Validation & Sanitization Middleware
 * Provides centralized input validation, XSS sanitization, and format enforcement.
 */

// ─── XSS Sanitization ────────────────────────────────────────────────────────
/** Strip HTML tags and dangerous characters from a string */
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Recursively sanitize all string values in an object */
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      clean[key] = sanitize(value);
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = sanitizeObject(value);
    } else if (Array.isArray(value)) {
      clean[key] = value.map(v => typeof v === 'string' ? sanitize(v) : v);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

// ─── Format Validators ───────────────────────────────────────────────────────
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidUUID(str) {
  return typeof str === 'string' && UUID_REGEX.test(str);
}

function isValidEmail(str) {
  return typeof str === 'string' && EMAIL_REGEX.test(str) && str.length <= 255;
}

// ─── Password Policy ─────────────────────────────────────────────────────────
/**
 * Enforce strong password policy:
 *   - Minimum 12 characters
 *   - At least 1 uppercase letter
 *   - At least 1 lowercase letter
 *   - At least 1 digit
 *   - At least 1 special character
 */
function validatePasswordStrength(password) {
  const errors = [];
  if (!password || typeof password !== 'string') return ['Password is required'];
  if (password.length < 12) errors.push('Password must be at least 12 characters');
  if (!/[A-Z]/.test(password)) errors.push('Password must contain at least one uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('Password must contain at least one lowercase letter');
  if (!/[0-9]/.test(password)) errors.push('Password must contain at least one digit');
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) errors.push('Password must contain at least one special character');
  return errors;
}

// ─── Field Validators ─────────────────────────────────────────────────────────
function validateString(value, fieldName, { minLength = 1, maxLength = 500 } = {}) {
  if (typeof value !== 'string') return `${fieldName} must be a string`;
  if (value.trim().length < minLength) return `${fieldName} must be at least ${minLength} characters`;
  if (value.length > maxLength) return `${fieldName} must be at most ${maxLength} characters`;
  return null;
}

function validateRequired(body, fields) {
  const errors = [];
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

module.exports = {
  sanitize,
  sanitizeObject,
  isValidUUID,
  isValidEmail,
  validatePasswordStrength,
  validateString,
  validateRequired,
};
