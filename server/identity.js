const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function intuitiveSignInName(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 254 || /\s/.test(text)) return null;
  if ((text.match(/@/g) || []).length !== 1) return null;
  const at = text.indexOf("@");
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (!local || domain.toLowerCase() !== "intuitive.ai") return null;
  if (text.toLowerCase().includes("#ext#")) return null;
  if (!/^[A-Za-z0-9._'+-]+$/.test(local)) return null;
  return text;
}
export function identityFromClaims(claims, {
  tenantId,
  clientId
}) {
  if (!claims || typeof claims !== "object") return {
    ok: false,
    reason: "failed"
  };
  if (claims.tid !== tenantId) return {
    ok: false,
    reason: "failed"
  };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) return {
    ok: false,
    reason: "failed"
  };
  if (claims.iss !== `https://login.microsoftonline.com/${tenantId}/v2.0`) return {
    ok: false,
    reason: "failed"
  };
  // Email alone is mutable and guest-supplied; it is not proof of a member UPN.
  if (claims.acct === 1 || claims.acct === "1") return {
    ok: false,
    reason: "domain"
  };
  if (process.env.NODE_ENV === "production" && claims.acct !== 0 && claims.acct !== "0") return {
    ok: false,
    reason: "domain"
  };
  const raw = claims.preferred_username || "";
  if (String(raw).toLowerCase().includes("#ext#")) return {
    ok: false,
    reason: "domain"
  };
  const signInName = intuitiveSignInName(raw);
  if (!signInName) return {
    ok: false,
    reason: "domain"
  };
  if (!UUID.test(String(claims.oid || ""))) return {
    ok: false,
    reason: "failed"
  };
  const displayName = String(claims.name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120);
  return {
    ok: true,
    oid: String(claims.oid),
    signInName,
    displayName
  };
}
