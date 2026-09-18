/**
 * `IdentityProvider` — one of the four hub-integration seams (see CLAUDE.md / docs/ARCHITECTURE.md).
 *
 * Nothing outside `identity/` may query the `User`/`Credential`/`RefreshToken` Prisma models
 * directly. Route handlers and the socket gateway only ever call through this interface, so the
 * hub app can supply its own SSO/user-store adapter without touching `apps/api`'s route layer.
 */

export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly ageConfirmed18: boolean;
  readonly createdAt: string;
}

export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
}

export interface AuthSession {
  readonly user: PublicUser;
  readonly tokens: AuthTokens;
  /** Data contract for the client's responsible-drinking notice; copy itself lives in drinkCopy (apps/web). */
  readonly responsibleDrinkingNotice: {
    readonly required18Plus: true;
    readonly message: string;
  };
}

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  /** Must be `true` — the 18+ confirmation checkbox, persisted, not just a client-side gate. */
  readonly ageConfirmed18: boolean;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

export type IdentityErrorCode =
  | 'EMAIL_TAKEN'
  | 'AGE_NOT_CONFIRMED'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_REFRESH_TOKEN'
  | 'REFRESH_TOKEN_REUSED'
  | 'USER_NOT_FOUND';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export interface AccessTokenClaims {
  readonly sub: string;
  readonly email: string;
  readonly displayName: string;
}

/** The auth seam. `LocalIdentityProvider` is the only implementation today. */
export interface IdentityProvider {
  register(input: RegisterInput): Promise<AuthSession>;
  login(input: LoginInput): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  logout(refreshToken: string): Promise<void>;
  getUser(userId: string): Promise<PublicUser | null>;
  /** Verify an access token and return its claims, or `null` if invalid/expired. */
  verifyAccessToken(accessToken: string): Promise<AccessTokenClaims | null>;
}
