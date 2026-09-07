const sensitiveKeyPatterns = [
  /authorization/i,
  /cookie/i,
  /set-cookie/i,
  /api[-_]?key/i,
  /access[-_]?token/i,
  /refresh[-_]?token/i,
  /id[-_]?token/i,
  /password/i,
  /secret/i,
  /client[-_]?secret/i
];

const tokenLikePattern = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function maskSensitive(value) {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.replace(tokenLikePattern, "Bearer ***masked***");
  }

  if (Array.isArray(value)) {
    return value.map(item => maskSensitive(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        sensitiveKeyPatterns.some(pattern => pattern.test(key))
          ? "***masked***"
          : maskSensitive(nestedValue)
      ])
    );
  }

  return value;
}
