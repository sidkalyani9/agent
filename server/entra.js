import * as oidc from "openid-client";
import { HttpError, saveLoginAttempt, takeLoginAttempt, graphRefreshFor, storeGraphRefresh } from "./service.js";
import { identityFromClaims, intuitiveSignInName } from "./identity.js";
import { seal, unseal } from "./secret.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_SCOPE = "openid profile email offline_access";
const DIRECTORY_SCOPE = "openid profile email offline_access https://graph.microsoft.com/User.ReadBasic.All";
let configPromise = null;
export function entraSettings() {
  const tenantId = String(process.env.ENTRA_TENANT_ID || "").trim();
  const clientId = String(process.env.ENTRA_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.ENTRA_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.ENTRA_REDIRECT_URI || "").trim();
  const origin = String(process.env.APP_ORIGIN || "http://127.0.0.1:5173").replace(/\/$/, "");
  if (!UUID.test(tenantId) || !UUID.test(clientId) || clientSecret.length < 10) return null;
  let redirect;
  let originUrl;
  try {
    redirect = new URL(redirectUri);
    originUrl = new URL(origin);
  } catch {
    return null;
  }
  if (redirect.origin !== originUrl.origin || redirect.pathname !== "/api/auth/callback") return null;
  if (redirect.username || redirect.password || redirect.hash) return null;
  return {
    tenantId,
    clientId,
    clientSecret,
    redirectUri: redirect.origin + redirect.pathname,
    origin
  };
}
async function configuration() {
  const settings = entraSettings();
  if (!settings) return null;
  if (!configPromise) {
    configPromise = oidc.discovery(new URL(`https://login.microsoftonline.com/${settings.tenantId}/v2.0`), settings.clientId, settings.clientSecret).catch(error => {
      configPromise = null;
      throw error;
    });
  }
  return configPromise;
}
export async function beginSignIn(db, purpose) {
  const settings = entraSettings();
  const config = await configuration();
  if (!settings || !config) return {
    error: "not_configured"
  };
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  await saveLoginAttempt(db, {
    state,
    verifier: codeVerifier,
    nonce,
    purpose
  });
  const redirectTo = oidc.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectUri,
    scope: purpose === "directory" ? DIRECTORY_SCOPE : LOGIN_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
    response_type: "code",
    prompt: "select_account",
    domain_hint: "intuitive.ai"
  });
  if (redirectTo.hostname !== "login.microsoftonline.com") return {
    error: "failed"
  };
  return {
    url: redirectTo.href,
    state
  };
}
export async function finishSignIn(db, currentUrl) {
  const settings = entraSettings();
  const config = await configuration();
  if (!settings || !config) return {
    error: "not_configured"
  };
  const queryState = currentUrl.searchParams.get("state") || "";
  if (!queryState) return {
    error: "expired"
  };
  const attempt = await takeLoginAttempt(db, queryState);
  if (!attempt) return {
    error: "expired"
  };
  let tokens;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: attempt.code_verifier,
      expectedState: attempt.state,
      expectedNonce: attempt.nonce,
      idTokenExpected: true
    });
  } catch (error) {
    console.error("Microsoft sign-in failed", error?.constructor?.name || "error");
    return {
      error: "failed"
    };
  }
  const identity = identityFromClaims(tokens.claims(), {
    tenantId: settings.tenantId,
    clientId: settings.clientId
  });
  if (!identity.ok) return {
    error: identity.reason || "failed"
  };
  return {
    purpose: attempt.purpose,
    identity,
    refreshToken: tokens.refresh_token || ""
  };
}
export async function searchDirectory(db, sessionToken, query) {
  if (!entraSettings()) {
    throw new HttpError(503, "Microsoft sign-in is not configured yet.", "not_configured");
  }
  const sealed = await graphRefreshFor(db, sessionToken);
  if (!sealed) {
    throw new HttpError(503, "Connect directory search once. It needs Microsoft admin consent. You can still add an @intuitive.AI sign-in name.", "directory_off");
  }
  let refresh;
  try {
    refresh = unseal(sealed);
  } catch {
    throw new HttpError(503, "Connect directory search again.", "directory_off");
  }
  const config = await configuration();
  let tokens;
  try {
    tokens = await oidc.refreshTokenGrant(config, refresh, {
      scope: "https://graph.microsoft.com/User.ReadBasic.All offline_access"
    });
  } catch (error) {
    console.error("Directory token refresh failed", error?.constructor?.name || "error");
    throw new HttpError(503, "Directory search needs a one-time Microsoft admin consent for work-account lookup. You can still add an @intuitive.AI sign-in name.", "directory_consent");
  }
  if (tokens.refresh_token) await storeGraphRefresh(db, sessionToken, seal(tokens.refresh_token));
  const q = String(query || "").replace(/["\\]/g, "").trim().slice(0, 60);
  if (q.length < 2) throw new HttpError(422, "Type at least two letters to search.");
  const url = new URL("https://graph.microsoft.com/v1.0/users");
  url.searchParams.set("$search", `"displayName:${q}" OR "mail:${q}" OR "userPrincipalName:${q}"`);
  url.searchParams.set("$select", "id,displayName,userPrincipalName,mail,userType");
  url.searchParams.set("$top", "15");
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      ConsistencyLevel: "eventual"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(503, "Directory search needs a one-time Microsoft admin consent for work-account lookup. You can still add an @intuitive.AI sign-in name.", "directory_consent");
  }
  if (!response.ok) {
    console.error("Directory search failed", response.status);
    throw new HttpError(502, "The company directory did not answer. You can still add an @intuitive.AI sign-in name.");
  }
  const payload = await response.json().catch(() => ({}));
  const people = [];
  for (const user of payload.value || []) {
    if (user.userType && user.userType !== "Member") continue;
    const signInName = intuitiveSignInName(user.userPrincipalName) || intuitiveSignInName(user.mail);
    if (!signInName) continue;
    if (!UUID.test(String(user.id || ""))) continue;
    people.push({
      directoryObjectId: String(user.id),
      displayName: String(user.displayName || signInName).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120),
      signInName
    });
  }
  return people;
}
