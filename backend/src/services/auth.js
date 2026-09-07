import crypto from "node:crypto";

function constantTimeEqual(a, b) {
  const aBuffer = Buffer.from(String(a || ""));
  const bBuffer = Buffer.from(String(b || ""));
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

export function requireDashboardAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", "Basic realm=\"UAT Session Tracker\"");
    return res.status(401).send("Authentication required");
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  if (
    constantTimeEqual(username, process.env.DASHBOARD_USER) &&
    constantTimeEqual(password, process.env.DASHBOARD_PASSWORD)
  ) {
    return next();
  }

  res.set("WWW-Authenticate", "Basic realm=\"UAT Session Tracker\"");
  return res.status(401).send("Invalid credentials");
}
