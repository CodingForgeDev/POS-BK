/** Collapse newlines and non-printable ASCII for one-line server logs (e.g. ZKTeco raw bodies). */
export function previewPlainTextForLog(raw: string, maxLen: number): string {
  const oneLine = raw.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E\t]/g, "?");
  return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen)}…`;
}
