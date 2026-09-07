import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { initDatabase } from "./database/db.js";
import { requireDashboardAuth } from "./services/auth.js";
import { issuesRouter } from "./routes/issues.js";
import { reportsRouter } from "./routes/reports.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 4010);
const dashboardPath = path.resolve(__dirname, "../../dashboard");

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: true,
  credentials: false
}));
app.use(express.json({ limit: "15mb" }));
app.use(morgan("tiny"));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "uat-session-tracker" });
});

app.use("/api/reports", reportsRouter);
app.use("/api/issues", requireDashboardAuth, issuesRouter);
app.use("/", requireDashboardAuth, express.static(dashboardPath));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ ok: false, error: "Internal server error" });
});

await initDatabase();

app.listen(port, () => {
  console.log(`UAT Session Tracker backend running on http://localhost:${port}`);
});
