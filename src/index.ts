import "./lib/env"; // must be first — loads .env.local / .env before anything else
import "express-async-errors";
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

const app = express();
const PORT = process.env.PORT || 5000;
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

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });

export default app;
