import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import type { AccessTokenClaims } from '../identity/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AccessTokenClaims;
  }
}

const bearerToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length === 0 ? null : token;
};

/** Populates `request.authUser` if a valid access token is present; never rejects the request. */
export const optionalAuth =
  (ctx: AppContext) =>
  async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (token === null) return;
    const claims = await ctx.identity.verifyAccessToken(token);
    if (claims !== null) request.authUser = claims;
  };

/** Requires a valid access token; replies 401 otherwise. */
export const requireAuth =
  (ctx: AppContext) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (token === null) {
      await reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Missing bearer token.' } });
      return;
    }
    const claims = await ctx.identity.verifyAccessToken(token);
    if (claims === null) {
      await reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token.' } });
      return;
    }
    request.authUser = claims;
  };
