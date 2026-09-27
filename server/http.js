import crypto from "node:crypto";

const buckets = new Map();

export function clientIp(req) {
  if (process.env.PANTRY_TRUST_PROXY === "1") {
    const first = String(req.get("x-forwarded-for") || "").split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  return req.socket?.remoteAddress || "unknown";
}

export function rateLimit({ name, limit, windowMs }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${clientIp(req)}`;
    const fresh = (buckets.get(key) || []).filter((at) => now - at < windowMs);
    if (fresh.length >= limit) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
    }
    fresh.push(now);
    buckets.set(key, fresh);
    if (buckets.size > 5000) {
      for (const [bucketKey, times] of buckets) {
        if (!times.some((at) => now - at < windowMs)) buckets.delete(bucketKey);
      }
    }
    return next();
  };
}

export function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

export function cookiesAreSecure() {
  return String(process.env.APP_ORIGIN || "").startsWith("https://");
}

export function writeCookie(res, name, value, { maxAge, path = "/", secure = cookiesAreSecure() } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  const cookie = parts.join("; ");
  const existing = res.getHeader("Set-Cookie");
  if (!existing) res.setHeader("Set-Cookie", cookie);
  else if (Array.isArray(existing)) res.setHeader("Set-Cookie", existing.concat(cookie));
  else res.setHeader("Set-Cookie", [existing, cookie]);
}

export function clearCookie(res, name, path = "/") {
  writeCookie(res, name, "", { maxAge: 0, path });
}

export function allowedOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  const allowed = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);
  const configured = String(process.env.APP_ORIGIN || "").replace(/\/$/, "");
  if (configured) allowed.add(configured);
  return allowed.has(origin.replace(/\/$/, ""));
}

export function csrfOk(header, expected) {
  if (!header || !expected) return false;
  const left = Buffer.from(String(header));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Cache-Control", "no-store");
  next();
}

export function htmlCsp() {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}
