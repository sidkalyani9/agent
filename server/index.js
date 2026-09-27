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
import { dataDirectory, validateProductionConfig } from "./config.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({
  path: path.join(root, ".env")
});
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
validateProductionConfig();
const dataDir = dataDirectory();
ensureSessionSecret(dataDir);
const db = await service.openDatabase(process.env.DATABASE_URL ? null : process.env.PANTRY_DB || path.join(dataDir, "pantry.sqlite"));
const app = express();
app.disable("x-powered-by");
if (process.env.PANTRY_TRUST_PROXY === "1") app.set("trust proxy", "loopback");
app.use(securityHeaders);
app.use(rateLimit({
  name: "api",
  limit: 300,
  windowMs: 60_000
}));
const smallJson = express.json({ limit: "64kb", inflate: false });
const uploadJson = express.json({ limit: "14mb", inflate: false });
app.use((req, res, next) => {
  const upload = (req.method === "POST" && /^\/api\/offices\/[^/]+\/purchases$/.test(req.path)) || (req.method === "PUT" && /^\/api\/purchases\/[^/]+\/receipt$/.test(req.path));
  return (upload ? uploadJson : smallJson)(req, res, next);
});
const AUTH_CODES = new Set(["not_configured", "not_on_list", "inactive", "domain", "cancelled", "expired", "failed", "directory_ready"]);
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
  writeCookie(res, "aim_access", issued.accessToken, {
    maxAge: 15 * 60
  });
  writeCookie(res, "aim_refresh", issued.refreshToken, {
    maxAge: issued.refreshMaxAge,
    path: "/api/auth"
  });
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
  res.status(403).json({
    error: "This action was blocked."
  });
  return false;
}
async function loadSession(req, _res, next) {
  const access = await service.personFromAccessToken(db, readCookies(req).aim_access || "");
  if (access) {
    req.person = access.person;
    req.csrfToken = access.csrf;
    req.refreshId = access.refreshId;
  }
  next();
}
function requirePerson(req, res, next) {
  if (!req.person) return res.status(401).json({
    error: "Sign in with an @intuitive.AI account."
  });
  next();
}
function requireCsrf(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (!req.path.startsWith("/api/")) return next();
  if (!allowedOrigin(req)) return res.status(403).json({
    error: "This action was blocked."
  });
  if (!req.person) return res.status(401).json({
    error: "Sign in with an @intuitive.AI account."
  });
  if (!csrfOk(req.get("x-csrf-token"), req.csrfToken)) {
    return res.status(403).json({
      error: "Sign in again, then retry that action.",
      code: "csrf"
    });
  }
  next();
}
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
app.get("/api/health", async (_req, res) => {
  try {
    await db.prepare("SELECT 1 AS ok").get();
    res.json({
      ok: true
    });
  } catch {
    res.status(503).json({
      ok: false
    });
  }
});
app.get("/api/auth/login", rateLimit({
  name: "login",
  limit: 20,
  windowMs: 10 * 60_000
}), asyncRoute(async (_req, res) => {
  const started = await beginSignIn(db, "login");
  if (started.error) return sendAuth(res, started.error);
  writeCookie(res, "aim_login", started.state, {
    maxAge: 600,
    path: "/api/auth/callback"
  });
  res.redirect(302, started.url);
}));
app.get("/api/auth/directory", rateLimit({
  name: "login",
  limit: 20,
  windowMs: 10 * 60_000
}), asyncRoute(async (req, res) => {
  const session = await service.personFromAccessToken(db, readCookies(req).aim_access || "");
  if (!session?.person?.superAdmin) return sendAuth(res, "failed");
  const started = await beginSignIn(db, "directory");
  if (started.error) return sendAuth(res, started.error);
  writeCookie(res, "aim_login", started.state, {
    maxAge: 600,
    path: "/api/auth/callback"
  });
  res.redirect(302, started.url);
}));
app.get("/api/auth/callback", rateLimit({
  name: "callback",
  limit: 30,
  windowMs: 10 * 60_000
}), asyncRoute(async (req, res) => {
  const current = new URL(req.originalUrl, entraSettings()?.origin || process.env.APP_ORIGIN || "http://127.0.0.1:5173");
  if (current.searchParams.get("error")) return sendAuth(res, current.searchParams.get("error") === "access_denied" ? "cancelled" : "failed");
  const cookieState = readCookies(req).aim_login || "";
  const queryState = current.searchParams.get("state") || "";
  if (!csrfOk(cookieState, queryState)) return sendAuth(res, "expired");
  const finished = await finishSignIn(db, current);
  if (finished.error) return sendAuth(res, finished.error);
  if (finished.purpose === "directory") {
    const session = await service.personFromAccessToken(db, readCookies(req).aim_access || "");
    if (!session?.person?.superAdmin) return sendAuth(res, "failed");
    const sameAccount = session.person.email.toLowerCase() === finished.identity.signInName.toLowerCase();
    if (!sameAccount) return sendAuth(res, "failed");
    if (finished.refreshToken) await service.storeGraphRefresh(db, session.refreshId, seal(finished.refreshToken));
    return sendAuth(res, "directory_ready");
  }
  try {
    const person = await service.acceptMicrosoftLogin(db, finished.identity);
    setAuthCookies(res, await service.beginBrowserSession(db, person.id));
    clearCookie(res, "aim_login", "/api/auth/callback");
    res.redirect(302, appUrl("/"));
  } catch (error) {
    sendAuth(res, error instanceof HttpError ? error.code : "failed");
  }
}));
app.post("/api/auth/password", rateLimit({
  name: "password",
  limit: 60,
  windowMs: 10 * 60_000
}), async (req, res, next) => {
  if (!originOk(req, res)) return;
  try {
    const result = await service.loginWithPassword(db, req.body?.email, req.body?.password);
    if (result.next === "setup") {
      writeCookie(res, "aim_setup", result.setupToken, {
        maxAge: 15 * 60,
        path: "/api/auth"
      });
      clearCookie(res, "aim_access");
      clearCookie(res, "aim_refresh", "/api/auth");
      return res.json({
        next: "setup",
        email: result.email
      });
    }
    setAuthCookies(res, result);
    res.json({
      next: "app",
      csrfToken: result.csrf,
      person: result.person
    });
  } catch (error) {
    next(error);
  }
});
app.get("/api/auth/password/setup", async (req, res) => {
  const context = await service.setupContext(db, readCookies(req).aim_setup || "");
  if (!context) return res.status(401).json({
    error: "Sign in with the invite password first."
  });
  res.json(context);
});
app.post("/api/auth/password/setup", rateLimit({
  name: "setup",
  limit: 10,
  windowMs: 10 * 60_000
}), async (req, res, next) => {
  if (!originOk(req, res)) return;
  try {
    const result = await service.completePasswordSetup(db, readCookies(req).aim_setup || "", req.body?.password, req.body?.confirm);
    setAuthCookies(res, result);
    res.json({
      next: "app",
      csrfToken: result.csrf,
      person: result.person
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/auth/refresh", rateLimit({
  name: "refresh",
  limit: 60,
  windowMs: 10 * 60_000
}), async (req, res, next) => {
  if (!originOk(req, res)) return;
  try {
    const issued = await service.rotateRefresh(db, readCookies(req).aim_refresh || "");
    setAuthCookies(res, issued);
    res.json({
      csrfToken: issued.csrf,
      person: issued.person
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) clearAuthCookies(res);
    next(error);
  }
});
app.use(loadSession);
app.use(requireCsrf);
app.post("/api/auth/logout", requirePerson, async (req, res) => {
  await service.revokeBrowserSession(db, req.refreshId);
  clearAuthCookies(res);
  res.json({
    ok: true
  });
});
app.get("/api/me", requirePerson, (req, res) => {
  res.json({
    person: req.person,
    csrfToken: req.csrfToken,
    chatConfigured: chatConfigured()
  });
});
app.get("/api/directory/users", requirePerson, asyncRoute(async (req, res) => {
  if (!req.person.superAdmin) return res.status(403).json({
    error: "Only a Super Admin can search the directory."
  });
  res.json({
    people: await searchDirectory(db, req.refreshId, req.query.query || "")
  });
}));
app.get("/api/access", requirePerson, async (req, res, next) => {
  try {
    res.json({
      people: await service.listAccess(db, req.person)
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/access/invite", requirePerson, async (req, res, next) => {
  try {
    res.status(201).json(await service.invitePerson(db, req.person, req.body || {}));
  } catch (error) {
    next(error);
  }
});
app.post("/api/access", requirePerson, async (req, res, next) => {
  try {
    res.status(201).json(await service.saveAccess(db, req.person, req.body || {}));
  } catch (error) {
    next(error);
  }
});
app.delete("/api/access/:personId/grants/:grantId", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.removeGrant(db, req.person, req.params.personId, req.params.grantId));
  } catch (error) {
    next(error);
  }
});
app.post("/api/access/:personId/active", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.setPersonActive(db, req.person, req.params.personId, req.body?.active));
  } catch (error) {
    next(error);
  }
});
app.get("/api/offices", requirePerson, async (req, res) => {
  res.json({
    offices: await service.listOffices(db, req.person)
  });
});
app.post("/api/offices", requirePerson, async (req, res, next) => {
  try {
    res.status(201).json(await service.createOffice(db, req.person, req.body?.name, req.body?.managerId));
  } catch (error) {
    next(error);
  }
});
app.get("/api/people", requirePerson, async (req, res, next) => {
  try {
    res.json({
      people: await service.listPeople(db, req.person)
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/offices/:officeId/manager", requirePerson, async (req, res, next) => {
  try {
    res.status(201).json(await service.assignOfficeManager(db, req.person, req.params.officeId, req.body?.personId));
  } catch (error) {
    next(error);
  }
});
app.patch("/api/offices/:officeId", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.renameOffice(db, req.person, req.params.officeId, req.body?.name));
  } catch (error) {
    next(error);
  }
});
app.get("/api/offices/:officeId/pantry", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.getPantry(db, req.person, req.params.officeId, req.query.month));
  } catch (error) {
    next(error);
  }
});
app.get("/api/pantry/summary", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.summary(db, req.person, req.query.month));
  } catch (error) {
    next(error);
  }
});
app.get("/api/offices/:officeId/operations", requirePerson, async (req, res, next) => {
  try {
    res.json({
      operations: await service.listOperations(db, req.person, req.params.officeId, {
        from: req.query.from,
        to: req.query.to
      })
    });
  } catch (error) {
    next(error);
  }
});
app.get("/api/offices/:officeId/export", requirePerson, async (req, res, next) => {
  try {
    const file = await service.exportCsv(db, req.person, req.params.officeId, req.query.month);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", attachmentName(file.filename, "pantry.csv"));
    res.send(file.body);
  } catch (error) {
    next(error);
  }
});
app.post("/api/offices/:officeId/products", requirePerson, async (req, res, next) => {
  try {
    res.status(201).json(await service.createProduct(db, req.person, req.params.officeId, req.body?.name));
  } catch (error) {
    next(error);
  }
});
app.patch("/api/products/:productId", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.updateProduct(db, req.person, req.params.productId, req.body || {}));
  } catch (error) {
    next(error);
  }
});
app.post("/api/products/:productId/hide", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.hideProduct(db, req.person, req.params.productId));
  } catch (error) {
    next(error);
  }
});
app.post("/api/products/:productId/restore", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.restoreProduct(db, req.person, req.params.productId));
  } catch (error) {
    next(error);
  }
});
app.post("/api/offices/:officeId/purchases", requirePerson, async (req, res, next) => {
  try {
    const receipt = decodeReceipt(req.body?.receipt);
    res.status(201).json(await service.createPurchase(db, req.person, req.params.officeId, req.body || {}, receipt, req.get("idempotency-key")));
  } catch (error) {
    next(error);
  }
});
app.get("/api/offices/:officeId/purchases", requirePerson, async (req, res) => {
  res.json({ purchases: await service.listPurchases(db, req.person, req.params.officeId, req.query.month) });
});
app.get("/api/purchases/:purchaseId/receipt", requirePerson, async (req, res, next) => {
  try {
    const file = await service.receiptFile(db, req.person, req.params.purchaseId);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", attachmentName(file.fileName, "receipt"));
    const stream = file.stream;
    stream.on("error", next);
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});
app.put("/api/purchases/:purchaseId/receipt", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.attachReceipt(db, req.person, req.params.purchaseId, decodeReceipt(req.body?.receipt)));
  } catch (error) {
    next(error);
  }
});
app.put("/api/purchases/:purchaseId", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.correctPurchase(db, req.person, req.params.purchaseId, req.body || {}));
  } catch (error) {
    next(error);
  }
});
app.post("/api/purchases/:purchaseId/hide", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.hidePurchase(db, req.person, req.params.purchaseId));
  } catch (error) {
    next(error);
  }
});
app.put("/api/offices/:officeId/counts", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.upsertCount(db, req.person, req.params.officeId, req.body || {}));
  } catch (error) {
    next(error);
  }
});
app.post("/api/counts/:countId/hide", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.hideCount(db, req.person, req.params.countId));
  } catch (error) {
    next(error);
  }
});
app.patch("/api/settings", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.updateSettings(db, req.person, req.body || {}));
  } catch (error) {
    next(error);
  }
});
app.get("/api/chat/threads", requirePerson, async (req, res, next) => {
  try {
    res.json({
      threads: await service.listChatThreads(db, req.person)
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/chat/threads", requirePerson, async (req, res, next) => {
  try {
    res.status(201).json(await service.createChatThread(db, req.person));
  } catch (error) {
    next(error);
  }
});
app.get("/api/chat/threads/:threadId", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.getChatThread(db, req.person, req.params.threadId));
  } catch (error) {
    next(error);
  }
});
app.post("/api/chat", requirePerson, rateLimit({
  name: "chat",
  limit: 20,
  windowMs: 60_000,
  key: req => req.person.id
}), asyncRoute(async (req, res) => {
  const text = String(req.body?.message || "").trim();
  if (!text) return res.status(422).json({
    error: "Write a message first."
  });
  if (text.length > 2000) return res.status(422).json({
    error: "Keep a message under 2000 characters."
  });
  const threadId = req.body?.threadId || (await service.createChatThread(db, req.person)).id;
  const history = await service.recentChatHistory(db, req.person, threadId);
  await service.addChatMessage(db, req.person, threadId, "user", text);
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
    send("thread", {
      threadId
    });
    try {
      const result = await converse(db, req.person, history, text, {
        threadId,
        onDelta: piece => send("delta", {
          text: piece
        }),
        onReplace: full => send("replace", {
          text: full
        })
      });
      await service.addChatMessage(db, req.person, threadId, "assistant", result.reply, result.proposals || []);
      send("done", {
        threadId,
        reply: result.reply,
        proposals: result.proposals || [],
        saved: Boolean(result.saved)
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("Assistant request failed.", error?.name || "Error");
      send("error", {
        error: status === 500 ? "Something went wrong." : error.message,
        threadId
      });
    }
    return res.end();
  }
  try {
    const result = await converse(db, req.person, history, text, { threadId });
    await service.addChatMessage(db, req.person, threadId, "assistant", result.reply, result.proposals || []);
    res.json({
      ...result,
      threadId
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error("Assistant request failed.", error?.name || "Error");
    res.status(status).json({
      error: status === 500 ? "Something went wrong." : error.message,
      threadId
    });
  }
}));
app.post("/api/chat/confirm", requirePerson, async (req, res, next) => {
  try {
    if (req.body?.threadId) await service.getChatThread(db, req.person, req.body.threadId);
    const result = await service.confirmProposal(db, req.person, req.body?.proposalId, req.body?.threadId || null);
    const lead = String(result.action || "").startsWith("delete_") ? "Deleted." : "Saved.";
    const reply = `${lead} ${result.summary}`;
    if (req.body?.threadId) {
      await service.addChatMessage(db, req.person, req.body.threadId, "assistant", reply);
    }
    res.json({
      ...result,
      reply
    });
  } catch (error) {
    next(error);
  }
});
app.post("/api/chat/dismiss", requirePerson, async (req, res, next) => {
  try {
    res.json(await service.dismissProposal(db, req.person, req.body?.proposalId));
  } catch (error) {
    next(error);
  }
});
const dist = path.join(root, "client", "dist");
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
if (fs.existsSync(dist)) {
  app.use(express.static(dist, {
    index: false,
    dotfiles: "ignore"
  }));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.setHeader("Content-Security-Policy", htmlCsp());
    res.sendFile(path.join(dist, "index.html"));
  });
}
app.use((error, _req, res, _next) => {
  if (res.headersSent) return res.destroy();
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
  if (status === 500) console.error("Request failed.", error?.name || "Error");
  res.status(status).json({
    error: message
  });
});
function attachmentName(name, fallback) {
  const safe = String(name || fallback).replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 120) || fallback;
  return `attachment; filename="${safe}"`;
}
function decodeReceipt(receipt) {
  if (!receipt?.dataBase64) return null;
  const bytes = Buffer.from(String(receipt.dataBase64), "base64");
  // Validation belongs to saveReceipt: invalid attachments must not discard a
  // valid purchase. The HTTP parser still bounds the complete request body.
  return {
    fileName: receipt.fileName,
    bytes
  };
}
const port = Number(process.env.PORT || 8787);
const host = process.env.WEBSITE_SITE_NAME ? "0.0.0.0" : process.env.PANTRY_HOST || "127.0.0.1";
const server = app.listen(port, host, () => {
  console.log(`Pantry API on http://${host}:${server.address().port}`);
  if (!entraSettings()) {
    console.log("Microsoft sign-in is not configured. Set ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, and ENTRA_REDIRECT_URI.");
  }
});
server.headersTimeout = 20000;
server.requestTimeout = 30000;
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  server.close(async () => { await db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
});
