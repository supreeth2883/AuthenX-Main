/**
 * AuthenX API — Verification Token Routes
 *
 * POST /v1/issuer/token/issue   — Issue a new credential proof token
 * POST /v1/issuer/token/revoke  — Revoke a credential token
 * GET  /v1/issuer/token/:id     — Get token status
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../db/client.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import {
  verifyEd25519Signature,
  encryptCodePayload,
} from '../../utils/crypto.js';

// ─── Validation Schemas ───────────────────────────────────────────────────────

const issueTokenSchema = z.object({
  issuer_id: z.string().uuid(),
  credential_reference_token: z.string().min(1),
  issued_hash: z.string().length(64),                  // SHA-256 hex = 64 chars
  issuance_signature: z.string().min(1),               // Base64 Ed25519 signature
  schema_version: z.string().default('1.0'),
  credential_type: z.string().min(1),
  issued_at: z.string().datetime(),
});

const revokeTokenSchema = z.object({
  token_id: z.string().min(1),
  reason: z.string().optional(),
  replacement_token_id: z.string().optional(),
});

// ─── Route Plugin ─────────────────────────────────────────────────────────────

export async function tokenRoutes(fastify: FastifyInstance) {

  // ── POST /v1/issuer/token/issue ────────────────────────────────────────────
  fastify.post('/issue', {
    preHandler: [requireAuth, requireRole('issuer_operator', 'college_admin', 'super_admin')],
  }, async (request, reply) => {
    const body = issueTokenSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        details: body.error.flatten(),
      });
    }

    const {
      issuer_id,
      credential_reference_token,
      issued_hash,
      issuance_signature,
      schema_version,
      credential_type,
      issued_at,
    } = body.data;

    // ── 1. Verify the issuer exists and is active ─────────────────────────
    const { rows: colleges } = await db.query(
      'SELECT id, public_key, status FROM colleges WHERE id = $1',
      [issuer_id]
    );

    if (!colleges[0]) {
      return reply.status(404).send({ error: 'ISSUER_NOT_FOUND' });
    }
    if (colleges[0].status !== 'active') {
      return reply.status(403).send({ error: 'ISSUER_NOT_ACTIVE' });
    }

    // ── 2. Verify the issuance signature from the connector ───────────────
    const isSignatureValid = verifyEd25519Signature(
      issued_hash,
      issuance_signature,
      colleges[0].public_key
    );

    if (!isSignatureValid) {
      return reply.status(400).send({
        error: 'INVALID_SIGNATURE',
        message: 'Issuance signature verification failed. The hash may be tampered.',
      });
    }

    // ── 3. Create proof token ─────────────────────────────────────────────
    const tokenId = 'tok_' + uuidv4().replace(/-/g, '');  // Opaque token ID

    // ── 4. Generate AuthenX Code (encrypted payload) ──────────────────────
    const codePayload = {
      v: 1,
      t: tokenId,
      i: issuer_id.substring(0, 8),  // Partial issuer hint, not full ID
      ts: Math.floor(new Date(issued_at).getTime() / 1000),
    };
    const authenxCode = encryptCodePayload(codePayload);

    // ── 5. Store proof token ──────────────────────────────────────────────
    const { rows: token } = await db.query(
      `INSERT INTO verification_tokens
         (token_id, issuer_id, credential_reference_token, issued_hash,
          issuance_signature, schema_version, credential_type, issued_at,
          token_status, authenx_code_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
       RETURNING id, token_id, issued_at, token_status, authenx_code_ref`,
      [
        tokenId,
        issuer_id,
        credential_reference_token,
        issued_hash,
        issuance_signature,
        schema_version,
        credential_type,
        issued_at,
        authenxCode,
      ]
    );

    return reply.status(201).send({
      message: 'Credential proof token issued successfully',
      token_id: token[0].token_id,
      authenx_code: token[0].authenx_code_ref,  // This is what the student shares
      issued_at: token[0].issued_at,
      status: token[0].token_status,
    });
  });

  // ── POST /v1/issuer/token/revoke ───────────────────────────────────────────
  fastify.post('/revoke', {
    preHandler: [requireAuth, requireRole('issuer_operator', 'college_admin', 'super_admin')],
  }, async (request, reply) => {
    const body = revokeTokenSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'VALIDATION_ERROR', details: body.error.flatten() });
    }

    const { token_id, reason, replacement_token_id } = body.data;

    // Check token exists
    const { rows } = await db.query(
      'SELECT id, issuer_id, token_status FROM verification_tokens WHERE token_id = $1',
      [token_id]
    );

    if (!rows[0]) {
      return reply.status(404).send({ error: 'TOKEN_NOT_FOUND' });
    }
    if (rows[0].token_status === 'revoked') {
      return reply.status(409).send({ error: 'ALREADY_REVOKED' });
    }

    // Mark as revoked
    await db.query(
      `UPDATE verification_tokens
       SET token_status = 'revoked', revocation_status = TRUE, updated_at = NOW()
       WHERE token_id = $1`,
      [token_id]
    );

    // Log revocation event
    await db.query(
      `INSERT INTO revocation_events (token_id, issuer_id, reason, replacement_token_id, created_by)
       VALUES ($1, $2, $3, (SELECT id FROM verification_tokens WHERE token_id = $4), $5)`,
      [rows[0].id, rows[0].issuer_id, reason ?? null, replacement_token_id ?? null, request.user!.sub]
    );

    return reply.status(200).send({
      message: 'Token revoked successfully',
      token_id,
      revoked_at: new Date().toISOString(),
    });
  });

  // ── GET /v1/issuer/token/:tokenId ──────────────────────────────────────────
  fastify.get('/:tokenId', {
    preHandler: [requireAuth, requireRole('issuer_operator', 'college_admin', 'super_admin', 'auditor')],
  }, async (request, reply) => {
    const { tokenId } = request.params as { tokenId: string };

    const { rows } = await db.query(
      `SELECT vt.token_id, vt.issuer_id, vt.credential_type, vt.schema_version,
              vt.token_status, vt.revocation_status, vt.issued_at, vt.created_at,
              c.name AS college_name, c.issuer_code
       FROM verification_tokens vt
       JOIN colleges c ON c.id = vt.issuer_id
       WHERE vt.token_id = $1`,
      [tokenId]
    );

    if (!rows[0]) {
      return reply.status(404).send({ error: 'TOKEN_NOT_FOUND' });
    }

    return reply.status(200).send({ token: rows[0] });
  });
}
