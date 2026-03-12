const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const QRCode = require("qrcode");
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason } = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const AUTH_ROOT = path.resolve(process.env.AUTH_ROOT || "auth_info");
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "default";
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 3000);
const AUTO_START_DEFAULT = process.env.AUTO_START_DEFAULT !== "false";

const sessions = new Map();
let cachedBaileysVersion;

function nowIso() { return new Date().toISOString(); }

function sanitizeSessionId(input) {
  if (typeof input !== "string") return null;
  const id = input.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,64}$/.test(id)) return null;
  return id;
}

function getOrCreateSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      sock: null,
      status: "idle",
      qrDataUrl: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      shouldReconnect: true,
      lastDisconnectCode: null,
      lastError: null,
      updatedAt: nowIso(),
      authDir: null,
    });
  }
  return sessions.get(id);
}

async function resolveAuthDir(sessionId) {
  return path.join(AUTH_ROOT, sessionId);
}

async function getBaileysVersion() {
  if (cachedBaileysVersion) return cachedBaileysVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedBaileysVersion = version;
    return version;
  } catch {
    return undefined;
  }
}

function clearReconnectTimer(session) {
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
}

async function closeSession(session, { logout = false, removeAuth = false } = {}) {
  session.shouldReconnect = false;
  clearReconnectTimer(session);

  if (session.sock) {
    try { if (logout) await session.sock.logout(); } catch {}
    try { if (session.sock.end) session.sock.end(new Error("Session closed")); } catch {}
  }

  session.sock = null;
  session.qrDataUrl = null;
  session.status = "closed";
  session.updatedAt = nowIso();

  if (removeAuth && session.authDir) {
    await fs.rm(session.authDir, { recursive: true, force: true });
  }
}

function scheduleReconnect(session) {
  if (!session.shouldReconnect) return;
  clearReconnectTimer(session);
  session.status = "reconnecting";
  session.reconnectAttempts += 1;
  session.updatedAt = nowIso();

  session.reconnectTimer = setTimeout(() => {
    connectSession(session.id).catch(err => {
      session.status = "error";
      session.lastError = err?.message || String(err);
      session.updatedAt = nowIso();
      scheduleReconnect(session);
    });
  }, RECONNECT_DELAY_MS);
}

async function connectSession(sessionId) {
  const id = sanitizeSessionId(sessionId);
  if (!id) throw new Error("Invalid sessionId. Use 2-64 chars: a-z, 0-9, _ or -");

  const session = getOrCreateSession(id);
  session.shouldReconnect = true;
  session.lastError = null;
  session.updatedAt = nowIso();
  clearReconnectTimer(session);

  if (session.sock) try { session.sock.end(new Error("Restarting session")); } catch {}
  session.sock = null;

  const authDir = await resolveAuthDir(id);
  session.authDir = authDir;
  await fs.mkdir(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await getBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS("Desktop"),
    version: version,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    shouldSyncHistoryMessage: () => false,
  });

  session.sock = sock;
  session.status = "connecting";
  session.qrDataUrl = null;
  session.updatedAt = nowIso();

  sock.ev.on("creds.update", (...args) => { if (session.sock === sock) saveCreds(...args); });

  sock.ev.on("connection.update", async update => {
    if (session.sock !== sock) return;
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      try {
        session.qrDataUrl = await QRCode.toDataURL(qr);
        session.status = "qr_ready";
        session.updatedAt = nowIso();
      } catch (err) {
        session.status = "error";
        session.lastError = err?.message || String(err);
        session.updatedAt = nowIso();
      }
    }

    if (connection === "open") {
      session.status = "connected";
      session.qrDataUrl = null;
      session.reconnectAttempts = 0;
      session.lastDisconnectCode = null;
      session.lastError = null;
      session.updatedAt = nowIso();
      console.log(`[${session.id}] WhatsApp connected`);
    }

    if (connection === "close") {
      session.lastDisconnectCode = lastDisconnect?.error?.output?.statusCode ?? null;
      session.updatedAt = nowIso();
      console.log(`[${session.id}] Disconnected`, session.lastDisconnectCode || "");

      if (session.lastDisconnectCode === DisconnectReason.loggedOut) {
        session.status = "logged_out";
        session.shouldReconnect = false;
        session.qrDataUrl = null;
        return;
      }

      scheduleReconnect(session);
    }
  });

  return session;
}

// Endpoint QR تصویر
app.get("/sessions/:sessionId/qr/image", (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) return res.status(400).send("Invalid sessionId");

  const session = sessions.get(id);
  if (!session || !session.qrDataUrl) return res.status(404).send("QR not ready");

  res.send(`<img src="${session.qrDataUrl}" alt="WhatsApp QR" />`);
});

// Endpoint connect
app.post("/sessions/:sessionId/connect", async (req, res) => {
  try {
    const session = await connectSession(req.params.sessionId);
    res.json({ status: true, message: "Session started. Wait for QR.", sessionId: session.id });
  } catch (error) {
    res.status(400).json({ status: false, message: error?.message || String(error) });
  }
});

// Health
app.get("/health", (_req, res) => {
  res.json({ status: true, sessions: sessions.size, timestamp: nowIso() });
});

const server = app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

if (AUTO_START_DEFAULT) connectSession(DEFAULT_SESSION_ID).catch(err => console.error("Default session startup failed:", err?.message || err));

// Graceful shutdown
async function shutdown() {
  for (const session of sessions.values()) await closeSession(session, { logout: false, removeAuth: false });
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
