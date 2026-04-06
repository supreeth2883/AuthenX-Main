'use strict';
/**
 * AuthenX Connector — Field Mapper
 * Maps raw database/API rows to the AuthenX standard credential schema.
 *
 * Supported mapping types:
 *   column       → direct column reference
 *   concat       → join multiple columns with separator
 *   year_from_date → extract 4-digit year from a date string/column
 *   map_values   → map raw values to active/inactive
 *   direct       → hardcoded constant value
 *   nested       → dot-path access for API responses (e.g. "student.name")
 *   coalesce     → first non-null value across multiple columns
 *   transform    → apply a simple transform (uppercase, lowercase, trim)
 */

/**
 * Safely get a nested value from an object using dot notation.
 * e.g. getPath({ student: { name: 'A' } }, 'student.name') → 'A'
 */
function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

/**
 * Apply a single field spec to a data row.
 * Returns the mapped value (string, number, or null).
 */
function applySpec(row, spec) {
  if (!spec || !spec.type) return null;

  switch (spec.type) {

    case 'column':
      return row[spec.column] ?? null;

    case 'nested':
      return getPath(row, spec.path) ?? null;

    case 'concat': {
      const parts = (spec.columns || []).map(col => String(row[col] ?? '')).filter(Boolean);
      return parts.join(spec.separator || ' ') || null;
    }

    case 'year_from_date': {
      const raw = row[spec.column];
      if (!raw) return null;
      const d = new Date(raw);
      return isNaN(d) ? String(raw).slice(0, 4) : String(d.getFullYear());
    }

    case 'map_values': {
      const raw = String(row[spec.column] ?? '').toLowerCase().trim();
      const activeVals   = (spec.active_values   || []).map(v => v.toLowerCase());
      const inactiveVals = (spec.inactive_values  || []).map(v => v.toLowerCase());
      if (activeVals.includes(raw))   return 'active';
      if (inactiveVals.includes(raw)) return 'inactive';
      return 'unknown';
    }

    case 'direct':
      return spec.value ?? null;

    case 'coalesce': {
      for (const col of (spec.columns || [])) {
        const val = row[col];
        if (val !== null && val !== undefined && val !== '') return val;
      }
      return spec.default ?? null;
    }

    case 'transform': {
      const base = applySpec(row, spec.source);
      if (base === null || base === undefined) return null;
      let s = String(base);
      for (const op of (spec.ops || [])) {
        if (op === 'uppercase') s = s.toUpperCase();
        else if (op === 'lowercase') s = s.toLowerCase();
        else if (op === 'trim') s = s.trim();
        else if (op === 'replace_dots') s = s.replace(/\./g, '');
      }
      return s;
    }

    default:
      return null;
  }
}

/**
 * Apply a full field_mapping config to a data row.
 * Returns an object with AuthenX standard fields.
 */
function applyFieldMapping(row, fieldMapping) {
  const result = {};
  for (const [outputField, spec] of Object.entries(fieldMapping || {})) {
    result[outputField] = applySpec(row, spec);
  }
  return result;
}

/**
 * Validate that all required AuthenX fields are present after mapping.
 * Returns array of missing field names (empty if all present).
 */
function validateMappedFields(mapped) {
  const required = ['name', 'degree', 'branch', 'cgpa', 'graduation_year', 'issue_date'];
  return required.filter(f => mapped[f] === null || mapped[f] === undefined || mapped[f] === '');
}

module.exports = { applyFieldMapping, validateMappedFields, getPath };
