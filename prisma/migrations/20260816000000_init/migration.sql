-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DeviceRole" AS ENUM ('owner', 'caregiver');

-- CreateEnum
CREATE TYPE "FallSeverity" AS ENUM ('high', 'critical');

-- CreateEnum
CREATE TYPE "FallStatus" AS ENUM ('open', 'acknowledged', 'resolved');

-- CreateEnum
CREATE TYPE "Coverage" AS ENUM ('complete', 'partial');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "onboardingComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedByHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "hardwareId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT 'Wakatech walking stick',
    "credentialHash" TEXT,
    "claimedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "batteryLevel" INTEGER,
    "wifiRssi" INTEGER,
    "firmwareVersion" TEXT,
    "protocolVersion" INTEGER,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyMeters" DOUBLE PRECISION,
    "fixAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "sensitivity" TEXT NOT NULL DEFAULT 'medium',
    "graceSeconds" INTEGER NOT NULL DEFAULT 30,
    "settingsVersion" INTEGER NOT NULL DEFAULT 1,
    "syncState" TEXT NOT NULL DEFAULT 'unsupported',

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceClaim" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "claimHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceAccess" (
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "role" "DeviceRole" NOT NULL DEFAULT 'owner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAccess_pkey" PRIMARY KEY ("userId","deviceId")
);

-- CreateTable
CREATE TABLE "EmergencyContact" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "relationship" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmergencyContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationInstallation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installationKey" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "projectId" TEXT,
    "appVersion" TEXT,
    "permissionState" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FallEvent" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceEventId" TEXT NOT NULL,
    "severity" "FallSeverity" NOT NULL,
    "status" "FallStatus" NOT NULL DEFAULT 'open',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locationName" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracyMeters" DOUBLE PRECISION,
    "batteryLevel" INTEGER NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "dispatchRevision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FallEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FallTransition" (
    "id" TEXT NOT NULL,
    "fallId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "serverAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolution" TEXT,

    CONSTRAINT "FallTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityCheckpoint" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sampleId" TEXT NOT NULL,
    "counterEpoch" TEXT NOT NULL,
    "cumulativeSteps" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyActivity" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "steps" INTEGER NOT NULL,
    "goal" INTEGER,
    "recordedThrough" TIMESTAMP(3) NOT NULL,
    "coverage" "Coverage" NOT NULL,

    CONSTRAINT "DailyActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalkSession" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "steps" INTEGER NOT NULL,

    CONSTRAINT "WalkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceMessage" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "sequence" BIGINT NOT NULL,
    "bootId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outbox" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_familyId_idx" ON "AuthSession"("userId", "familyId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Device_hardwareId_key" ON "Device"("hardwareId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceClaim_claimHash_key" ON "DeviceClaim"("claimHash");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyContact_deviceId_key" ON "EmergencyContact"("deviceId");

-- CreateIndex
CREATE INDEX "NotificationInstallation_pushToken_idx" ON "NotificationInstallation"("pushToken");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationInstallation_userId_installationKey_key" ON "NotificationInstallation"("userId", "installationKey");

-- CreateIndex
CREATE INDEX "FallEvent_deviceId_occurredAt_idx" ON "FallEvent"("deviceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "FallEvent_deviceId_deviceEventId_key" ON "FallEvent"("deviceId", "deviceEventId");

-- CreateIndex
CREATE INDEX "ActivityCheckpoint_deviceId_occurredAt_idx" ON "ActivityCheckpoint"("deviceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityCheckpoint_deviceId_sampleId_key" ON "ActivityCheckpoint"("deviceId", "sampleId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyActivity_deviceId_date_key" ON "DailyActivity"("deviceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "WalkSession_deviceId_externalId_key" ON "WalkSession"("deviceId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceMessage_deviceId_messageId_key" ON "DeviceMessage"("deviceId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_topic_aggregateId_revision_key" ON "Outbox"("topic", "aggregateId", "revision");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceClaim" ADD CONSTRAINT "DeviceClaim_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAccess" ADD CONSTRAINT "DeviceAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAccess" ADD CONSTRAINT "DeviceAccess_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyContact" ADD CONSTRAINT "EmergencyContact_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationInstallation" ADD CONSTRAINT "NotificationInstallation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FallEvent" ADD CONSTRAINT "FallEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FallTransition" ADD CONSTRAINT "FallTransition_fallId_fkey" FOREIGN KEY ("fallId") REFERENCES "FallEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FallTransition" ADD CONSTRAINT "FallTransition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityCheckpoint" ADD CONSTRAINT "ActivityCheckpoint_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyActivity" ADD CONSTRAINT "DailyActivity_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalkSession" ADD CONSTRAINT "WalkSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceMessage" ADD CONSTRAINT "DeviceMessage_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
