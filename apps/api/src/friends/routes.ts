import type { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/plugin.js';
import type { AppContext } from '../context.js';
import {
  friendshipIdParamsSchema,
  inviteBodySchema,
  removeFriendParamsSchema,
  searchQuerySchema,
  sendRequestBodySchema,
} from './schemas.js';

const publicUser = (user: { id: string; displayName: string; email: string }) => ({
  id: user.id,
  displayName: user.displayName,
  email: user.email,
});

/** Search results deliberately omit `email` — unlike a friends list (where both parties already
 * know each other), search is reachable by any authenticated user against the whole user table,
 * and a partial-match search on `email` would let someone harvest addresses letter by letter. */
const searchResultUser = (user: { id: string; displayName: string }) => ({
  id: user.id,
  displayName: user.displayName,
});

/** `requireAuth` (the route's `preHandler`) already guarantees `request.authUser` is set; this
 * just narrows it explicitly instead of asserting with `!`, matching `auth/routes.ts`. Every route
 * below is registered with `{ preHandler: auth }`, so `undefined` here would mean the preHandler
 * itself has a bug, not a legitimate request — hence the 401 fallback instead of a thrown error. */
const requireAuthUser = (request: FastifyRequest, reply: FastifyReply): string | null => {
  if (request.authUser === undefined) {
    void reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Missing bearer token.' } });
    return null;
  }
  return request.authUser.sub;
};

export const registerFriendsRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  const auth = requireAuth(ctx);

  app.get('/users/search', { preHandler: auth }, async (request, reply) => {
    const me = requireAuthUser(request, reply);
    if (me === null) return reply;
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_QUERY', message: parsed.error.message } });
    }
    const users = await ctx.prisma.user.findMany({
      where: {
        id: { not: me },
        displayName: { contains: parsed.data.q },
      },
      take: 20,
      orderBy: { displayName: 'asc' },
    });
    return reply.send({ users: users.map(searchResultUser) });
  });

  app.get('/friends', { preHandler: auth }, async (request, reply) => {
    const me = requireAuthUser(request, reply);
    if (me === null) return reply;
    const friendships = await ctx.prisma.friendship.findMany({
      where: { status: 'ACCEPTED', OR: [{ requesterId: me }, { addresseeId: me }] },
      include: { requester: true, addressee: true },
    });
    const friends = friendships.map((entry) => (entry.requesterId === me ? entry.addressee : entry.requester));
    return reply.send({ friends: friends.map(publicUser) });
  });

  app.get('/friends/requests', { preHandler: auth }, async (request, reply) => {
    const me = requireAuthUser(request, reply);
    if (me === null) return reply;
    const incoming = await ctx.prisma.friendship.findMany({
      where: { addresseeId: me, status: 'PENDING' },
      include: { requester: true },
    });
    const outgoing = await ctx.prisma.friendship.findMany({
      where: { requesterId: me, status: 'PENDING' },
      include: { addressee: true },
    });
    return reply.send({
      incoming: incoming.map((entry) => ({ requestId: entry.id, user: publicUser(entry.requester) })),
      outgoing: outgoing.map((entry) => ({ requestId: entry.id, user: publicUser(entry.addressee) })),
    });
  });

  app.post('/friends/requests', { preHandler: auth }, async (request, reply) => {
    const me = requireAuthUser(request, reply);
    if (me === null) return reply;
    const parsed = sendRequestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: parsed.error.message } });
    }
    const targetUserId = parsed.data.targetUserId;
    if (targetUserId === me) {
      return reply.code(400).send({ error: { code: 'CANNOT_FRIEND_SELF', message: 'Cannot friend yourself.' } });
    }
    const target = await ctx.prisma.user.findUnique({ where: { id: targetUserId } });
    if (target === null) {
      return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message: 'No such user.' } });
    }
    const existing = await ctx.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: me, addresseeId: targetUserId },
          { requesterId: targetUserId, addresseeId: me },
        ],
      },
    });
    if (existing !== null) {
      return reply.code(409).send({ error: { code: 'FRIENDSHIP_EXISTS', message: `Already ${existing.status.toLowerCase()}.` } });
    }
    const created = await ctx.prisma.friendship.create({
      data: { requesterId: me, addresseeId: targetUserId, status: 'PENDING' },
    });
    return reply.code(201).send({ requestId: created.id });
  });

  app.post('/friends/requests/:requestId/accept', { preHandler: auth }, async (request, reply) => {
    const me = requireAuthUser(request, reply);
    if (me === null) return reply;
    const parsed = friendshipIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_PARAMS', message: parsed.error.message } });
    }
    const friendship = await ctx.prisma.friendship.findUnique({ where: { id: parsed.data.requestId } });
    if (friendship === null || friendship.addresseeId !== me || friendship.status !== 'PENDING') {
      return reply.code(404).send({ error: { code: 'REQUEST_NOT_FOUND', message: 'No such pending request.' } });
    }
    await ctx.prisma.friendship.update({ where: { id: friendship.id }, data: { status: 'ACCEPTED' } });
    return reply.send({ ok: true });
  });

  app.post('/friends/requests/:requestId/decline', { preHandler: auth }, async (request, reply) => {
    const me = requireAuthUser(request, reply);
    if (me === null) return reply;
    const parsed = friendshipIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_PARAMS', message: parsed.error.message } });
    }
    const friendship = await ctx.prisma.friendship.findUnique({ where: { id: parsed.data.requestId } });
    if (friendship === null || friendship.addresseeId !== me || friendship.status !== 'PENDING') {
      return reply.code(404).send({ error: { code: 'REQUEST_NOT_FOUND', message: 'No such pending request.' } });
    }
    await ctx.prisma.friendship.update({ where: { id: friendship.id }, data: { status: 'DECLINED' } });
    return reply.send({ ok: true });
  });

  app.delete('/friends/:friendUserId', { preHandler: auth }, async (request, reply) => {
    const me = requireAuthUser(request, reply);
    if (me === null) return reply;
    const parsed = removeFriendParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_PARAMS', message: parsed.error.message } });
    }
    await ctx.prisma.friendship.deleteMany({
      where: {
        OR: [
          { requesterId: me, addresseeId: parsed.data.friendUserId },
          { requesterId: parsed.data.friendUserId, addresseeId: me },
        ],
      },
    });
    return reply.code(204).send();
  });

  /** Minimal invite: verifies the friendship and the room, and hands back joinable info. Actual
   * delivery (push notification, in-app inbox) is out of scope for Phase 3 — the client sends the
   * PIN/link through whatever channel it likes (share sheet, chat, etc). */
  app.post('/friends/invite', { preHandler: auth }, async (request, reply) => {
    const me = requireAuthUser(request, reply);
    if (me === null) return reply;
    const parsed = inviteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: parsed.error.message } });
    }
    const friendship = await ctx.prisma.friendship.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: me, addresseeId: parsed.data.friendUserId },
          { requesterId: parsed.data.friendUserId, addresseeId: me },
        ],
      },
    });
    if (friendship === null) {
      return reply.code(403).send({ error: { code: 'NOT_FRIENDS', message: 'You are not friends with this user.' } });
    }
    const room = await ctx.prisma.room.findUnique({ where: { pin: parsed.data.roomPin } });
    if (room === null) {
      return reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'No such room.' } });
    }
    return reply.send({ roomId: room.id, pin: room.pin, joinUrl: `/join/${room.pin}` });
  });
};
