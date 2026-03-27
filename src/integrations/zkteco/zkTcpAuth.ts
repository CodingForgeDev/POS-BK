/**
 * Adapter: apply ZKTeco TCP comm key after `node-zklib` CMD_CONNECT.
 * `node-zklib` does not implement CMD_AUTH; this module fills that gap without forking the library.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { COMMANDS } = require("node-zklib/constants") as {
  COMMANDS: { CMD_AUTH: number; CMD_ACK_OK: number; CMD_ACK_UNAUTH: number };
};

import { buildZkCommKeyAuthPayload, parseZkCommKeyNumeric } from "./zkCommKey";
import type { ZkPullConfig } from "./zkPullConfig";

export interface ZkCommKeyAuthResult {
  attempted: boolean;
  /** Numeric comm key used (never log raw password in production). */
  commKeyNumeric: number | null;
  success: boolean;
  error?: string;
}

type TcpLike = {
  sessionId: number | null;
  executeCmd: (command: number, data: Buffer | string) => Promise<Buffer>;
};

export async function zkApplyCommKeyAfterConnect(tcp: TcpLike, cfg: ZkPullConfig): Promise<ZkCommKeyAuthResult> {
  if (cfg.skipCmdAuth) {
    return { attempted: false, commKeyNumeric: null, success: true };
  }

  const trimmed = cfg.devicePassword?.trim() ?? "";
  if (!trimmed) {
    return { attempted: false, commKeyNumeric: null, success: true };
  }

  const commKeyNumeric = parseZkCommKeyNumeric(trimmed);
  if (commKeyNumeric === null) {
    return {
      attempted: false,
      commKeyNumeric: null,
      success: false,
      error: "ZK_DEVICE_PASSWORD is set but could not be parsed as a comm key (use decimal e.g. 1234 or 8-digit hex)",
    };
  }

  const sid = tcp.sessionId;
  if (sid === null || sid === undefined) {
    return { attempted: true, commKeyNumeric, success: false, error: "TCP sessionId missing after CMD_CONNECT" };
  }

  try {
    const payload = buildZkCommKeyAuthPayload(commKeyNumeric, sid, cfg.commAuthTicks);
    const rReply = await tcp.executeCmd(COMMANDS.CMD_AUTH, payload);
    const cmd = rReply.length >= 2 ? rReply.readUInt16LE(0) : -1;
    if (cmd === COMMANDS.CMD_ACK_OK) {
      return { attempted: true, commKeyNumeric, success: true };
    }
    if (cmd === COMMANDS.CMD_ACK_UNAUTH) {
      return { attempted: true, commKeyNumeric, success: false, error: "CMD_AUTH rejected (wrong comm key or firmware mismatch)" };
    }
    return {
      attempted: true,
      commKeyNumeric,
      success: false,
      error: `CMD_AUTH unexpected reply commandId=${cmd} (expected CMD_ACK_OK=${COMMANDS.CMD_ACK_OK})`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { attempted: true, commKeyNumeric, success: false, error: msg };
  }
}
