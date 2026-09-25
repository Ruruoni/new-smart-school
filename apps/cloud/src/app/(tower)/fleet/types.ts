export interface Row {
  id: string; code: string; schoolName: string; state: string | null; status: "PENDING" | "ACTIVE" | "SUSPENDED" | "DECOMMISSIONED"; plan: string;
  lastHeartbeatAt: string | null; lastSyncAt: string | null; appVersion: string | null; studentCount: number; openAlerts: number; worstAlert: "INFO" | "WARNING" | "CRITICAL" | null;
  openConflicts: number; queuePending: number | null; licenseExpiresAt: string | null; modules: string[];
}
export interface Metrics {
  queuePending: number; queueFailed: number; queueDead: number; openConflicts: number; oldestPendingAgeSec: number | null; lastSyncAt: string | null; dbOk: boolean;
  workers: { name: string; lastBeatAt: string; status: string }[]; recentErrors: string[]; activeUsers: number; studentCount: number; lastBackupAt: string | null;
}
export interface Alert { id: string; kind: string; severity: "INFO" | "WARNING" | "CRITICAL"; message: string; openedAt: string; acknowledgedAt: string | null }
export interface Detail {
  installation: Row & {
    contactName: string | null; contactEmail: string | null; contactPhone: string | null; notes: string | null; graceDays: number; suspendedAt: string | null; suspendedReason: string | null;
    registeredAt: string | null; licenseIssuedAt: string | null; schemaVersion: string | null; lastIp: string | null; featureOverrides: Record<string, boolean>; lastMetrics: Metrics | null;
    heartbeats: { id: string; receivedAt: string; metrics: Metrics; appVersion: string | null }[]; alerts: Alert[];
    commands: { id: string; type: string; args: Record<string, unknown>; issuedAt: string; deliveredAt: string | null; expiresAt: string }[];
    conflicts: { id: string; entityType: string; entityId: string; detectedAt: string }[];
  };
  sync: { records: number; byType: { entityType: string; count: number }[] };
  backups: { id: string; fileName: string; sizeBytes: number; receivedAt: string; sha256: string }[];
  audit: { id: string; seq: number; occurredAt: string; operatorEmail: string | null; action: string; detail: unknown }[];
  flags: { key: string; enabled: boolean }[];
  latestVersion: string | null; registrationTokenExpiresAt: string | null; moduleCatalogue: string[];
}
