import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SESSION_IDLE_SECONDS = 90 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_SECONDS = 180 * 24 * 60 * 60;
export const INVITE_SECONDS = 7 * 24 * 60 * 60;

export function dataDirectory() {
  return path.resolve(process.env.PANTRY_DATA_DIR || path.join(ROOT, "server", "data"));
}

export function validateProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  for (const name of ["SESSION_SECRET", "ENTRA_CLIENT_SECRET", "DATABASE_URL", "TOKENROUTER_API_KEY", "OPENROUTER_API_KEY"]) {
    if (/^@Microsoft\.KeyVault\(/i.test(String(process.env[name] || "").trim())) {
      throw new Error(`Production ${name} contains an unresolved Key Vault reference.`);
    }
  }
  const origin = new URL(process.env.APP_ORIGIN || "invalid");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("Production APP_ORIGIN must be an HTTPS origin without a path.");
  }
  if ((process.env.SESSION_SECRET || "").length < 48) throw new Error("Production requires a random SESSION_SECRET of at least 48 characters.");
  if (process.env.PANTRY_SEED === "fixtures") throw new Error("Fixture data is forbidden in production.");
  if (!process.env.DATABASE_URL) throw new Error("Production requires DATABASE_URL for PostgreSQL.");
  if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL)) throw new Error("DATABASE_URL must point to PostgreSQL.");
  if (!/^https:\/\/[a-z0-9]+\.blob\.core\.windows\.net\/?$/.test(process.env.AZURE_STORAGE_ACCOUNT_URL || "")) throw new Error("Production requires an Azure Blob Storage account URL.");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const name of ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "SEED_SUPERADMIN_OBJECT_ID"]) {
    if (!uuid.test(process.env[name] || "")) throw new Error(`Production requires ${name}.`);
  }
  if ((process.env.ENTRA_CLIENT_SECRET || "").length < 10 || process.env.ENTRA_REDIRECT_URI !== `${origin.origin}/api/auth/callback`) throw new Error("Production requires valid Microsoft credentials and the exact HTTPS callback URL.");
}
