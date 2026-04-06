/**
 * AuthenX Connector — Mock ERP Adapter
 *
 * Used for development and testing only.
 * Simulates a college ERP with realistic test data.
 *
 * When a verification request comes in, this adapter returns test student
 * records from the in-memory dataset below — no real database needed.
 *
 * Replace this with db.adapter.ts or api.adapter.ts when connecting
 * to a real college ERP.
 */

import type { StandardCredential } from '../core/canonicalize.js';

// ─── Mock ERP Dataset ─────────────────────────────────────────────────────────
// These are fake test students. Add more as needed for testing.

const MOCK_STUDENTS: Record<string, StandardCredential & { credential_status: string }> = {
  'stu_ref_001': {
    schema_version: '1.0',
    issuer_id: process.env.COLLEGE_ISSUER_ID ?? 'mock-issuer-id',
    student_ref_token: 'stu_ref_001',
    name: 'SUPREETH K',
    degree: 'BTECH',
    branch: 'CSE',
    credential_type: 'FINAL_DEGREE',
    cgpa: '8.45',
    graduation_year: '2026',
    issue_date: '2026-05-14',
    credential_status: 'active',
  },
  'stu_ref_002': {
    schema_version: '1.0',
    issuer_id: process.env.COLLEGE_ISSUER_ID ?? 'mock-issuer-id',
    student_ref_token: 'stu_ref_002',
    name: 'PRIYA SHARMA',
    degree: 'MTECH',
    branch: 'ECE',
    credential_type: 'FINAL_DEGREE',
    cgpa: '9.10',
    graduation_year: '2025',
    issue_date: '2025-06-01',
    credential_status: 'active',
  },
  'stu_ref_003': {
    schema_version: '1.0',
    issuer_id: process.env.COLLEGE_ISSUER_ID ?? 'mock-issuer-id',
    student_ref_token: 'stu_ref_003',
    name: 'RAHUL NAIR',
    degree: 'BTECH',
    branch: 'MECH',
    credential_type: 'FINAL_DEGREE',
    cgpa: '7.80',
    graduation_year: '2026',
    issue_date: '2026-05-14',
    credential_status: 'revoked',  // Test case for revoked credential
  },
};

// ─── Adapter Interface ────────────────────────────────────────────────────────

export interface AdapterResult {
  found: boolean;
  credential?: StandardCredential;
  credential_status?: string;
  error?: string;
}

/**
 * Fetches a student credential from the mock ERP by their opaque reference token.
 *
 * In a real adapter (db.adapter.ts), this would:
 *   1. Connect to the college DB with a read-only user
 *   2. Run an indexed SELECT on the configured field mappings
 *   3. Map the result to StandardCredential format
 *   4. Return it
 */
export async function fetchFromErp(studentRefToken: string): Promise<AdapterResult> {
  // Simulate network/DB latency (50-200ms)
  await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 150));

  const student = MOCK_STUDENTS[studentRefToken];

  if (!student) {
    return {
      found: false,
      error: `No student found for reference: ${studentRefToken}`,
    };
  }

  const { credential_status, ...credential } = student;

  return {
    found: true,
    credential,
    credential_status,
  };
}

/**
 * Returns the disclosure policy for what fields are visible to employers.
 * In production, this should come from the college's configured disclosure settings.
 */
export function getDisclosurePolicy() {
  return {
    show_name: true,
    show_degree: true,
    show_branch: true,
    show_graduation_year: true,
    show_cgpa: true,
    show_father_name: false,     // Default: hidden
    show_full_marks: false,      // Default: hidden
  };
}
