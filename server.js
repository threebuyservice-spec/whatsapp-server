const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";
const AUTH_ROOT = path.resolve(process.env.AUTH_ROOT || "auth_info");
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "default";
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 3000);
const AUTO_START_DEFAULT = process.env.AUTO_START_DEFAULT !== "false";

const sessions = new Map();
let cachedBaileysVersion;

function asSingleString(value) {
  if (Array.isArray(value)) {
    return value[0] || "";
  }
  return value ?? "";
}

function sanitizeSessionId(input) {
  if (typeof input !== "string") {
    return null;
  }

  const id = input.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,64}$/.test(id)) {
    return null;
  }

  return id;
}

function normalizePhoneToJid(phone) {
  if (typeof phone !== "string") {
    return null;
  }

  const cleaned = phone.replace(/\D/g, "");
  if (!cleaned) {
    return null;
  }

  return `${cleaned}@s.whatsapp.net`;
}

function nowIso() {
  return new Date().toISOString();
}

function buildSessionSummary(session) {
  return {
    sessionId: session.id,
    status: session.status,
    connected: session.status === "connected",
    hasQr: Boolean(session.qrDataUrl),
    reconnectAttempts: session.reconnectAttempts,
    lastDisconnectCode: session.lastDisconnectCode,
    lastError: session.lastError,
    updatedAt: session.updatedAt,
  };
}

function getOrCreateSession(id) {
  let session = sessions.get(id);
  if (!session) {
    session = {
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
    };
    sessions.set(id, session);
  }
  return session;
}

async function resolveAuthDir(sessionId) {
  if (sessionId === DEFAULT_SESSION_ID) {
    const legacyCreds = path.join(AUTH_ROOT, "creds.json");
    try {
      await fs.access(legacyCreds);
      return AUTH_ROOT;
    } catch (_error) {
      // ignore and use session folder
    }
  }

  return path.join(AUTH_ROOT, sessionId);
}

async function getBaileysVersion() {
  if (cachedBaileysVersion) {
    return cachedBaileysVersion;
  }

  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedBaileysVersion = version;
    return version;
  } catch (error) {
    console.warn("Could not fetch latest Baileys version, using library default.");
    console.warn(error?.message || error);
    return undefined;
  }
}

function clearReconnectTimer(session) {
  if (!session.reconnectTimer) {
    return;
  }
  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
}

async function closeSession(session, options = {}) {
  const { logout = false, removeAuth = false } = options;

  session.shouldReconnect = false;
  clearReconnectTimer(session);

  if (session.sock) {
    try {
      if (logout) {
        await session.sock.logout();
      }
    } catch (_error) {
      // ignore socket logout errors
    }

    try {
      if (typeof session.sock.end === "function") {
        session.sock.end(new Error("Session closed"));
      }
    } catch (_error) {
      // ignore socket end errors
    }
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
  if (!session.shouldReconnect) {
    return;
  }

  clearReconnectTimer(session);
  session.status = "reconnecting";
  session.reconnectAttempts += 1;
  session.updatedAt = nowIso();

  session.reconnectTimer = setTimeout(() => {
    connectSession(session.id).catch((error) => {
      session.status = "error";
      session.lastError = error?.message || String(error);
      session.updatedAt = nowIso();
      scheduleReconnect(session);
    });
  }, RECONNECT_DELAY_MS);
}

async function connectSession(sessionId) {
  const id = sanitizeSessionId(sessionId);
  if (!id) {
    throw new Error("Invalid sessionId. Use 2-64 chars: a-z, 0-9, _ or -");
  }

  const session = getOrCreateSession(id);
  session.shouldReconnect = true;
  session.lastError = null;
  session.updatedAt = nowIso();
  clearReconnectTimer(session);

  if (session.sock) {
    try {
      if (typeof session.sock.end === "function") {
        session.sock.end(new Error("Restarting session"));
      }
    } catch (_error) {
      // ignore socket end errors
    }
    session.sock = null;
  }

  const authDir = await resolveAuthDir(id);
  session.authDir = authDir;
  await fs.mkdir(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await getBaileysVersion();

  const socketConfig = {
    auth: state,
    browser: Browsers.macOS("Desktop"),
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    shouldSyncHistoryMessage: () => false,
  };

  if (version) {
    socketConfig.version = version;
  }

  const sock = makeWASocket(socketConfig);
  session.sock = sock;
  session.status = "connecting";
  session.qrDataUrl = null;
  session.updatedAt = nowIso();

  sock.ev.on("creds.update", (...args) => {
    if (session.sock !== sock) {
      return;
    }
    saveCreds(...args);
  });

  sock.ev.on("connection.update", async (update) => {
    if (session.sock !== sock) {
      return;
    }

    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      try {
        session.qrDataUrl = await QRCode.toDataURL(qr);
        session.status = "qr_ready";
        session.updatedAt = nowIso();
      } catch (error) {
        session.status = "error";
        session.lastError = error?.message || String(error);
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
      const disconnectCode = lastDisconnect?.error?.output?.statusCode ?? null;
      session.lastDisconnectCode = disconnectCode;
      session.updatedAt = nowIso();
      console.log(`[${session.id}] Disconnected`, disconnectCode || "");

      if (disconnectCode === DisconnectReason.loggedOut) {
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

app.use((req, res, next) => {
  const reqOrigin = req.headers.origin || "*";
  const reqHeaders =
    req.headers["access-control-request-headers"] ||
    "Content-Type, x-api-key, Authorization";

  res.setHeader("Vary", "Origin, Access-Control-Request-Headers");
  res.setHeader("Access-Control-Allow-Origin", reqOrigin);
  res.setHeader("Access-Control-Allow-Headers", reqHeaders);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  const apiKeyHeader = asSingleString(req.headers["x-api-key"]);
  const apiKeyQuery = asSingleString(req.query?.apiKey || req.query?.api_key);
  const presentedApiKey = String(apiKeyHeader || apiKeyQuery || "");

  if (API_KEY && presentedApiKey !== API_KEY) {
    return res.status(401).json({ status: false, message: "Unauthorized" });
  }

  next();
});

app.get("/health", (_req, res) => {
  res.json({
    status: true,
    service: "whatsapp-gateway",
    sessions: sessions.size,
    timestamp: nowIso(),
  });
});

app.get("/sessions", (_req, res) => {
  res.json({
    status: true,
    sessions: [...sessions.values()].map(buildSessionSummary),
  });
});

async function handleConnect(req, res) {
  try {
    const session = await connectSession(req.params.sessionId);
    return res.json({
      status: true,
      message: "Session started. Wait for QR.",
      session: buildSessionSummary(session),
    });
  } catch (error) {
    return res.status(400).json({
      status: false,
      message: error?.message || String(error),
    });
  }
}

app.post("/sessions/:sessionId/connect", handleConnect);
app.get("/sessions/:sessionId/connect", handleConnect);

app.get("/sessions/:sessionId/status", (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) {
    return res.status(400).json({
      status: false,
      message: "Invalid sessionId.",
    });
  }

  const session = sessions.get(id);
  if (!session) {
    return res.status(404).json({
      status: false,
      message: "Session not found.",
    });
  }

  return res.json({
    status: true,
    session: buildSessionSummary(session),
  });
});

app.get("/sessions/:sessionId/qr", (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) {
    return res.status(400).json({
      status: false,
      message: "Invalid sessionId.",
    });
  }

  const session = sessions.get(id);
  if (!session) {
    return res.status(404).json({
      status: false,
      message: "Session not found. First call /connect.",
    });
  }

  if (!session.qrDataUrl) {
    if (session.status === "connected") {
      return res.json({
        status: true,
        message: "Session is already connected. QR is not required.",
        session: buildSessionSummary(session),
        qrDataUrl: null,
      });
    }

    return res.json({
      status: false,
      message: "QR not ready yet.",
      session: buildSessionSummary(session),
    });
  }

  return res.json({
    status: true,
    sessionId: id,
    qrDataUrl: session.qrDataUrl,
    updatedAt: session.updatedAt,
  });
});

app.get("/sessions/:sessionId/qr/image", (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) {
    return res.status(400).send("Invalid sessionId");
  }

  const session = sessions.get(id);
  if (!session || !session.qrDataUrl) {
    return res.status(404).send("QR not ready");
  }

  return res.send(`<img src="${session.qrDataUrl}" alt="WhatsApp QR" />`);
});

app.post("/sessions/:sessionId/pair-code", async (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) {
    return res.status(400).json({
      status: false,
      message: "Invalid sessionId.",
    });
  }

  const session = sessions.get(id);
  if (!session || !session.sock) {
    return res.status(404).json({
      status: false,
      message: "Session not found. First call /connect.",
    });
  }

  const phone = String(req.body?.phoneNumber || "");
  const onlyDigits = phone.replace(/\D/g, "");
  if (!onlyDigits) {
    return res.status(400).json({
      status: false,
      message: "phoneNumber is required.",
    });
  }

  try {
    const code = await session.sock.requestPairingCode(onlyDigits);
    return res.json({
      status: true,
      sessionId: id,
      pairingCode: code,
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: error?.message || String(error),
    });
  }
});

async function handleSendText(req, res) {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) {
    return res.status(400).json({
      status: false,
      message: "Invalid sessionId.",
    });
  }

  const session = sessions.get(id);
  if (!session || !session.sock) {
    return res.status(404).json({
      status: false,
      message: "Session not found.",
    });
  }

  if (session.status !== "connected") {
    return res.status(409).json({
      status: false,
      message: "Session is not connected.",
      session: buildSessionSummary(session),
    });
  }

  const toValue =
    req.body?.to ?? req.query?.to ?? req.headers["x-to"] ?? "";
  const messageValue =
    req.body?.message ?? req.query?.message ?? req.headers["x-message"] ?? "";

  const jid = normalizePhoneToJid(String(toValue));
  const message = String(messageValue).trim();
  if (!jid || !message) {
    return res.status(400).json({
      status: false,
      message: "Both 'to' and 'message' are required.",
    });
  }

  try {
    const result = await session.sock.sendMessage(jid, { text: message });
    return res.json({
      status: true,
      sessionId: id,
      to: jid,
      messageId: result?.key?.id || null,
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: error?.message || String(error),
    });
  }
}

app.post("/sessions/:sessionId/send-text", handleSendText);
app.get("/sessions/:sessionId/send-text", handleSendText);

app.delete("/sessions/:sessionId", async (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) {
    return res.status(400).json({
      status: false,
      message: "Invalid sessionId.",
    });
  }

  const session = sessions.get(id);
  if (!session) {
    return res.status(404).json({
      status: false,
      message: "Session not found.",
    });
  }

  try {
    const removeAuth = String(req.query.removeAuth || "false") === "true";
    await closeSession(session, { logout: true, removeAuth });
    sessions.delete(id);
    return res.json({
      status: true,
      message: "Session closed.",
      removedAuth: removeAuth,
    });
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: error?.message || String(error),
    });
  }
});

app.get("/generate-qr", async (req, res) => {
  const requested = String(req.query.sessionId || DEFAULT_SESSION_ID);
  const id = sanitizeSessionId(requested);

  if (!id) {
    return res.status(400).json({
      status: false,
      message: "Invalid sessionId.",
    });
  }

  let session = sessions.get(id);
  if (!session) {
    try {
      session = await connectSession(id);
    } catch (error) {
      return res.status(400).json({
        status: false,
        message: error?.message || String(error),
      });
    }
  }

  if (!session.qrDataUrl) {
    if (session.status === "connected") {
      return res.send("Session already connected. QR is not required.");
    }

    return res.json({
      status: false,
      message: "QR not ready yet.",
      session: buildSessionSummary(session),
    });
  }

  return res.send(`<img src="${session.qrDataUrl}" alt="WhatsApp QR" />`);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    status: false,
    message: error?.message || "Internal Server Error",
  });
});

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

if (AUTO_START_DEFAULT) {
  connectSession(DEFAULT_SESSION_ID).catch((error) => {
    console.error("Default session startup failed:", error?.message || error);
  });
}

async function shutdown() {
  const all = [...sessions.values()];
  for (const session of all) {
    await closeSession(session, { logout: false, removeAuth: false });
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
