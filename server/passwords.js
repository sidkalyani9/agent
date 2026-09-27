import crypto from "node:crypto";

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ISSUER = "intuitive-pantry";
const COMMON = new Set(
  `password password1 password123 password1234 qwerty qwerty123 letmein welcome welcome1
   admin admin123 iloveyou abc123 123456 12345678 123456789 changeme secret intuitive intuitive123
   pantry pantry123 microsoft office office123`
    .split(/\s+/)
    .filter(Boolean),
);

function secret() {
  const value = process.env.SESSION_SECRET || "";
  if (value.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters.");
  return value;
}

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(plain, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (N !== SCRYPT.N || r !== SCRYPT.r || p !== SCRYPT.p) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(plain), Buffer.from(parts[4], "base64url"), 32, SCRYPT);
  } catch {
    return false;
  }
  const expected = Buffer.from(parts[5], "base64url");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export const DUMMY_PASSWORD_HASH = hashPassword("not-a-real-invite-password");

export function passwordProblems(plain, email) {
  const password = String(plain ?? "");
  const problems = [];
  if (password.length < 12) problems.push("Use at least 12 characters.");
  if (password.length > 128) problems.push("Use at most 128 characters.");
  if (password !== password.trim()) problems.push("Do not start or end the password with a space.");
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    problems.push("Use an uppercase letter, a lowercase letter, and a number.");
  }
  const local = String(email || "").split("@")[0].toLowerCase();
  const folded = password.toLowerCase();
  if (COMMON.has(folded) || (local.length >= 3 && folded.includes(local))) {
    problems.push("Choose a password that is harder to guess.");
  }
  return problems;
}

export function randomInvitePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const chars = [];
  while (chars.length < 20) {
    const bytes = crypto.randomBytes(32);
    for (const byte of bytes) {
      if (byte >= alphabet.length * 4) continue;
      chars.push(alphabet[byte % alphabet.length]);
      if (chars.length === 20) break;
    }
  }
  const raw = chars.join("");
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function sign(payload, ttlSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const nowSec = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ iss: ISSUER, aud: ISSUER, iat: nowSec, exp: nowSec + ttlSeconds, ...payload }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function readJwt(token, typ) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [headerPart, bodyPart, sig] = parts;
  let header;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
  } catch {
    return null;
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") return null;
  const expected = crypto.createHmac("sha256", secret()).update(`${headerPart}.${bodyPart}`).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(bodyPart, "base64url").toString());
  } catch {
    return null;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER || claims.aud !== ISSUER || claims.typ !== typ) return null;
  if (typeof claims.exp !== "number" || claims.exp < nowSec - 30) return null;
  if (typeof claims.iat === "number" && claims.iat > nowSec + 30) return null;
  return claims;
}

export function signAccess({ sub, sid, csrf }) {
  return sign({ sub, sid, csrf, typ: "access" }, 15 * 60);
}

export function verifyAccess(token) {
  const claims = readJwt(token, "access");
  if (!claims?.sub || !claims.sid || !claims.csrf) return null;
  return claims;
}

export function signSetup({ sub, email, jti }) {
  return sign({ sub, email, jti, typ: "setup" }, 15 * 60);
}

export function verifySetup(token) {
  const claims = readJwt(token, "setup");
  if (!claims?.sub || !claims.jti) return null;
  return claims;
}
