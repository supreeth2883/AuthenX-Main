/**
 * AuthenX API — Authentication Middleware
 *
 * JWT verification and Role-Based Access Control (RBAC).
 * All protected routes use these hooks.
 *
 * Usage in a route:
 *   fastify.get('/admin/data', {
 *     preHandler: [requireAuth, requireRole('super_admin')]
 *   }, handler)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

export type UserRole =
  | 'super_admin'
  | 'college_admin'
  | 'issuer_operator'
  | 'employer'
  | 'auditor';

// ─── JWT Payload Type ─────────────────────────────────────────────────────────
// This is what gets decoded from the JWT token.
export interface JwtPayload {
  sub: string;         // user ID (UUID)
  email: string;
  role: UserRole;
  entity_id?: string;  // college_id or employer_org_id
  iat: number;
  exp: number;
}

// ─── Augment FastifyRequest to include authenticated user ─────────────────────
declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}

// ─── requireAuth ──────────────────────────────────────────────────────────────
/**
 * Verifies the JWT token in the Authorization header.
 * Sets request.user on success. Returns 401 if missing or invalid.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
    request.user = request.user as JwtPayload;
  } catch {
    reply.status(401).send({
      error: 'UNAUTHORIZED',
      message: 'Valid authentication token required',
    });
  }
}

// ─── requireRole ──────────────────────────────────────────────────────────────
/**
 * Returns a preHandler that checks if the authenticated user has one of the
 * allowed roles. Must be used AFTER requireAuth.
 *
 * Usage:
 *   preHandler: [requireAuth, requireRole('super_admin', 'college_admin')]
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return async function (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (!request.user) {
      reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Not authenticated' });
      return;
    }

    if (!allowedRoles.includes(request.user.role)) {
      reply.status(403).send({
        error: 'FORBIDDEN',
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}`,
      });
    }
  };
}

// ─── requireSameCollege ───────────────────────────────────────────────────────
/**
 * Ensures a college_admin or issuer_operator can only access their own college's data.
 * Super admins bypass this check.
 */
export function requireSameCollege(getCollegeId: (req: FastifyRequest) => string) {
  return async function (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (!request.user) {
      reply.status(401).send({ error: 'UNAUTHORIZED' });
      return;
    }
    if (request.user.role === 'super_admin') return; // Bypass for super admin

    const collegeId = getCollegeId(request);
    if (request.user.entity_id !== collegeId) {
      reply.status(403).send({
        error: 'FORBIDDEN',
        message: 'You can only access your own college data',
      });
    }
  };
}
