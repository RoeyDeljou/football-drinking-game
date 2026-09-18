import * as argon2 from 'argon2';
import type { PrismaClient } from '../db/client.js';
import { buildTokenConfig, generateRefreshTokenValue, hashRefreshToken, signAccessToken } from './tokens.js';
import { verifyAccessToken as verifyAccessTokenJwt } from './tokens.js';
import type {
  AccessTokenClaims,
  AuthSession,
  AuthTokens,
  IdentityProvider,
  LoginInput,
  PublicUser,
  RegisterInput,
} from './types.js';
import { IdentityError } from './types.js';

const RESPONSIBLE_DRINKING_MESSAGE =
  'This game involves alcohol-themed content. Please drink responsibly, know your limits, and never drink and drive.';

/**
 * A precomputed argon2id hash of an arbitrary constant, used only to burn the same amount of CPU
 * time an unknown-email login would otherwise skip. Without this, `login` returns in ~15ms for an
 * unknown email (no hash to check) vs ~80ms for a known one (a real `argon2.verify` call) — a timing
 * oracle an attacker can use to enumerate registered emails without ever guessing a password.
 * Computed once, lazily, and shared by every miss so the constant-time behaviour costs one hash
 * globally rather than one per request.
 */
let dummyHash: Promise<string> | null = null;
const getDummyHash = (): Promise<string> => {
  dummyHash ??= argon2.hash('timing-safety-placeholder-password', { type: argon2.argon2id });
  return dummyHash;
};

export interface LocalIdentityProviderOptions {
  readonly prisma: PrismaClient;
  readonly jwtAccessSecret: string;
  readonly jwtRefreshSecret: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
}

const toPublicUser = (user: {
  id: string;
  email: string;
  displayName: string;
  ageConfirmed18: boolean;
  createdAt: Date;
}): PublicUser => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  ageConfirmed18: user.ageConfirmed18,
  createdAt: user.createdAt.toISOString(),
});

/** The default `IdentityProvider`: email + password, argon2id, rotating refresh tokens. */
export class LocalIdentityProvider implements IdentityProvider {
  private readonly prisma: PrismaClient;
  private readonly tokenConfig: ReturnType<typeof buildTokenConfig>;

  constructor(options: LocalIdentityProviderOptions) {
    this.prisma = options.prisma;
    this.tokenConfig = buildTokenConfig({
      accessSecret: options.jwtAccessSecret,
      refreshSecret: options.jwtRefreshSecret,
      accessTtlSeconds: options.accessTtlSeconds,
      refreshTtlSeconds: options.refreshTtlSeconds,
    });
  }

  async register(input: RegisterInput): Promise<AuthSession> {
    if (!input.ageConfirmed18) {
      throw new IdentityError('AGE_NOT_CONFIRMED', 'You must confirm you are 18 or older to register.');
    }
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing !== null) {
      throw new IdentityError('EMAIL_TAKEN', 'An account with this email already exists.');
    }

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const user = await this.prisma.user.create({
      data: {
        email,
        displayName: input.displayName.trim(),
        ageConfirmed18: true,
        credential: { create: { passwordHash } },
      },
    });

    return this.issueSession(user);
  }

  async login(input: LoginInput): Promise<AuthSession> {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email }, include: { credential: true } });
    if (user === null || user.credential === null) {
      // Still pay the argon2 cost on a miss, against a fixed dummy hash, so the response time does
      // not reveal whether `email` belongs to a real account.
      await argon2.verify(await getDummyHash(), input.password).catch(() => false);
      throw new IdentityError('INVALID_CREDENTIALS', 'Invalid email or password.');
    }
    const valid = await argon2.verify(user.credential.passwordHash, input.password);
    if (!valid) {
      throw new IdentityError('INVALID_CREDENTIALS', 'Invalid email or password.');
    }
    return this.issueSession(user);
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const hash = hashRefreshToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (record === null) {
      throw new IdentityError('INVALID_REFRESH_TOKEN', 'Refresh token is unknown.');
    }
    if (record.revokedAt !== null) {
      // Reuse of an already-rotated token is a strong signal of theft: revoke the whole chain for
      // this user rather than trusting a single token id.
      await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new IdentityError('REFRESH_TOKEN_REUSED', 'Refresh token was already used; all sessions revoked.');
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new IdentityError('INVALID_REFRESH_TOKEN', 'Refresh token has expired.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    if (user === null) {
      throw new IdentityError('USER_NOT_FOUND', 'User for this refresh token no longer exists.');
    }

    const rotated = generateRefreshTokenValue();
    const expiresAt = new Date(Date.now() + this.tokenConfig.refreshTtlSeconds * 1000);
    const [, created] = await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: record.id },
        data: { revokedAt: new Date() },
      }),
      this.prisma.refreshToken.create({
        data: { userId: user.id, tokenHash: rotated.hash, expiresAt },
      }),
    ]);
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { replacedByTokenId: created.id },
    });

    const access = await signAccessToken({ sub: user.id, email: user.email, displayName: user.displayName }, this.tokenConfig);
    const tokens: AuthTokens = {
      accessToken: access.token,
      refreshToken: rotated.value,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshTokenExpiresAt: expiresAt.toISOString(),
    };
    return { user: toPublicUser(user), tokens, responsibleDrinkingNotice: this.notice() };
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = hashRefreshToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async getUser(userId: string): Promise<PublicUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user === null ? null : toPublicUser(user);
  }

  async verifyAccessToken(accessToken: string): Promise<AccessTokenClaims | null> {
    return verifyAccessTokenJwt(accessToken, this.tokenConfig);
  }

  private async issueSession(user: {
    id: string;
    email: string;
    displayName: string;
    ageConfirmed18: boolean;
    createdAt: Date;
  }): Promise<AuthSession> {
    const access = await signAccessToken({ sub: user.id, email: user.email, displayName: user.displayName }, this.tokenConfig);
    const refresh = generateRefreshTokenValue();
    const refreshExpiresAt = new Date(Date.now() + this.tokenConfig.refreshTtlSeconds * 1000);
    await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: refresh.hash, expiresAt: refreshExpiresAt },
    });

    return {
      user: toPublicUser(user),
      tokens: {
        accessToken: access.token,
        refreshToken: refresh.value,
        accessTokenExpiresAt: access.expiresAt.toISOString(),
        refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      },
      responsibleDrinkingNotice: this.notice(),
    };
  }

  private notice(): AuthSession['responsibleDrinkingNotice'] {
    return { required18Plus: true, message: RESPONSIBLE_DRINKING_MESSAGE };
  }
}
