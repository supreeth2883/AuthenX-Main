/**
 * AuthenX API — Logger
 *
 * Centralized logger using Pino (built into Fastify).
 * In development: pretty-printed with colors.
 * In production: JSON lines for log aggregation.
 */

import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  }),
});

export type Logger = typeof logger;
