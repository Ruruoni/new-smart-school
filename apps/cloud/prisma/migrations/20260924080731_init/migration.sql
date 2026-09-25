-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "OperatorRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT', 'VIEWER');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "installations" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "schoolName" TEXT NOT NULL,
    "state" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "status" "InstallationStatus" NOT NULL DEFAULT 'PENDING',
    "secretEnc" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'standard',
    "modules" TEXT[],
    "featureOverrides" JSONB NOT NULL DEFAULT '{}',
    "licenseIssuedAt" TIMESTAMP(3),
    "licenseExpiresAt" TIMESTAMP(3),
    "graceDays" INTEGER NOT NULL DEFAULT 30,
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "registeredAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastIp" TEXT,
    "appVersion" TEXT,
    "schemaVersion" TEXT,
    "lastMetrics" JSONB,
    "studentCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_tokens" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "installationId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operators" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "OperatorRole" NOT NULL DEFAULT 'VIEWER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_sessions" (
    "id" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "operator_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "heartbeat_logs" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metrics" JSONB NOT NULL,
    "appVersion" TEXT,

    CONSTRAINT "heartbeat_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "synced_records" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "synced_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_ingest" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_ingest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_conflicts" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "incomingVersion" INTEGER NOT NULL,
    "storedVersion" INTEGER NOT NULL,
    "incomingPayload" JSONB NOT NULL,
    "storedPayload" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "cloud_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commands" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "args" JSONB NOT NULL DEFAULT '{}',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "issuedById" UUID,

    CONSTRAINT "commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_flags" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "global_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "releases" (
    "id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "notes" TEXT,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_uploads" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_audit" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operatorId" UUID,
    "operatorEmail" TEXT,
    "action" TEXT NOT NULL,
    "installationId" UUID,
    "detail" JSONB,
    "ip" TEXT,

    CONSTRAINT "cloud_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installations_code_key" ON "installations"("code");

-- CreateIndex
CREATE INDEX "installations_status_idx" ON "installations"("status");

-- CreateIndex
CREATE INDEX "installations_lastHeartbeatAt_idx" ON "installations"("lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "registration_tokens_tokenHash_key" ON "registration_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "operators_email_key" ON "operators"("email");

-- CreateIndex
CREATE UNIQUE INDEX "operator_sessions_tokenHash_key" ON "operator_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "operator_sessions_operatorId_idx" ON "operator_sessions"("operatorId");

-- CreateIndex
CREATE INDEX "heartbeat_logs_installationId_receivedAt_idx" ON "heartbeat_logs"("installationId", "receivedAt");

-- CreateIndex
CREATE INDEX "synced_records_installationId_entityType_idx" ON "synced_records"("installationId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "synced_records_installationId_entityType_entityId_key" ON "synced_records"("installationId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "sync_ingest_receivedAt_idx" ON "sync_ingest"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sync_ingest_installationId_idempotencyKey_key" ON "sync_ingest"("installationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "cloud_conflicts_installationId_resolvedAt_idx" ON "cloud_conflicts"("installationId", "resolvedAt");

-- CreateIndex
CREATE INDEX "commands_installationId_deliveredAt_idx" ON "commands"("installationId", "deliveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "releases_version_key" ON "releases"("version");

-- CreateIndex
CREATE INDEX "alerts_installationId_resolvedAt_idx" ON "alerts"("installationId", "resolvedAt");

-- CreateIndex
CREATE INDEX "alerts_resolvedAt_severity_idx" ON "alerts"("resolvedAt", "severity");

-- CreateIndex
CREATE INDEX "backup_uploads_installationId_receivedAt_idx" ON "backup_uploads"("installationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_audit_seq_key" ON "cloud_audit"("seq");

-- CreateIndex
CREATE INDEX "cloud_audit_installationId_occurredAt_idx" ON "cloud_audit"("installationId", "occurredAt");

-- AddForeignKey
ALTER TABLE "registration_tokens" ADD CONSTRAINT "registration_tokens_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heartbeat_logs" ADD CONSTRAINT "heartbeat_logs_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synced_records" ADD CONSTRAINT "synced_records_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_ingest" ADD CONSTRAINT "sync_ingest_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_conflicts" ADD CONSTRAINT "cloud_conflicts_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commands" ADD CONSTRAINT "commands_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_uploads" ADD CONSTRAINT "backup_uploads_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_audit" ADD CONSTRAINT "cloud_audit_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Operator audit trail is append-only.
CREATE FUNCTION cloud_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER cloud_audit_append_only BEFORE UPDATE OR DELETE ON "cloud_audit" FOR EACH ROW EXECUTE FUNCTION cloud_forbid_mutation();

-- One open alert per installation+kind.
CREATE UNIQUE INDEX alerts_one_open_per_kind ON "alerts" ("installationId", "kind") WHERE "resolvedAt" IS NULL;
-- One open conflict per record.
CREATE UNIQUE INDEX cloud_conflicts_one_open ON "cloud_conflicts" ("installationId", "entityType", "entityId") WHERE "resolvedAt" IS NULL;
