-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "ageConfirmed18" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "replacedByTokenId" TEXT,
    CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Friendship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Friendship_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Friendship_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pin" TEXT NOT NULL,
    "hostUserId" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "Room_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RoomPlayer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "engagementPlayerId" TEXT NOT NULL,
    "userId" TEXT,
    "nickname" TEXT NOT NULL,
    "isGuest" BOOLEAN NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" DATETIME,
    "finalScore" INTEGER,
    "finalSips" INTEGER,
    CONSTRAINT "RoomPlayer_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoomPlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GameSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "roundsPlanned" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "GameSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RoundResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameSessionId" TEXT NOT NULL,
    "roundIndex" INTEGER NOT NULL,
    "moduleId" TEXT NOT NULL,
    "engineRoundId" TEXT NOT NULL,
    "outcome" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoundResult_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlayerStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "roomsPlayed" INTEGER NOT NULL DEFAULT 0,
    "roundsPlayed" INTEGER NOT NULL DEFAULT 0,
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "totalSips" INTEGER NOT NULL DEFAULT 0,
    "correctAnswers" INTEGER NOT NULL DEFAULT 0,
    "roundsWon" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlayerStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_displayName_idx" ON "User"("displayName");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_userId_key" ON "Credential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "Friendship_addresseeId_status_idx" ON "Friendship"("addresseeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Friendship_requesterId_addresseeId_key" ON "Friendship"("requesterId", "addresseeId");

-- CreateIndex
CREATE UNIQUE INDEX "Room_pin_key" ON "Room"("pin");

-- CreateIndex
CREATE INDEX "RoomPlayer_userId_idx" ON "RoomPlayer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomPlayer_roomId_engagementPlayerId_key" ON "RoomPlayer"("roomId", "engagementPlayerId");

-- CreateIndex
CREATE INDEX "GameSession_roomId_idx" ON "GameSession"("roomId");

-- CreateIndex
CREATE INDEX "RoundResult_gameSessionId_idx" ON "RoundResult"("gameSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerStat_userId_key" ON "PlayerStat"("userId");
