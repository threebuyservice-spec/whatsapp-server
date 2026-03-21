const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const AUTH_ROOT = path.resolve(process.env.AUTH_ROOT || "auth_info");
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "default";
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 3000);
const AUTO_START_DEFAULT = process.env.AUTO_START_DEFAULT !== "false";

// ─── حداقل فاصله بین ذخیره دو QR متوالی (میلی‌ثانیه) ───────────────────────
// Baileys هر ~20 ثانیه یک QR جدید می‌سازه؛ ما اون رو max هر 30 ثانیه ذخیره می‌کنیم
const QR_THROTTLE_MS = Number(process.env.QR_THROTTLE_MS || 30_000);

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://kbnbbbnbaukbdzehkkzz.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtibmJiYm5iYXVrYmR6ZWhra3p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1MTgxMTQsImV4cCI6MjA4NjA5NDExNH0.wwqY_wGSM_TDDmW31GnpnV7RXMZc2YUkQagy3-BJoMM";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sessions = new Map();
let cachedBaileysVersion;

function nowIso() {
  return new Date().toISOString();
}

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
      // ── فیلدهای جدید برای کنترل QR ──────────────────────────────────────
      lastQrSavedAt: 0,       // timestamp آخرین باری که QR در DB ذخیره شد
      qrSaveCount: 0,         // تعداد دفعاتی که QR ذخیره شده (برای debug)
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

async function updateSupabaseDevice(sessionId, data) {
  try {
    const { error } = await supabase
      .from("devices")
      .update(data)
      .eq("session_data", sessionId);
    if (error) console.error(`[DB Error ${sessionId}]`, error.message);
  } catch (err) {
    console.error(`[DB Exception ${sessionId}]`, err);
  }
}

async function closeSession(session, { logout = false, removeAuth = false } = {}) {
  session.shouldReconnect = false;
  clearReconnectTimer(session);

  if (session.sock) {
    try {
      if (logout) await session.sock.logout();
    } catch {}
    try {
      if (session.sock.end) session.sock.end(new Error("Session closed"));
    } catch {}
  }

  session.sock = null;
  session.qrDataUrl = null;
  session.status = "closed";
  session.updatedAt = nowIso();

  await updateSupabaseDevice(session.id, { status: "disconnected", qr_code: null });

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

  // ── وقتی reconnect می‌شه، throttle رو ریست می‌کنیم تا اولین QR جدید سریع ذخیره بشه
  session.lastQrSavedAt = 0;

  session.reconnectTimer = setTimeout(() => {
    connectSession(session.id).catch((err) => {
      session.status = "error";
      session.lastError = err?.message || String(err);
      session.updatedAt = nowIso();
      scheduleReconnect(session);
    });
  }, RECONNECT_DELAY_MS);
}

// ─── هندلر QR با throttle ────────────────────────────────────────────────────
async function handleQR(session, sock, qr) {
  // QR رو همیشه در حافظه (RAM) ذخیره می‌کنیم تا endpoint /qr/image فوری جواب بده
  let dataUrl;
  try {
    dataUrl = await QRCode.toDataURL(qr);
  } catch (err) {
    session.status = "error";
    session.lastError = err?.message || String(err);
    session.updatedAt = nowIso();
    return;
  }

  session.qrDataUrl = dataUrl;
  session.status = "qr_ready";
  session.updatedAt = nowIso();

  // ── throttle: فقط اگه از آخرین ذخیره در DB به اندازه کافی گذشته باشه ──────
  const now = Date.now();
  const elapsed = now - session.lastQrSavedAt;

  if (elapsed < QR_THROTTLE_MS) {
    console.log(
      `[${session.id}] QR generated but throttled (${Math.round(elapsed / 1000)}s < ${QR_THROTTLE_MS / 1000}s). DB skipped.`
    );
    return; // QR در حافظه هست ولی DB آپدیت نمی‌شه
  }

  // ── QR اول یا بعد از گذشت زمان کافی → ذخیره در DB ────────────────────────
  session.lastQrSavedAt = now;
  session.qrSaveCount += 1;
  console.log(
    `[${session.id}] QR #${session.qrSaveCount} saved to DB (elapsed: ${Math.round(elapsed / 1000)}s)`
  );

  await updateSupabaseDevice(session.id, {
    qr_code: dataUrl,
    status: "scanning",
  });
}

async function connectSession(sessionId) {
  const id = sanitizeSessionId(sessionId);
  if (!id)
    throw new Error("Invalid sessionId. Use 2-64 chars: a-z, 0-9, _ or -");

  const session = getOrCreateSession(id);
  session.shouldReconnect = true;
  session.lastError = null;
  session.updatedAt = nowIso();

  // ── اولین اتصال: throttle رو ریست کن تا اولین QR سریع ذخیره بشه ──────────
  session.lastQrSavedAt = 0;

  clearReconnectTimer(session);

  if (session.sock) {
    try {
      session.sock.end(new Error("Restarting session"));
    } catch {}
  }
  session.sock = null;

  const authDir = await resolveAuthDir(id);
  session.authDir = authDir;
  await fs.mkdir(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await getBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS("Desktop"),
    version,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    shouldSyncHistoryMessage: () => false,
  });

  session.sock = sock;
  session.status = "connecting";
  session.qrDataUrl = null;
  session.updatedAt = nowIso();

  sock.ev.on("creds.update", (...args) => {
    if (session.sock === sock) saveCreds(...args);
  });

  sock.ev.on("connection.update", async (update) => {
    if (session.sock !== sock) return; // socket قدیمی → نادیده بگیر

    const { connection, qr, lastDisconnect } = update;

    // ── QR دریافت شد ─────────────────────────────────────────────────────────
    if (qr) {
      await handleQR(session, sock, qr);
    }

    // ── اتصال برقرار شد ───────────────────────────────────────────────────────
    if (connection === "open") {
      session.status = "connected";
      session.qrDataUrl = null;
      session.reconnectAttempts = 0;
      session.lastDisconnectCode = null;
      session.lastError = null;
      session.lastQrSavedAt = 0; // ریست برای اتصال بعدی
      session.updatedAt = nowIso();
      console.log(`[${session.id}] WhatsApp connected`);

      const user = sock.user;
      let profileName =
        user?.name || user?.verifiedName || user?.id?.split(":")[0];
      let phoneNumber =
        user?.id?.split(":")[1]?.split("@")[0] || user?.id?.split(":")[0];

      // پاک کردن QR از DB بعد از اتصال موفق
      await updateSupabaseDevice(session.id, {
        status: "connected",
        phone_number: phoneNumber,
        name: profileName || "WhatsApp Device",
        qr_code: null,
      });
    }

    // ── اتصال قطع شد ─────────────────────────────────────────────────────────
    if (connection === "close") {
      session.lastDisconnectCode =
        lastDisconnect?.error?.output?.statusCode ?? null;
      session.updatedAt = nowIso();
      console.log(
        `[${session.id}] Disconnected`,
        session.lastDisconnectCode || ""
      );

      if (session.lastDisconnectCode === DisconnectReason.loggedOut) {
        session.status = "logged_out";
        session.shouldReconnect = false;
        session.qrDataUrl = null;
        await updateSupabaseDevice(session.id, {
          status: "disconnected",
          qr_code: null,
        });
        return;
      }

      scheduleReconnect(session);
    }
  });

  return session;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// QR تصویر (از RAM می‌خونه، فوری جواب می‌ده)
app.get("/sessions/:sessionId/qr/image", (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) return res.status(400).send("Invalid sessionId");

  const session = sessions.get(id);
  if (!session || !session.qrDataUrl) return res.status(404).send("QR not ready");

  res.send(`<img src="${session.qrDataUrl}" alt="WhatsApp QR" />`);
});

// Connect
app.post("/sessions/:sessionId/connect", async (req, res) => {
  try {
    const session = await connectSession(req.params.sessionId);
    res.json({
      status: true,
      message: "Session started. Wait for QR.",
      sessionId: session.id,
    });
  } catch (error) {
    res.status(400).json({ status: false, message: error?.message || String(error) });
  }
});

// Send (GET برای تست مرورگر)
app.get("/send", async (req, res) => {
  const { to, message } = req.query;
  if (!to || !message)
    return res.json({ status: false, message: "to or message missing" });

  try {
    const session = sessions.get(DEFAULT_SESSION_ID);
    if (!session || session.status !== "connected")
      return res.json({ status: false, message: "WhatsApp not connected yet" });

    await session.sock.sendMessage(to + "@s.whatsapp.net", { text: message });
    res.json({ status: true, message: "Sent successfully" });
  } catch (err) {
    res.json({ status: false, message: err.message });
  }
});

// Health
app.get("/health", (_req, res) => {
  const sessionList = [...sessions.values()].map((s) => ({
    id: s.id,
    status: s.status,
    qrSaveCount: s.qrSaveCount,
    reconnectAttempts: s.reconnectAttempts,
    updatedAt: s.updatedAt,
  }));
  res.json({ status: true, sessions: sessionList, timestamp: nowIso() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);

if (AUTO_START_DEFAULT)
  connectSession(DEFAULT_SESSION_ID).catch((err) =>
    console.error("Default session startup failed:", err?.message || err)
  );

// Graceful shutdown
async function shutdown() {
  for (const session of sessions.values())
    await closeSession(session, { logout: false, removeAuth: false });
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
