-- CreateTable
CREATE TABLE "GeneralDatasetSnapshot" (
    "id" TEXT NOT NULL DEFAULT 'general',
    "builtAt" TIMESTAMP(3) NOT NULL,
    "playerCount" INTEGER NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "GeneralDatasetSnapshot_pkey" PRIMARY KEY ("id")
);
