/**
 * AuthenX API — Authentication Routes
 *
 * POST /v1/auth/login      — Login with email + password, get JWT
 * POST /v1/auth/refresh    — Refresh JWT using refresh token
 * POST /v1/auth/logout     — Invalidate refresh token
 * GET  /v1/auth/me         — Get current authenticated user info
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '../../db/client.js';
import { requireAuth } from '../../middleware/auth.js';
import type { JwtPayload, UserRole } from '../../middleware/auth.js';

// ─── Validation Schemas ───────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

// ─── Route Plugin ─────────────────────────────────────────────────────────────

export async function authRoutes(fastify: FastifyInstance) {

  // ── POST /v1/auth/login ────────────────────────────────────────────────────
  fastify.post('/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        details: body.error.flatten(),
      });
    }

    const { email, password } = body.data;

    // Look up user
    const { rows } = await db.query(
      `SELECT id, email, password_hash, role, linked_entity_id, status, full_name
       FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    const user = rows[0];

    // Timing-safe: always run bcrypt even if user not found (prevents timing attacks)
    const passwordHash = user?.password_hash ?? '$2b$12$invalid.hash.to.prevent.timing';
    const isValidPassword = await bcrypt.compare(password, passwordHash);

    if (!user || !isValidPassword || user.status !== 'active') {
      return reply.status(401).send({
        error: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect',
      });
    }

    // Sign JWT
    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: user.id,
      email: user.email,
      role: user.role as UserRole,
      entity_id: user.linked_entity_id ?? undefined,
    };

    const token = fastify.jwt.sign(payload, { expiresIn: '15m' });

    // Update last login
    await db.query(
      'UPDATE users SET last_login_at = NOW() WHERE id = $1',
      [user.id]
    );

    return reply.status(200).send({
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        entity_id: user.linked_entity_id,
      },
    });
  });

  // ── GET /v1/auth/me ────────────────────────────────────────────────────────
  fastify.get('/me', {
    preHandler: [requireAuth],
  }, async (request, reply) => {
    const userId = request.user!.sub;

    const { rows } = await db.query(
      'SELECT id, email, full_name, role, linked_entity_id, status, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (!rows[0]) {
      return reply.status(404).send({ error: 'USER_NOT_FOUND' });
    }

    return reply.status(200).send({ user: rows[0] });
  });

}
