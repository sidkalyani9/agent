import crypto from "node:crypto";
import { isIP } from "node:net";

const buckets = new Map();

export function clientIp(req) {
  // App Service overwrites Client-IP at its front end. Never trust a caller's
  // X-Forwarded-For or X-Client-IP as an identity for rate limiting.
  if (process.env.WEBSITE_SITE_NAME) {
    const raw = String(req.get("client-ip") || "").trim();
    const candidate = /^\[[^\]]+\]:\d+$/.test(raw) ? raw.slice(1, raw.indexOf("]")) : /^\d+\.\d+\.\d+\.\d+:\d+$/.test(raw) ? raw.split(":")[0] : raw;
    if (isIP(candidate)) return candidate;
  }
  // Express resolves only proxies explicitly trusted by the application.
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function rateLimit({ name, limit, windowMs, key = clientIp }) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${name}:${key(req)}`;
    const fresh = (buckets.get(bucketKey)?.times || []).filter((at) => now - at < windowMs);
    if (fresh.length >= limit) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
    }
    fresh.push(now);
    buckets.set(bucketKey, { times: fresh, expires: now + windowMs });
    if (buckets.size > 5000) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.expires <= now) buckets.delete(bucketKey);
      }
      if (buckets.size > 10000) buckets.delete(buckets.keys().next().value);
    }
    return next();
  };
}

export function readCookies(req) {
  const out = Object.create(null);
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
  if (req.get("sec-fetch-site") === "cross-site") return false;
  if (!origin) return process.env.NODE_ENV !== "production";
  const allowed = new Set(process.env.NODE_ENV === "production" ? [] : ["http://127.0.0.1:5173", "http://localhost:5173"]);
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
  if (cookiesAreSecure()) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("Content-Security-Policy", htmlCsp());
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
