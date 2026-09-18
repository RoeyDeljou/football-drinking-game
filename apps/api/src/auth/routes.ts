import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { IdentityError } from '../identity/types.js';
import { requireAuth } from './plugin.js';
import { loginBodySchema, logoutBodySchema, refreshBodySchema, registerBodySchema } from './schemas.js';

const IDENTITY_ERROR_STATUS: Record<string, number> = {
  EMAIL_TAKEN: 409,
  AGE_NOT_CONFIRMED: 422,
  INVALID_CREDENTIALS: 401,
  INVALID_REFRESH_TOKEN: 401,
  REFRESH_TOKEN_REUSED: 401,
  USER_NOT_FOUND: 404,
};

export const registerAuthRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  app.post('/auth/register', async (request, reply) => {
    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: parsed.error.message } });
    }
    try {
      const session = await ctx.identity.register(parsed.data);
      return reply.code(201).send(session);
    } catch (error) {
      return sendIdentityError(reply, error);
    }
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: parsed.error.message } });
    }
    try {
      const session = await ctx.identity.login(parsed.data);
      return reply.send(session);
    } catch (error) {
      return sendIdentityError(reply, error);
    }
  });

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = refreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: parsed.error.message } });
    }
    try {
      const session = await ctx.identity.refresh(parsed.data.refreshToken);
      return reply.send(session);
    } catch (error) {
      return sendIdentityError(reply, error);
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const parsed = logoutBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: parsed.error.message } });
    }
    await ctx.identity.logout(parsed.data.refreshToken);
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: requireAuth(ctx) }, async (request, reply) => {
    if (request.authUser === undefined) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Missing bearer token.' } });
    }
    const user = await ctx.identity.getUser(request.authUser.sub);
    if (user === null) {
      return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message: 'User no longer exists.' } });
    }
    return reply.send({ user });
  });
};

const sendIdentityError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof IdentityError) {
    const status = IDENTITY_ERROR_STATUS[error.code] ?? 400;
    return reply.code(status).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
};
