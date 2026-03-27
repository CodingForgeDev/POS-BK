import express, { Router } from "express";
import type { Request, Response } from "express";
import { connectDB } from "../../lib/mongodb";
import { previewPlainTextForLog } from "../../lib/plainLogPreview";
import {
  buildAdmsHandshakeResponse,
  handleAdmsAttLogPost,
  splitAdmsBodyIntoLines,
} from "../../integrations/zkteco/admsAttendanceReceiver";

const router = Router();

// ZKTeco ADMS sends non-JSON bodies (tab/newline separated strings) to /iclock/cdata.
// Parse raw text within this router only to avoid impacting the rest of your API.
router.use(express.text({ type: "*/*", limit: "2mb" }));

router.get("/", async (req: Request, res: Response) => {
  try {
    // Some ZKTeco firmwares hit /iclock (instead of /iclock/cdata) for handshake.
    const sn = typeof req.query.SN === "string" ? req.query.SN : undefined;
    await connectDB();
    res.status(200).type("text/plain").send(buildAdmsHandshakeResponse(sn));
  } catch {
    res.status(200).type("text/plain").send("ERROR");
  }
});

router.get("/cdata", async (req: Request, res: Response) => {
  try {
    const sn = typeof req.query.SN === "string" ? req.query.SN : undefined;
    await connectDB();
    if (process.env.ZKTECO_RECEIVER_LOG === "1") {
      // eslint-disable-next-line no-console
      console.log(`[ZKTeco] handshake sn=${sn ?? ""}`);
    }
    res.status(200).type("text/plain").send(buildAdmsHandshakeResponse(sn));
  } catch {
    res.status(200).type("text/plain").send("ERROR");
  }
});

// /iclock/getrequest = device keep-alive poll ("any commands for me?").
// MB460/pushver 2.x does not support DATA QUERY ATTLOG — always respond "OK".
// Attendance uploads are triggered by ATTLOGStamp=0 in the /iclock/cdata handshake instead.
router.get("/getrequest", (_req, res: Response) => {
  res.status(200).type("text/plain").send("OK");
});

// Optional debug endpoint (some firmwares probe it).
router.get("/test", (_req, res: Response) => {
  res.status(200).type("text/plain").send("OK");
});

// Device POSTs command acknowledgment + query results here.
// Accept and respond OK so device proceeds to upload ATTLOG via /iclock/cdata.
router.post("/devicecmd", async (req: Request, res: Response) => {
  try {
    const rawBody = typeof req.body === "string" ? req.body : "";
    if (process.env.ZKTECO_RECEIVER_LOG === "1") {
      // eslint-disable-next-line no-console
      console.log(
        `[ZKTeco] devicecmd sn=${req.query.SN} bytes=${rawBody.length} preview=${previewPlainTextForLog(rawBody, 200)}`
      );
    }

    // If the device sends ATTLOG data directly here, process it.
    const tableRaw = req.query.table;
    const table = typeof tableRaw === "string" ? tableRaw.toUpperCase() : "";
    if ((table === "ATTLOG" || rawBody.includes("\t")) && rawBody.trim().length > 0) {
      await connectDB();
      await handleAdmsAttLogPost(rawBody);
    }

    res.status(200).type("text/plain").send("OK");
  } catch {
    res.status(200).type("text/plain").send("OK");
  }
});

async function handleAdmsPost(req: Request, res: Response) {
  const rawBody = typeof req.body === "string" ? req.body : "";
  const tableRaw = req.query.table;
  const table = typeof tableRaw === "string" ? tableRaw.toUpperCase() : "";
  const sn = typeof req.query.SN === "string" ? req.query.SN : "";

  await connectDB();

  if (!rawBody) {
    res.status(200).type("text/plain").send("OK:0");
    return;
  }

  // Some implementations send OPERLOG (operation logs) instead of ATTLOG.
  if (table === "OPERLOG") {
    const lines = splitAdmsBodyIntoLines(rawBody);

    if (process.env.ZKTECO_RECEIVER_LOG === "1") {
      // eslint-disable-next-line no-console
      console.log(`[ZKTeco] operlog sn=${sn} lines=${lines.length}`);
    }
    res.status(200).type("text/plain").send(`OK:${lines.length}`);
    return;
  }

  const attLogResult = await handleAdmsAttLogPost(rawBody);

  if (process.env.ZKTECO_RECEIVER_LOG === "1") {
    // eslint-disable-next-line no-console
    console.log(
      `[ZKTeco] attlog sn=${sn} punches=${attLogResult.punchesParsed} saved=${attLogResult.savedPunches} employeeNotFound=${attLogResult.employeeNotFound}`
    );
  }

  // Keep the device response simple (most devices only check for "OK").
  res.status(200).type("text/plain").send(`OK:${attLogResult.punchesParsed}`);
}

router.post("/", async (req: Request, res: Response) => {
  try {
    await handleAdmsPost(req, res);
  } catch {
    res.status(200).type("text/plain").send("ERROR");
  }
});

router.post("/cdata", async (req: Request, res: Response) => {
  try {
    await handleAdmsPost(req, res);
  } catch {
    // Do not throw JSON errors to the device; respond with plain text.
    res.status(200).type("text/plain").send("ERROR");
  }
});

export default router;

