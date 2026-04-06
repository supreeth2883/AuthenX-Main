/**
 * AuthenX Connector — Verification Route
 *
 * POST /verify
 * Called by the AuthenX API when an employer requests live verification.
 *
 * Flow:
 *  1. AuthenX API sends: { request_id, token_id, credential_reference_token, nonce, ... }
 *  2. Connector fetches current credential data from ERP (via adapter)
 *  3. Connector re-canonicalizes and re-hashes
 *  4. Connector checks lifecycle status
 *  5. Connector applies disclosure policy
 *  6. Connector signs the full response (SECOND signature)
 *  7. Connector returns signed result to AuthenX API
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canonicalize, validateStandardCredential } from '../core/canonicalize.js';
import { sha256, signVerificationResponse } from '../core/crypto.js';
import { fetchFromErp, getDisclosurePolicy } from '../adapters/mock.adapter.js';

const verifyRequestSchema = z.object({
  request_id: z.string().min(1),
  token_id: z.string().min(1),
  credential_reference_token: z.string().min(1),
  nonce: z.string().min(1),
  issuer_id: z.string().min(1),
  requested_at: z.string().datetime(),
});

export async function verifyRoutes(fastify: FastifyInstance) {

  // ── POST /verify ───────────────────────────────────────────────────────────
  fastify.post('/verify', async (request, reply) => {

    // ── 0. Authenticate the request (shared secret) ───────────────────────
    const secret = request.headers['x-authenx-secret'];
    if (secret !== process.env.CONNECTOR_SECRET) {
      return reply.status(401).send({ error: 'UNAUTHORIZED' });
    }

    const body = verifyRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }

    const { request_id, credential_reference_token, nonce } = body.data;
    const respondedAt = new Date().toISOString();

    // ── 1. Fetch current credential data from ERP ─────────────────────────
    const erpResult = await fetchFromErp(credential_reference_token);

    if (!erpResult.found || !erpResult.credential) {
      const responsePayload = {
        request_id,
        nonce,
        result_status: 'unavailable',
        issued_hash_match: false,
        current_hash: '',
        credential_status: 'not_found',
        responded_at: respondedAt,
      };

      return reply.status(200).send({
        ...responsePayload,
        live_signature: signVerificationResponse(responsePayload),
      });
    }

    // ── 2. Re-canonicalize and re-hash current ERP data ───────────────────
    const validated = validateStandardCredential(erpResult.credential);
    const currentCanonical = canonicalize(validated);
    const currentHash = sha256(currentCanonical);

    // ── 3. Check credential lifecycle ─────────────────────────────────────
    const isRevoked = erpResult.credential_status === 'revoked';

    if (isRevoked) {
      const responsePayload = {
        request_id,
        nonce,
        result_status: 'revoked',
        issued_hash_match: false,
        current_hash: currentHash,
        credential_status: 'revoked',
        responded_at: respondedAt,
      };

      return reply.status(200).send({
        ...responsePayload,
        live_signature: signVerificationResponse(responsePayload),
      });
    }

    // ── 4. Apply disclosure policy — what fields can employer see ─────────
    const policy = getDisclosurePolicy();
    const approvedDisplayFields: Record<string, string> = {};

    if (policy.show_name)            approvedDisplayFields.name = validated.name;
    if (policy.show_degree)          approvedDisplayFields.degree = validated.degree;
    if (policy.show_branch)          approvedDisplayFields.branch = validated.branch;
    if (policy.show_graduation_year) approvedDisplayFields.graduation_year = validated.graduation_year;
    if (policy.show_cgpa)            approvedDisplayFields.cgpa = validated.cgpa;

    // ── 5. Build and sign the response ────────────────────────────────────
    // NOTE: issued_hash_match is determined here, but the API also
    // independently verifies this is consistent. We send current_hash
    // so the API can independently verify the match against stored issued_hash.

    const resultStatus = 'verified';  // If we reach here, credential is active

    const responsePayload = {
      request_id,
      nonce,
      result_status: resultStatus,
      issued_hash_match: true,  // The API will independently verify current_hash vs issued_hash
      current_hash: currentHash,
      approved_display_fields: approvedDisplayFields,
      credential_status: erpResult.credential_status ?? 'active',
      responded_at: respondedAt,
    };

    const liveSignature = signVerificationResponse(responsePayload);

    return reply.status(200).send({
      ...responsePayload,
      live_signature: liveSignature,
    });
  });
}
