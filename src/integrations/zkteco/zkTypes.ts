export type ZkPullLogSource = "zk-pull";

/** Normalized row after reading a 40-byte ZK attendance record (and mapping fields). */
export interface ZkNormalizedAttendanceLog {
  deviceUserId: string;
  userSn: number;
  timestamp: Date;
  /** ZK verify-state byte (offset 31) — mapped with ZKTECO_CLOCK_IN_VALUE / ZKTECO_CLOCK_OUT_VALUE like ADMS. */
  rawStatus: number | null;
  /** ZK verification method byte (offset 26), e.g. fingerprint vs password. */
  verifyMode: number | null;
  source: ZkPullLogSource;
}

export interface ZkPullSyncDiagnostics {
  /** Raw 40-byte rows received from device. */
  rawRecordsFetched: number;
  /** Successfully decoded normalized logs. */
  normalizedOk: number;
  /** Skipped: decode failed. */
  parseFailed: number;
  /** Skipped: fingerprint already in ZkPullDedupe. */
  dedupeSkipped: number;
  /** Upsert returned saved:true (new or changed row). */
  upsertApplied: number;
  /** Upsert returned saved:false with no reason (no change vs existing attendance). */
  upsertNoop: number;
  /** Rejected: employee not found for deviceUserId / employeeId. */
  employeeNotFound: number;
  /** Always 0 — resolveEffectivePunchType always returns a direction now; kept for API backward compatibility. */
  unknownPunchType: number;
  /** Rejected: orphan_out, out_before_in, etc. */
  otherRejected: number;
}

export interface ZkPullSyncRunResult {
  ok: boolean;
  message?: string;
  /** @deprecated use diagnostics.rawRecordsFetched — kept for backward compatibility */
  logsFetched: number;
  /** @deprecated use diagnostics.upsertApplied */
  logsProcessed: number;
  /** @deprecated sum of skip paths; see diagnostics */
  logsSkipped: number;
  employeeNotFound: number;
  unknownPunchType: number;
  diagnostics?: ZkPullSyncDiagnostics;
}
