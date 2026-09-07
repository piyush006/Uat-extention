import crypto from "node:crypto";

export function createIssueId() {
  const suffix = crypto.randomInt(1000, 9999);
  return `UAT-${suffix}`;
}

export function createSessionId() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `UAT-${yyyy}${mm}${dd}-${suffix}`;
}
