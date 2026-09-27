import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let derived;

export function ensureSessionSecret(dataDir) {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) return;
  const file = path.join(dataDir, "session-secret.key");
  if (fs.existsSync(file)) {
    const stored = fs.readFileSync(file, "utf8").trim();
    if (stored.length >= 32) {
      process.env.SESSION_SECRET = stored;
      return;
    }
  }
  const created = crypto.randomBytes(48).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${created}\n`, { mode: 0o600 });
  process.env.SESSION_SECRET = created;
}

function key() {
  if (derived) return derived;
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters.");
  derived = crypto.scryptSync(secret, "aim-session-v1", 32);
  return derived;
}

export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function unseal(packed) {
  const buf = Buffer.from(String(packed || ""), "base64url");
  if (buf.length < 29) throw new Error("sealed value is unreadable");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
