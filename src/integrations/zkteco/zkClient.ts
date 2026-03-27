// Thin adapter around `node-zklib` for TCP attendance download.
// Comm key: `node-zklib` only sends empty CMD_CONNECT — protected devices need CMD_AUTH (see zkTcpAuth.ts).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ZKLib = require("node-zklib") as new (
  ip: string,
  port: number,
  timeout: number,
  udpInPort: number
) => ZkLibInstance;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { REQUEST_DATA } = require("node-zklib/constants") as { REQUEST_DATA: { GET_ATTENDANCE_LOGS: Buffer } };

import type { ZkPullConfig } from "./zkPullConfig";
import { zkApplyCommKeyAfterConnect, type ZkCommKeyAuthResult } from "./zkTcpAuth";

export interface ZkDeviceUser {
  /** String User ID / PIN (what the device calls "User ID" — maps to Employee.deviceUserId). */
  userId: string;
  /** Display name registered on the device. */
  name: string;
  /** Internal sequence number (uid) assigned by the device. */
  uid: number;
  /** Device role: 0 = normal user, 14 = admin. */
  role: number;
}

interface ZkLibInstance {
  connectionType: "tcp" | "udp" | null;
  zklibTcp: {
    socket: unknown;
    sessionId: number | null;
    freeData: () => Promise<unknown>;
    executeCmd: (command: number, data: Buffer | string) => Promise<Buffer>;
    readWithBuffer: (req: Buffer, cb: (n: number, total: number) => void) => Promise<{ data: Buffer; err?: Error }>;
  };
  createSocket: (
    cbErr?: (e: Error) => void,
    cbClose?: (reason: string) => void
  ) => Promise<void>;
  getInfo: () => Promise<{ userCounts: number; logCounts: number; logCapacity: number }>;
  getUsers: () => Promise<{ data: Array<{ userId: string; name: string; uid: number; role: number }>; err?: Error }>;
  disconnect: () => Promise<void>;
}

const RECORD_PACKET_SIZE = 40;

export type ZkConnectionDiagnostics = {
  tcp: boolean;
  commKey: ZkCommKeyAuthResult;
  nodeZklibAppliesCommKeyOnConnect: false;
};

async function afterZkSocketConnected(zk: ZkLibInstance, cfg: ZkPullConfig, debug: boolean): Promise<ZkCommKeyAuthResult> {
  const tcp = zk.zklibTcp;
  const auth = await zkApplyCommKeyAfterConnect(tcp, cfg);
  if (debug) {
    // eslint-disable-next-line no-console
    console.log(
      `[ZK TCP] skipCmdAuth=${cfg.skipCmdAuth} commKey attempted=${auth.attempted} success=${auth.success} keyNumeric=${auth.commKeyNumeric ?? "n/a"} ticks=${cfg.commAuthTicks} err=${auth.error ?? "-"}`
    );
  }
  if (auth.success === false && auth.error) {
    throw new Error(auth.error);
  }
  return auth;
}

export async function zkTestDeviceConnection(
  cfg: ZkPullConfig
): Promise<
  | {
      ok: true;
      info: { userCounts: number; logCounts: number; logCapacity: number };
      diagnostics: ZkConnectionDiagnostics;
    }
  | { ok: false; error: string; diagnostics?: Partial<ZkConnectionDiagnostics> }
> {
  const zk = new ZKLib(cfg.deviceIp, cfg.devicePort, cfg.timeoutMs, cfg.udpInPort);
  try {
    await zk.createSocket();
    if (zk.connectionType !== "tcp") {
      return {
        ok: false,
        error:
          "ZK pull requires TCP. Check ZK_DEVICE_IP / ZK_DEVICE_PORT. (node-zklib fell back to UDP, which we do not use for pull.)",
        diagnostics: { tcp: false, nodeZklibAppliesCommKeyOnConnect: false },
      };
    }
    const commKey = await afterZkSocketConnected(zk, cfg, cfg.debug);
    const info = await zk.getInfo();
    return {
      ok: true,
      info,
      diagnostics: {
        tcp: true,
        commKey,
        nodeZklibAppliesCommKeyOnConnect: false,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, diagnostics: { tcp: true, nodeZklibAppliesCommKeyOnConnect: false } };
  } finally {
    try {
      await zk.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Fetch the enrolled user list from the device.
 * Returns `{ userId, name, uid, role }[]` — `userId` is the PIN that should be set as `Employee.deviceUserId`.
 */
export async function fetchZkDeviceUsers(cfg: ZkPullConfig): Promise<ZkDeviceUser[]> {
  const zk = new ZKLib(cfg.deviceIp, cfg.devicePort, cfg.timeoutMs, cfg.udpInPort);
  await zk.createSocket();

  try {
    await afterZkSocketConnected(zk, cfg, cfg.debug);
    const result = await zk.getUsers();
    return (result?.data ?? []).map((u) => ({
      userId: (u.userId ?? "").trim(),
      name: (u.name ?? "").trim(),
      uid: u.uid ?? 0,
      role: u.role ?? 0,
    }));
  } finally {
    try {
      await zk.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Download full attendance buffer from the device (TCP) and return raw 40-byte records.
 */
export async function fetchZkAttendanceRecordBuffers(
  cfg: ZkPullConfig,
  options?: { debug?: boolean }
): Promise<Buffer[]> {
  const debug = options?.debug ?? cfg.debug;
  const zk = new ZKLib(cfg.deviceIp, cfg.devicePort, cfg.timeoutMs, cfg.udpInPort);
  await zk.createSocket();

  try {
    const tcp = zk.zklibTcp;
    if (!tcp?.socket) {
      throw new Error("ZK device socket not available after connect");
    }

    if (zk.connectionType !== "tcp") {
      throw new Error(
        "ZK pull sync requires a TCP session to the device. Check ZK_DEVICE_IP / ZK_DEVICE_PORT and firewall rules."
      );
    }

    await afterZkSocketConnected(zk, cfg, debug);

    try {
      await tcp.freeData();
    } catch (err) {
      return Promise.reject(err);
    }

    let data: { data: Buffer; err?: Error };
    try {
      data = await tcp.readWithBuffer(REQUEST_DATA.GET_ATTENDANCE_LOGS, () => {});
    } catch (err) {
      return Promise.reject(err);
    }

    try {
      await tcp.freeData();
    } catch (err) {
      return Promise.reject(err);
    }

    const recordData = data.data.subarray(4);
    const records: Buffer[] = [];
    let rest = recordData;
    while (rest.length >= RECORD_PACKET_SIZE) {
      records.push(Buffer.from(rest.subarray(0, RECORD_PACKET_SIZE)));
      rest = rest.subarray(RECORD_PACKET_SIZE);
    }
    return records;
  } finally {
    try {
      await zk.disconnect();
    } catch {
      /* ignore */
    }
  }
}
