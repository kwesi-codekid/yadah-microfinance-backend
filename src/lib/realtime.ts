import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { verifyAccessToken } from '../modules/auth/auth.service.js';

let io: Server | null = null;

/**
 * Live feed. Every authenticated staff member connects — collectors included,
 * since they now receive their own notifications — and each socket joins a
 * private `user:<id>` room. Office roles additionally join `admin`, which
 * carries the whole-business dashboard feed.
 *
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
      (socket.data as { auth?: unknown }).auth = payload;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const auth = (socket.data as { auth?: { sub: string; role: string } }).auth;
    if (!auth) return;
    void socket.join(userRoom(auth.sub));
    // The dashboard feed stays office-only: a collector must not see the
    // whole business, only what concerns them.
    if (auth.role === 'admin' || auth.role === 'manager') void socket.join('admin');
  });
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

/**
 * Fire-and-forget notify to the admin room. Never throws — a socket problem
 * must not affect the request that triggered the event. Call AFTER a
 * transaction commits, never inside one.
 */
export function emitAdminEvent(event: string, payload: unknown): void {
  try {
    io?.to('admin').emit(event, payload);
  } catch (err) {
    logger.warn({ err, event }, 'socket emit failed');
  }
}

/** Same contract as emitAdminEvent, but addressed to specific staff members. */
export function emitToUsers(userIds: string[], event: string, payload: unknown): void {
  if (userIds.length === 0) return;
  try {
    io?.to(userIds.map(userRoom)).emit(event, payload);
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
