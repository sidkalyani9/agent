delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

import fs from "node:fs";
import path from "node:path";
import express from "express";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { chatConfigured, converse } from "./chat.js";
import { beginSignIn, finishSignIn, searchDirectory, entraSettings } from "./entra.js";
import { allowedOrigin, clearCookie, csrfOk, htmlCsp, rateLimit, readCookies, securityHeaders, writeCookie } from "./http.js";
import { ensureSessionSecret, seal } from "./secret.js";
import { HttpError } from "./service.js";
import * as service from "./service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "server", "data");
dotenv.config({ path: path.join(root, ".env") });
ensureSessionSecret(dataDir);

const db = service.openDatabase(process.env.PANTRY_DB || path.join(dataDir, "pantry.sqlite"));
const app = express();
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(rateLimit({ name: "api", limit: 300, windowMs: 60_000 }));
app.use(express.json({ limit: "14mb" }));

const AUTH_CODES = new Set([
  "not_configured",
  "not_on_list",
  "inactive",
  "domain",
  "cancelled",
  "expired",
  "failed",
  "directory_ready",
]);

function appUrl(pathname) {
  const origin = String(process.env.APP_ORIGIN || "http://127.0.0.1:5173").replace(/\/$/, "");
  return `${origin}${pathname}`;
}

function sendAuth(res, code) {
  const safe = AUTH_CODES.has(code) ? code : "failed";
  clearCookie(res, "aim_login", "/api/auth/callback");
  res.redirect(302, appUrl(`/?auth=${safe}`));
}

function setAuthCookies(res, issued) {
  writeCookie(res, "aim_access", issued.accessToken, { maxAge: 15 * 60 });
  writeCookie(res, "aim_refresh", issued.refreshToken, { maxAge: 30 * 24 * 60 * 60, path: "/api/auth" });
  clearCookie(res, "aim_setup", "/api/auth");
  clearCookie(res, "aim_session");
}

function clearAuthCookies(res) {
  clearCookie(res, "aim_access");
  clearCookie(res, "aim_refresh", "/api/auth");
  clearCookie(res, "aim_setup", "/api/auth");
  clearCookie(res, "aim_session");
}

function originOk(req, res) {
  if (allowedOrigin(req)) return true;
  res.status(403).json({ error: "This action was blocked." });
  return false;
}

function loadSession(req, _res, next) {
  const access = service.personFromAccessToken(db, readCookies(req).aim_access || "");
  if (access) {
    req.person = access.person;
    req.csrfToken = access.csrf;
    req.refreshId = access.refreshId;
  }
  next();
}

function requirePerson(req, res, next) {
  if (!req.person) return res.status(401).json({ error: "Sign in with an @intuitive.AI account." });
  next();
}

function requireCsrf(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (!req.path.startsWith("/api/")) return next();
  if (!allowedOrigin(req)) return res.status(403).json({ error: "This action was blocked." });
  if (!req.person) return res.status(401).json({ error: "Sign in with an @intuitive.AI account." });
  if (!csrfOk(req.get("x-csrf-token"), req.csrfToken)) {
    return res.status(403).json({ error: "Sign in again, then retry that action." });
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get("/api/health", (_req, res) => {
  try {
    db.prepare("SELECT 1 AS ok").get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get("/api/auth/login", rateLimit({ name: "login", limit: 20, windowMs: 10 * 60_000 }), asyncRoute(async (_req, res) => {
  const started = await beginSignIn(db, "login");
  if (started.error) return sendAuth(res, started.error);
  writeCookie(res, "aim_login", started.state, { maxAge: 600, path: "/api/auth/callback" });
  res.redirect(302, started.url);
}));

app.get("/api/auth/directory", rateLimit({ name: "login", limit: 20, windowMs: 10 * 60_000 }), asyncRoute(async (req, res) => {
  const session = service.personFromAccessToken(db, readCookies(req).aim_access || "");
  if (!session?.person?.superAdmin) return sendAuth(res, "failed");
  const started = await beginSignIn(db, "directory");
  if (started.error) return sendAuth(res, started.error);
  writeCookie(res, "aim_login", started.state, { maxAge: 600, path: "/api/auth/callback" });
  res.redirect(302, started.url);
}));

app.get("/api/auth/callback", rateLimit({ name: "callback", limit: 30, windowMs: 10 * 60_000 }), asyncRoute(async (req, res) => {
  const current = new URL(req.originalUrl, entraSettings()?.origin || process.env.APP_ORIGIN || "http://127.0.0.1:5173");
  if (current.searchParams.get("error")) return sendAuth(res, current.searchParams.get("error") === "access_denied" ? "cancelled" : "failed");
  const cookieState = readCookies(req).aim_login || "";
  const queryState = current.searchParams.get("state") || "";
  if (!csrfOk(cookieState, queryState)) return sendAuth(res, "expired");
  const finished = await finishSignIn(db, current);
  if (finished.error) return sendAuth(res, finished.error);
  if (finished.purpose === "directory") {
    const session = service.personFromAccessToken(db, readCookies(req).aim_access || "");
    if (!session?.person?.superAdmin) return sendAuth(res, "failed");
    const sameAccount = session.person.email.toLowerCase() === finished.identity.signInName.toLowerCase();
    if (!sameAccount) return sendAuth(res, "failed");
    if (finished.refreshToken) service.storeGraphRefresh(db, session.refreshId, seal(finished.refreshToken));
    return sendAuth(res, "directory_ready");
  }
  try {
    const person = service.acceptMicrosoftLogin(db, finished.identity);
    setAuthCookies(res, service.beginBrowserSession(db, person.id));
    clearCookie(res, "aim_login", "/api/auth/callback");
    res.redirect(302, appUrl("/"));
  } catch (error) {
    sendAuth(res, error instanceof HttpError ? error.code : "failed");
  }
}));

app.post("/api/auth/password", rateLimit({ name: "password", limit: 10, windowMs: 10 * 60_000 }), (req, res, next) => {
  if (!originOk(req, res)) return;
  try {
    const result = service.loginWithPassword(db, req.body?.email, req.body?.password);
    if (result.next === "setup") {
      writeCookie(res, "aim_setup", result.setupToken, { maxAge: 15 * 60, path: "/api/auth" });
      clearCookie(res, "aim_access");
      clearCookie(res, "aim_refresh", "/api/auth");
      return res.json({ next: "setup", email: result.email });
    }
    setAuthCookies(res, result);
    res.json({ next: "app", csrfToken: result.csrf, person: result.person });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/password/setup", (req, res) => {
  const context = service.setupContext(db, readCookies(req).aim_setup || "");
  if (!context) return res.status(401).json({ error: "Sign in with the invite password first." });
  res.json(context);
});

app.post("/api/auth/password/setup", rateLimit({ name: "setup", limit: 10, windowMs: 10 * 60_000 }), (req, res, next) => {
  if (!originOk(req, res)) return;
  try {
    const result = service.completePasswordSetup(db, readCookies(req).aim_setup || "", req.body?.password, req.body?.confirm);
    setAuthCookies(res, result);
    res.json({ next: "app", csrfToken: result.csrf, person: result.person });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/refresh", rateLimit({ name: "refresh", limit: 60, windowMs: 10 * 60_000 }), (req, res, next) => {
  if (!originOk(req, res)) return;
  try {
    const issued = service.rotateRefresh(db, readCookies(req).aim_refresh || "");
    setAuthCookies(res, issued);
    res.json({ csrfToken: issued.csrf, person: issued.person });
  } catch (error) {
    clearAuthCookies(res);
    next(error);
  }
});

app.use(loadSession);
app.use(requireCsrf);

app.post("/api/auth/logout", requirePerson, (req, res) => {
  service.revokeBrowserSession(db, req.refreshId);
  clearAuthCookies(res);
  res.json({ ok: true });
});

app.get("/api/me", requirePerson, (req, res) => {
  res.json({ person: req.person, csrfToken: req.csrfToken, chatConfigured: chatConfigured() });
});

app.get("/api/directory/users", requirePerson, asyncRoute(async (req, res) => {
  if (!req.person.superAdmin) return res.status(403).json({ error: "Only a Super Admin can search the directory." });
  res.json({ people: await searchDirectory(db, req.refreshId, req.query.query || "") });
}));

app.get("/api/access", requirePerson, (req, res, next) => {
  try {
    res.json({ people: service.listAccess(db, req.person) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/access/invite", requirePerson, (req, res, next) => {
  try {
    res.status(201).json(service.invitePerson(db, req.person, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/access", requirePerson, (req, res, next) => {
  try {
    res.status(201).json(service.saveAccess(db, req.person, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/access/:personId/grants/:grantId", requirePerson, (req, res, next) => {
  try {
    res.json(service.removeGrant(db, req.person, req.params.personId, req.params.grantId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/access/:personId/active", requirePerson, (req, res, next) => {
  try {
    res.json(service.setPersonActive(db, req.person, req.params.personId, req.body?.active));
  } catch (error) {
    next(error);
  }
});

app.get("/api/offices", requirePerson, (req, res) => {
  res.json({ offices: service.listOffices(db, req.person) });
});

app.post("/api/offices", requirePerson, (req, res, next) => {
  try {
    res.status(201).json(service.createOffice(db, req.person, req.body?.name, req.body?.managerId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/people", requirePerson, (req, res, next) => {
  try {
    res.json({ people: service.listPeople(db, req.person) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/offices/:officeId/manager", requirePerson, (req, res, next) => {
  try {
    res.status(201).json(service.assignOfficeManager(db, req.person, req.params.officeId, req.body?.personId));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/offices/:officeId", requirePerson, (req, res, next) => {
  try {
    res.json(service.renameOffice(db, req.person, req.params.officeId, req.body?.name));
  } catch (error) {
    next(error);
  }
});

app.get("/api/offices/:officeId/pantry", requirePerson, (req, res, next) => {
  try {
    res.json(service.getPantry(db, req.person, req.params.officeId, req.query.month));
  } catch (error) {
    next(error);
  }
});

app.get("/api/pantry/summary", requirePerson, (req, res, next) => {
  try {
    res.json(service.summary(db, req.person, req.query.month));
  } catch (error) {
    next(error);
  }
});

app.get("/api/offices/:officeId/operations", requirePerson, (req, res, next) => {
  try {
    res.json({
      operations: service.listOperations(db, req.person, req.params.officeId, {
        from: req.query.from,
        to: req.query.to,
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/offices/:officeId/export", requirePerson, (req, res, next) => {
  try {
    const file = service.exportCsv(db, req.person, req.params.officeId, req.query.month);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", attachmentName(file.filename, "pantry.csv"));
    res.send(file.body);
  } catch (error) {
    next(error);
  }
});

app.post("/api/offices/:officeId/products", requirePerson, (req, res, next) => {
  try {
    res.status(201).json(service.createProduct(db, req.person, req.params.officeId, req.body?.name));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/products/:productId", requirePerson, (req, res, next) => {
  try {
    res.json(service.updateProduct(db, req.person, req.params.productId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/products/:productId/hide", requirePerson, (req, res, next) => {
  try {
    res.json(service.hideProduct(db, req.person, req.params.productId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/products/:productId/restore", requirePerson, (req, res, next) => {
  try {
    res.json(service.restoreProduct(db, req.person, req.params.productId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/offices/:officeId/purchases", requirePerson, (req, res, next) => {
  try {
    const receipt = decodeReceipt(req.body?.receipt);
    res.status(201).json(
      service.createPurchase(db, req.person, req.params.officeId, req.body || {}, receipt, req.get("idempotency-key")),
    );
  } catch (error) {
    next(error);
  }
});

app.get("/api/purchases/:purchaseId/receipt", requirePerson, (req, res, next) => {
  try {
    const file = service.receiptFile(db, req.person, req.params.purchaseId);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", attachmentName(file.fileName, "receipt"));
    fs.createReadStream(file.full).pipe(res);
  } catch (error) {
    next(error);
  }
});

app.put("/api/purchases/:purchaseId/receipt", requirePerson, (req, res, next) => {
  try {
    res.json(service.attachReceipt(db, req.person, req.params.purchaseId, decodeReceipt(req.body?.receipt)));
  } catch (error) {
    next(error);
  }
});

app.put("/api/purchases/:purchaseId", requirePerson, (req, res, next) => {
  try {
    res.json(service.correctPurchase(db, req.person, req.params.purchaseId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/purchases/:purchaseId/hide", requirePerson, (req, res, next) => {
  try {
    res.json(service.hidePurchase(db, req.person, req.params.purchaseId));
  } catch (error) {
    next(error);
  }
});

app.put("/api/offices/:officeId/counts", requirePerson, (req, res, next) => {
  try {
    res.json(service.upsertCount(db, req.person, req.params.officeId, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/counts/:countId/hide", requirePerson, (req, res, next) => {
  try {
    res.json(service.hideCount(db, req.person, req.params.countId));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/settings", requirePerson, (req, res, next) => {
  try {
    res.json(service.updateSettings(db, req.person, req.body || {}));
  } catch (error) {
    next(error);
  }
});

app.get("/api/chat/threads", requirePerson, (req, res, next) => {
  try {
    res.json({ threads: service.listChatThreads(db, req.person) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat/threads", requirePerson, (req, res, next) => {
  try {
    res.status(201).json(service.createChatThread(db, req.person));
  } catch (error) {
    next(error);
  }
});

app.get("/api/chat/threads/:threadId", requirePerson, (req, res, next) => {
  try {
    res.json(service.getChatThread(db, req.person, req.params.threadId));
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/chat",
  requirePerson,
  asyncRoute(async (req, res) => {
    const text = String(req.body?.message || "").trim();
    if (!text) return res.status(422).json({ error: "Write a message first." });
    if (text.length > 2000) return res.status(422).json({ error: "Keep a message under 2000 characters." });
    const threadId = req.body?.threadId || service.createChatThread(db, req.person).id;
    const history = service.recentChatHistory(db, req.person, threadId);
    service.addChatMessage(db, req.person, threadId, "user", text);
    if (req.body?.stream === true) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      const send = (event, data) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send("thread", { threadId });
      try {
        const result = await converse(db, req.person, history, text, {
          onDelta: (piece) => send("delta", { text: piece }),
          onReplace: (full) => send("replace", { text: full }),
        });
        service.addChatMessage(db, req.person, threadId, "assistant", result.reply, result.proposals || []);
        send("done", {
          threadId,
          reply: result.reply,
          proposals: result.proposals || [],
          saved: Boolean(result.saved),
        });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error(error);
        send("error", {
          error: status === 500 ? "Something went wrong." : error.message,
          threadId,
        });
      }
      return res.end();
    }
    try {
      const result = await converse(db, req.person, history, text);
      service.addChatMessage(db, req.person, threadId, "assistant", result.reply, result.proposals || []);
      res.json({ ...result, threadId });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      res.status(status).json({
        error: status === 500 ? "Something went wrong." : error.message,
        threadId,
      });
    }
  }),
);

app.post("/api/chat/confirm", requirePerson, (req, res, next) => {
  try {
    const result = service.confirmProposal(db, req.person, req.body?.proposalId);
    const lead = String(result.action || "").startsWith("delete_") ? "Deleted." : "Saved.";
    const reply = `${lead} ${result.summary}`;
    if (req.body?.threadId) {
      service.addChatMessage(db, req.person, req.body.threadId, "assistant", reply);
    }
    res.json({ ...result, reply });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat/dismiss", requirePerson, (req, res, next) => {
  try {
    res.json(service.dismissProposal(db, req.person, req.body?.proposalId));
  } catch (error) {
    next(error);
  }
});

const dist = path.join(root, "client", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, dotfiles: "ignore" }));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.setHeader("Content-Security-Policy", htmlCsp());
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  let status = 500;
  let message = "Something went wrong.";
  if (error instanceof HttpError) {
    status = error.status;
    message = error.message;
  } else if (error.type === "entity.parse.failed") {
    status = 400;
    message = "The request could not be read.";
  } else if (error.type === "entity.too.large" || error.status === 413) {
    status = 413;
    message = "That upload is too large.";
  }
  if (status === 500) console.error(error);
  res.status(status).json({ error: message });
});

function attachmentName(name, fallback) {
  const safe = String(name || fallback).replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 120) || fallback;
  return `attachment; filename="${safe}"`;
}

function decodeReceipt(receipt) {
  if (!receipt?.dataBase64) return null;
  const bytes = Buffer.from(String(receipt.dataBase64), "base64");
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) {
    throw new HttpError(422, "A receipt is a PDF, JPEG, or PNG up to 10 MB.");
  }
  return { fileName: receipt.fileName, bytes };
}

const port = Number(process.env.PORT || 8787);
const host = process.env.WEBSITE_SITE_NAME ? "0.0.0.0" : process.env.PANTRY_HOST || "127.0.0.1";
app.listen(port, host, () => {
  console.log(`Pantry API on http://${host}:${port}`);
  if (!entraSettings()) {
    console.log("Microsoft sign-in is not configured. Set ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, and ENTRA_REDIRECT_URI.");
  }
});
