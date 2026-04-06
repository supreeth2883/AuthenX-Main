/**
 * AuthenX API — Environment Configuration
 *
 * All environment variables are loaded and validated here.
 * If a required variable is missing, the app will CRASH on startup — intentionally.
 * This prevents running with bad config silently.
 */

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

// ─── Schema: Define all required and optional env vars ───────────────────────
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),

  API_PORT: z.string().default('3001').transform(Number),
  API_HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MIN: z.string().default('2').transform(Number),
  DATABASE_POOL_MAX: z.string().default('10').transform(Number),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  CONNECTOR_SECRET: z.string().min(32, 'CONNECTOR_SECRET must be at least 32 characters'),
  AUTHENX_CODE_ENCRYPTION_KEY: z.string().length(64, 'AUTHENX_CODE_ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  RATE_LIMIT_MAX: z.string().default('100').transform(Number),
  RATE_LIMIT_WINDOW_MS: z.string().default('60000').transform(Number),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

// ─── Parse and validate ───────────────────────────────────────────────────────
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ AuthenX API: Invalid environment configuration');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);  // Hard stop — do not run with broken config
}

export const env = parsed.data;

export const isDev = env.NODE_ENV === 'development';
export const isProd = env.NODE_ENV === 'production';
