/**
 * AuthenX API — Verification Routes
 *
 * POST /v1/verify/code   — Decode an AuthenX Code, get token metadata
 * POST /v1/verify/live   — Trigger live connector verification
 *
 * This is the employer-facing verification workflow.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/client.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import {
  decryptCodePayload,
  generateNonce,
  verifyEd25519Signature,
} from '../../utils/crypto.js';

// ─── Validation Schemas ───────────────────────────────────────────────────────

const verifyCodeSchema = z.object({
  authenx_code: z.string().min(1),
});

const verifyLiveSchema = z.object({
  token_id: z.string().min(1),
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConnectorVerifyResponse {
  request_id: string;
  nonce: string;
  result_status: 'verified' | 'revoked' | 'mismatch' | 'unavailable';
  issued_hash_match: boolean;
  current_hash: string;
  approved_display_fields?: {
    name?: string;
    degree?: string;
    branch?: string;
    graduation_year?: string;
    cgpa?: string;
  };
  credential_status: string;
  responded_at: string;
  live_signature: string;
}

// ─── Route Plugin ─────────────────────────────────────────────────────────────

export async function verifyRoutes(fastify: FastifyInstance) {

  // ── POST /v1/verify/code ───────────────────────────────────────────────────
  // Step 1: Employer scans AuthenX Code — decode and retrieve token info.
  // Does NOT yet call the connector. Just confirms the code is valid.

  fastify.post('/code', {
    preHandler: [requireAuth, requireRole('employer', 'super_admin')],
  }, async (request, reply) => {
    const body = verifyCodeSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }

    // ── 1. Decrypt the AuthenX Code ───────────────────────────────────────
    let codePayload;
    try {
      codePayload = decryptCodePayload(body.data.authenx_code);
    } catch {
      return reply.status(400).send({
        error: 'INVALID_CODE',
        message: 'The AuthenX Code is invalid or has been tampered with',
      });
    }

    // ── 2. Look up the token ───────────────────────────────────────────────
    const { rows } = await db.query(
      `SELECT vt.id, vt.token_id, vt.issuer_id, vt.credential_type,
              vt.token_status, vt.revocation_status, vt.issued_at,
              c.name AS college_name, c.issuer_code, c.status AS college_status
       FROM verification_tokens vt
       JOIN colleges c ON c.id = vt.issuer_id
       WHERE vt.token_id = $1`,
      [codePayload.t]
    );

    if (!rows[0]) {
      return reply.status(404).send({
        error: 'TOKEN_NOT_FOUND',
        message: 'No credential found for this AuthenX Code',
      });
    }

    const token = rows[0];

    // ── 3. Check revocation before going to connector ─────────────────────
    if (token.token_status === 'revoked') {
      return reply.status(200).send({
        result: 'revoked',
        message: 'This credential has been revoked by the issuing institution',
        college: token.college_name,
        credential_type: token.credential_type,
        issued_at: token.issued_at,
      });
    }

    return reply.status(200).send({
      result: 'code_valid',
      token_id: token.token_id,
      college: token.college_name,
      issuer_code: token.issuer_code,
      credential_type: token.credential_type,
      issued_at: token.issued_at,
      message: 'Code decoded. Call /verify/live to run live connector verification.',
    });
  });

  // ── POST /v1/verify/live ───────────────────────────────────────────────────
  // Step 2: Trigger live verification against the college connector.
  // This is the critical step that makes AuthenX different from document checking.

  fastify.post('/live', {
    preHandler: [requireAuth, requireRole('employer', 'super_admin')],
  }, async (request, reply) => {
    const body = verifyLiveSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }

    const startTime = Date.now();

    // ── 1. Get token and connector info ───────────────────────────────────
    const { rows } = await db.query(
      `SELECT vt.id, vt.token_id, vt.issuer_id, vt.credential_reference_token,
              vt.issued_hash, vt.token_status, vt.credential_type,
              c.connector_endpoint, c.public_key, c.name AS college_name, c.status AS college_status
       FROM verification_tokens vt
       JOIN colleges c ON c.id = vt.issuer_id
       WHERE vt.token_id = $1`,
      [body.data.token_id]
    );

    if (!rows[0]) {
      return reply.status(404).send({ error: 'TOKEN_NOT_FOUND' });
    }

    const token = rows[0];
    const requestId = 'req_' + uuidv4().replace(/-/g, '');
    const nonce = generateNonce();

    // ── 2. Log the verification request ───────────────────────────────────
    await db.query(
      `INSERT INTO verification_requests
         (request_id, token_id, employer_id, nonce, result_status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [requestId, token.id, request.user!.sub, nonce]
    );

    // ── 3. Call the college connector ─────────────────────────────────────
    let connectorResponse: ConnectorVerifyResponse;

    try {
      const response = await fetch(`${token.connector_endpoint}/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AuthenX-Secret': process.env.CONNECTOR_SECRET ?? '',
        },
        body: JSON.stringify({
          request_id: requestId,
          token_id: token.token_id,
          credential_reference_token: token.credential_reference_token,
          nonce,
          issuer_id: token.issuer_id,
          requested_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),  // 10 second timeout
      });

      if (!response.ok) {
        throw new Error(`Connector returned HTTP ${response.status}`);
      }

      connectorResponse = await response.json() as ConnectorVerifyResponse;
    } catch (err) {
      const latency = Date.now() - startTime;

      // Update request log
      await db.query(
        `UPDATE verification_requests
         SET result_status = 'unavailable', responded_at = NOW(), latency_ms = $1
         WHERE request_id = $2`,
        [latency, requestId]
      );

      return reply.status(200).send({
        result: 'unavailable',
        message: 'The college connector is temporarily unavailable. Try again shortly.',
        request_id: requestId,
      });
    }

    const latency = Date.now() - startTime;

    // ── 4. Validate nonce binding ──────────────────────────────────────────
    if (connectorResponse.nonce !== nonce) {
      await db.query(
        `UPDATE verification_requests SET result_status = 'mismatch', responded_at = NOW(), latency_ms = $1 WHERE request_id = $2`,
        [latency, requestId]
      );
      return reply.status(200).send({
        result: 'mismatch',
        message: 'Nonce mismatch — response may not be fresh',
      });
    }

    // ── 5. Verify the connector's live signature ───────────────────────────
    const responsePayload = JSON.stringify({
      result_status: connectorResponse.result_status,
      issued_hash_match: connectorResponse.issued_hash_match,
      current_hash: connectorResponse.current_hash,
      approved_display_fields: connectorResponse.approved_display_fields,
      credential_status: connectorResponse.credential_status,
      responded_at: connectorResponse.responded_at,
      nonce: connectorResponse.nonce,
    });

    const isSignatureValid = verifyEd25519Signature(
      responsePayload,
      connectorResponse.live_signature,
      token.public_key
    );

    if (!isSignatureValid) {
      await db.query(
        `UPDATE verification_requests SET result_status = 'mismatch', responded_at = NOW(), latency_ms = $1 WHERE request_id = $2`,
        [latency, requestId]
      );
      return reply.status(200).send({
        result: 'mismatch',
        message: 'Live verification signature is invalid — connector response may be tampered',
      });
    }

    // ── 6. Update audit log ────────────────────────────────────────────────
    await db.query(
      `UPDATE verification_requests
       SET result_status = $1, responded_at = NOW(), latency_ms = $2, connector_signature = $3
       WHERE request_id = $4`,
      [connectorResponse.result_status, latency, connectorResponse.live_signature, requestId]
    );

    // ── 7. Return result — show minimal approved fields, do NOT persist them ─
    return reply.status(200).send({
      result: connectorResponse.result_status,
      request_id: requestId,
      college: token.college_name,
      credential_type: token.credential_type,
      verified_at: connectorResponse.responded_at,
      latency_ms: latency,
      // Fields below are from live connector, shown transiently, not stored:
      ...(connectorResponse.result_status === 'verified' && {
        candidate: connectorResponse.approved_display_fields,
        signatures: {
          live_verification: 'VALID',
          issuer: token.college_name,
          source: 'Live ERP verification',
        },
      }),
    });
  });
}
