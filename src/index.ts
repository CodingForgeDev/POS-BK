import "./lib/env"; // must be first — loads .env.local / .env before anything else
import "express-async-errors";
import http from "http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import { connectDB } from "./lib/mongodb";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import ordersRoutes from "./routes/orders";
import productsRoutes from "./routes/products";
import categoriesRoutes from "./routes/categories";
import employeesRoutes from "./routes/employees";
import customersRoutes from "./routes/customers";
import suppliersRoutes from "./routes/suppliers";
import inventoryRoutes from "./routes/inventory";
import expensesRoutes from "./routes/expenses";
import discountsRoutes from "./routes/discounts";
import billingRoutes from "./routes/billing";
import reportsRoutes from "./routes/reports";
import attendanceRoutes from "./routes/attendance";
import settingsRoutes from "./routes/settings";
import zktecoIclockRoutes from "./routes/zkteco/iclock";
import zkPullRoutes from "./routes/zkteco/zkPull";
import { initZkPull } from "./integrations/zkteco/zkPullScheduler";

const app = express();
// Avoid 304 Not Modified responses for device calls (some ZKTeco firmwares expect the body).
app.set("etag", false);
const PORT = process.env.PORT || 5000;
const ZKTECO_PORT = process.env.ZKTECO_PORT || 8081;
// Some device firmwares still use the “TCP Port” (often 4370) for attendance uploads.
// We listen on both ports to make the integration resilient.
const ZKTECO_FALLBACK_PORT = process.env.ZKTECO_FALLBACK_PORT || 4370;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan("dev"));

app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/employees", employeesRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/suppliers", suppliersRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/discounts", discountsRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/iclock", zktecoIclockRoutes);
app.use("/api/zk-pull", zkPullRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

function httpErrorStatus(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === "number" && s >= 400 && s < 600) return s;
  }
  return 500;
}

function httpErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return "Internal server error";
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof Error) console.error(err.stack);
  else console.error(err);
  res.status(httpErrorStatus(err)).json({
    success: false,
    message: httpErrorMessage(err),
  });
});

connectDB()
  .then(() => {
    const apiServer = http.createServer(app);
    const zktecoServer = http.createServer(app);

    apiServer.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

    zktecoServer.listen(ZKTECO_PORT, () => {
      console.log(`ZKTeco receiver running on http://localhost:${ZKTECO_PORT}/iclock`);
    });

    if (ZKTECO_FALLBACK_PORT && String(ZKTECO_FALLBACK_PORT) !== String(ZKTECO_PORT)) {
      const zktecoFallbackServer = http.createServer(app);
      zktecoFallbackServer.listen(ZKTECO_FALLBACK_PORT, () => {
        console.log(
          `ZKTeco receiver fallback running on http://localhost:${ZKTECO_FALLBACK_PORT}/iclock`
        );
      });
    }

    initZkPull();
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });

export default app;
