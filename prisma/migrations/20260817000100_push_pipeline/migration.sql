-- CreateTable
CREATE TABLE "PushDispatch" (
    "id" TEXT NOT NULL,
    "fallId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "ticketId" TEXT,
    "ticketStatus" TEXT NOT NULL DEFAULT 'pending',
    "receiptStatus" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticketAt" TIMESTAMP(3),
    "receiptAt" TIMESTAMP(3),

    CONSTRAINT "PushDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PushDispatch_ticketId_idx" ON "PushDispatch"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "PushDispatch_fallId_installationId_revision_key" ON "PushDispatch"("fallId", "installationId", "revision");

-- AddForeignKey
ALTER TABLE "PushDispatch" ADD CONSTRAINT "PushDispatch_fallId_fkey" FOREIGN KEY ("fallId") REFERENCES "FallEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDispatch" ADD CONSTRAINT "PushDispatch_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "NotificationInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
