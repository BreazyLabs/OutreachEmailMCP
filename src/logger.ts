import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'access_token',
      'refresh_token',
      '*.access_token',
      '*.refresh_token',
      'req.headers.authorization',
      'headers.authorization',
    ],
    censor: '[redacted]',
  },
  transport: process.stdout.isTTY
    ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
});
