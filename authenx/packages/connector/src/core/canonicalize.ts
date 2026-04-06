/**
 * AuthenX Connector — Canonicalization Layer
 *
 * Creates a deterministic, normalized JSON representation of a credential.
 * This MUST produce the exact same output as the API's buildCanonicalJson
 * for hash verification to work.
 *
 * Rules:
 *  - Field order is FIXED (schema-versioned)
 *  - All strings are trimmed
 *  - Name, degree, branch, credential_type are uppercased
 *  - Numeric values (cgpa) stored as strings for determinism
 *  - Date: ISO 8601 format YYYY-MM-DD
 */

export interface StandardCredential {
  schema_version: string;
  issuer_id: string;
  student_ref_token: string;       // Opaque reference — not the actual student ID
  name: string;
  degree: string;
  branch: string;
  credential_type: string;
  cgpa: string;
  graduation_year: string;
  issue_date: string;              // YYYY-MM-DD
}

/**
 * Produces the canonical JSON string from a standard credential.
 * Field order is enforced explicitly — do not use object spread.
 */
export function canonicalize(credential: StandardCredential): string {
  const ordered = {
    schema_version:     credential.schema_version.trim(),
    issuer_id:          credential.issuer_id.trim(),
    student_ref_token:  credential.student_ref_token.trim(),
    name:               credential.name.trim().toUpperCase(),
    degree:             credential.degree.trim().toUpperCase(),
    branch:             credential.branch.trim().toUpperCase(),
    credential_type:    credential.credential_type.trim().toUpperCase(),
    cgpa:               credential.cgpa.trim(),
    graduation_year:    credential.graduation_year.trim(),
    issue_date:         credential.issue_date.trim(),
  };

  return JSON.stringify(ordered);
}

/**
 * Validates that all required fields are present and non-empty.
 * Throws a descriptive error if validation fails.
 */
export function validateStandardCredential(data: Partial<StandardCredential>): StandardCredential {
  const required: (keyof StandardCredential)[] = [
    'schema_version', 'issuer_id', 'student_ref_token',
    'name', 'degree', 'branch', 'credential_type',
    'cgpa', 'graduation_year', 'issue_date',
  ];

  for (const field of required) {
    if (!data[field] || String(data[field]).trim() === '') {
      throw new Error(`Canonicalization failed: missing required field "${field}"`);
    }
  }

  return data as StandardCredential;
}
