/**
 * ZKTeco communication key → CMD_AUTH payload (same algorithm as pyzk `make_commkey`, from commpro.c / MakeKey).
 * @see https://github.com/fananimi/pyzk/blob/master/zk/base.py
 *
 * `node-zklib` never sends this — devices with a comm key reject data reads until CMD_AUTH succeeds.
 */

export function parseZkCommKeyNumeric(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const dec = Number.parseInt(s, 10);
  if (Number.isFinite(dec) && dec >= 0 && dec <= 0xffffffff) return dec >>> 0;
  const hex = Number.parseInt(s.replace(/^0x/i, ""), 16);
  if (Number.isFinite(hex) && hex >= 0 && hex <= 0xffffffff) return hex >>> 0;
  return null;
}

/**
 * Build 4-byte payload for CMD_AUTH after CMD_CONNECT.
 * Uses BigInt for the 32-iteration scramble (matches Python before `pack('I')` truncation).
 */
export function buildZkCommKeyAuthPayload(commKeyNumeric: number, sessionId: number, ticks = 50): Buffer {
  const sid = BigInt(sessionId & 0xffff);
  const keyBig = BigInt(commKeyNumeric >>> 0);
  let k = BigInt(0);
  for (let i = 0; i < 32; i++) {
    if ((keyBig & (BigInt(1) << BigInt(i))) !== BigInt(0)) {
      k = (k << BigInt(1)) | BigInt(1);
    } else {
      k = k << BigInt(1);
    }
    k += sid;
  }
  const k32 = Number(BigInt.asUintN(32, k));
  const buf4 = Buffer.alloc(4);
  buf4.writeUInt32LE(k32 >>> 0, 0);

  const b0 = buf4[0] ^ 0x5a; // 'Z'
  const b1 = buf4[1] ^ 0x4b; // 'K'
  const b2 = buf4[2] ^ 0x53; // 'S'
  const b3 = buf4[3] ^ 0x4f; // 'O'

  const h0 = b0 | (b1 << 8);
  const h1 = b2 | (b3 << 8);
  const swapped = Buffer.alloc(4);
  swapped.writeUInt16LE(h1, 0);
  swapped.writeUInt16LE(h0, 2);

  const B = ticks & 0xff;
  return Buffer.from([
    swapped[0] ^ B,
    swapped[1] ^ B,
    B,
    swapped[3] ^ B,
  ]);
}
