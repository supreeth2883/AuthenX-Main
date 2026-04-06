/**
 * AuthenX API — Fastify Application Setup
 *
 * This file creates and configures the Fastify instance with all plugins,
 * middleware, and routes. It does NOT start the server — that happens in index.ts.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';

import { env, isDev } from './config/env.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { tokenRoutes } from './modules/tokens/tokens.routes.js';
import { verifyRoutes } from './modules/verify/verify.routes.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(isDev && {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
    },
  });

  // ─── Security Headers ────────────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: isDev ? false : undefined,
  });

  // ─── CORS ────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: isDev ? true : ['https://app.authenx.in'],
    credentials: true,
  });

  // ─── Rate Limiting ───────────────────────────────────────────────────────
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: () => ({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please try again shortly.',
    }),
  });

  // ─── JWT ─────────────────────────────────────────────────────────────────
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  });

  // ─── Health Check (no auth required) ─────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    service: 'authenx-api',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
  }));

  // ─── API Routes (versioned) ───────────────────────────────────────────────
  app.register(authRoutes,   { prefix: '/v1/auth' });
  app.register(tokenRoutes,  { prefix: '/v1/issuer/token' });
  app.register(verifyRoutes, { prefix: '/v1/verify' });

  // ─── 404 Handler ─────────────────────────────────────────────────────────
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: 'NOT_FOUND',
      message: 'The requested endpoint does not exist',
    });
  });

  // ─── Global Error Handler ─────────────────────────────────────────────────
  app.setErrorHandler((err, _request, reply) => {
    app.log.error(err);
    const status = err.statusCode ?? 500;
    reply.status(status).send({
      error: status === 500 ? 'INTERNAL_SERVER_ERROR' : err.code ?? 'ERROR',
      message: isDev ? err.message : 'An unexpected error occurred',
    });
  });

  return app;
}
