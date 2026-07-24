import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { verifyAccessToken } from '../modules/auth/auth.service.js';

let io: Server | null = null;

/**
 * Live feed for the office dashboard. Handshake requires a valid access
 * token with an office role (admin/manager); collectors are refused.
 * Events are notifications only — never sources of truth.
 */
export function initRealtime(server: HttpServer): void {
  io = new Server(server, {
    cors: {
      origin: env.FRONTEND_ORIGIN === '*' ? '*' : env.FRONTEND_ORIGIN.split(','),
    },
  });

  io.use((socket, next) => {
    try {
      const token = (socket.handshake.auth as Record<string, unknown>).token;
      if (typeof token !== 'string') throw new Error('missing token');
      const payload = verifyAccessToken(token);
      if (payload.role !== 'admin' && payload.role !== 'manager') {
        next(new Error('FORBIDDEN'));
        return;
      }
      (socket.data as { auth?: unknown }).auth = payload;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    void socket.join('admin');
  });
}

/**
 * Fire-and-forget notify to the admin room. Never throws — a socket
 * problem must not affect the request that triggered the event. Call
 * AFTER a transaction commits, never inside one.
 */
export function emitAdminEvent(event: string, payload: unknown): void {
  try {
    io?.to('admin').emit(event, payload);
  } catch (err) {
    logger.warn({ err, event }, 'socket emit failed');
  }
}

export async function stopRealtime(): Promise<void> {
  if (io) {
    await io.close();
    io = null;
  }
}
