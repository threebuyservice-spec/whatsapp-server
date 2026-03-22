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
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 5000);
const AUTO_START_DEFAULT = process.env.AUTO_START_DEFAULT !== "false";

// -- How long to wait before saving a NEW QR to DB (ms) ----------------------
const QR_THROTTLE_MS = Number(process.env.QR_THROTTLE_MS || 25_000);

const SUPABASE_URL = process.env.SUPABASE_URL || "https://kbnbbbnbaukbdzehkkzz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtibmJiYm5iYXVrYmR6ZWhra3p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1MTgxMTQsImV4cCI6MjA4NjA5NDExNH0.wwqY_wGSM_TDDmW31GnpnV7RXMZc2YUkQagy3-BJoMM";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sessions = new Map();
const connectingNow = new Set(); 

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
      lastQrSavedAt: 0,
      qrSaveCount: 0,
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
      .update({ ...data, updated_date: nowIso() })
      .eq("session_data", sessionId);
    if (error) {
      console.error(`[DB Error ${sessionId}]`, error.message);
    } else {
      const type = data.qr_code ? "QR" : (data.status || "Status");
      console.log(`[DB Success ${sessionId}] Updated ${type}`);
    }
  } catch (err) {
    console.error(`[DB Exception ${sessionId}]`, err);
  }
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

async function handleQR(session, qr) {
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

  const now = Date.now();
  const elapsed = now - session.lastQrSavedAt;

  if (elapsed < QR_THROTTLE_MS) {
    console.log(`[${session.id}] QR cached, skipping DB write (throttle)`);
    return;
  }

  session.lastQrSavedAt = now;
  session.qrSaveCount += 1;
  console.log(`[${session.id}] QR #${session.qrSaveCount} saved to DB`);

  await updateSupabaseDevice(session.id, {
    qr_code: dataUrl,
    status: "scanning",
  });
}

async function connectSession(sessionId, force = false) {
  const id = sanitizeSessionId(sessionId);
  if (!id) throw new Error("Invalid sessionId");

  if (connectingNow.has(id)) {
    console.warn(`[${id}] Already connecting...`);
    return getOrCreateSession(id);
  }
  
  const session = getOrCreateSession(id);

  // Avoid unnecessary restarts if already active or recently attempted
  if (!force && (session.status === "connected" || session.status === "connecting" || session.status === "qr_ready")) {
    const elapsed = Date.now() - new Date(session.updatedAt).getTime();
    if (elapsed < 30000) {
      console.log(`[${id}] Session already ${session.status}, skipping.`);
      return session;
    }
  }

  connectingNow.add(id);

  try {
    session.shouldReconnect = true;
    session.lastError = null;
    session.lastQrSavedAt = 0;
    session.updatedAt = nowIso();
    clearReconnectTimer(session);

    if (session.sock) {
      console.log(`[${id}] Restarting socket...`);
      try { session.sock.end(new Error("Restarting session")); } catch {}
      session.sock = null;
    }

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

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (session.sock !== sock) return;
      if (type !== 'notify') return;

      const webhookUrl = process.env.WEBHOOK_URL || "https://whatsapp-panel-production.up.railway.app/api/webhooks/whatsapp/incoming";
      const webhookSecret = process.env.WHATSAPP_WEBHOOK_SECRET || "";

      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;
        
        const isGroup = msg.key.remoteJid?.endsWith('@g.us');
        
        let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        let messageType = "text";
        if (msg.message.imageMessage) {
            messageType = "image";
            text = msg.message.imageMessage.caption || text;
        } else if (msg.message.documentMessage) messageType = "document";
        else if (msg.message.audioMessage) messageType = "audio";
        else if (msg.message.videoMessage) messageType = "video";
        
        const phone = msg.key.remoteJid.split('@')[0];

        const payload = {
            sessionId: id,
            from: phone,
            text,
            message_type: messageType,
            is_group: isGroup
        };

        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json', 
                    'x-webhook-secret': webhookSecret 
                },
                body: JSON.stringify(payload)
            });
        } catch (err) {
            console.error(`[Webhook Error ${id}]`, err.message);
        }
      }
    });

    sock.ev.on("connection.update", async (update) => {
      if (session.sock !== sock) return;
      const { connection, qr, lastDisconnect } = update;

      if (qr) await handleQR(session, qr);

      if (connection === "open") {
        session.status = "connected";
        session.qrDataUrl = null;
        session.reconnectAttempts = 0;
        session.lastDisconnectCode = null;
        session.lastError = null;
        session.lastQrSavedAt = 0;
        session.updatedAt = nowIso();
        console.log(`[${id}] Connected`);

        const phoneNumber = sock.user?.id?.split(":")[0]?.split("@")[0] || null;
        const profileName = sock.user?.name || sock.user?.verifiedName || phoneNumber || "WhatsApp Device";

        await updateSupabaseDevice(id, {
          status: "connected",
          phone_number: phoneNumber,
          name: profileName,
          qr_code: null,
        });
      }

      if (connection === "close") {
        session.lastDisconnectCode = lastDisconnect?.error?.output?.statusCode ?? null;
        session.updatedAt = nowIso();
        console.log(`[${id}] Disconnected:`, session.lastDisconnectCode);

        if (session.lastDisconnectCode === DisconnectReason.loggedOut) {
          session.status = "logged_out";
          session.shouldReconnect = false;
          session.qrDataUrl = null;
          await updateSupabaseDevice(id, { status: "disconnected", qr_code: null });
          return;
        }
        scheduleReconnect(session);
      }
    });

    return session;
  } finally {
    connectingNow.delete(id);
  }
}

app.get("/sessions/:sessionId/qr/image", (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) return res.status(400).send("Invalid ID");
  const session = sessions.get(id);
  if (!session || !session.qrDataUrl) return res.status(404).send("QR not ready");

  try {
    const base64Data = session.qrDataUrl.replace(/^data:image\/\w+;base64,/, "");
    const img = Buffer.from(base64Data, "base64");
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": img.length,
      "Cache-Control": "no-store",
    });
    res.end(img);
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.post("/sessions/:sessionId/connect", async (req, res) => {
  try {
    const session = await connectSession(req.params.sessionId);
    res.json({ status: true, sessionId: session.id });
  } catch (error) {
    res.status(400).json({ status: false, message: error.message });
  }
});

app.get("/sessions/:sessionId/status", (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) return res.status(400).json({ status: "disconnected", connected: false });
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ status: "disconnected", connected: false });
  
  res.json({
    status: session.status,
    connected: session.status === "connected",
    qr: session.qrDataUrl ? true : false,
    updatedAt: session.updatedAt
  });
});

app.post("/sessions/:sessionId/send", async (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) return res.status(400).json({ error: "Invalid ID" });
  
  const { to, text, mediaUrl, caption } = req.body;
  if (!to || (!text && !mediaUrl)) {
    return res.status(400).json({ error: "Missing to or message" });
  }

  const session = sessions.get(id);
  if (!session || session.status !== "connected" || !session.sock) {
    return res.status(400).json({ error: "Device not connected" });
  }

  try {
    // Ensure the number is just digits
    const cleanTo = to.replace(/\D/g, "");
    const jid = cleanTo + "@s.whatsapp.net";
    
    if (mediaUrl) {
       await session.sock.sendMessage(jid, { image: { url: mediaUrl }, caption: caption || text || "" });
    } else {
       await session.sock.sendMessage(jid, { text });
    }
    res.json({ success: true, status: "sent" });
  } catch (err) {
    console.error(`[Send Error ${id}]`, err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/send", async (req, res) => {
  const { to, message, sessionId } = req.query;
  const targetId = sessionId ? sanitizeSessionId(sessionId) : DEFAULT_SESSION_ID;
  if (!to || !message || !targetId) return res.json({ status: false, message: "Missing required fields" });
  try {
    const session = sessions.get(targetId);
    if (!session || session.status !== "connected" || !session.sock) {
        return res.json({ status: false, message: "Device not connected" });
    }
    await session.sock.sendMessage(to + "@s.whatsapp.net", { text: message });
    res.json({ status: true });
  } catch (err) {
    res.json({ status: false, message: err.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: true, sessions: [...sessions.values()].map(s => ({ id: s.id, status: s.status })) });
});

const server = app.listen(PORT, () => console.log(`Running on ${PORT}`));

if (AUTO_START_DEFAULT) connectSession(DEFAULT_SESSION_ID).catch(err => console.error(err));

async function shutdown() {
  for (const session of sessions.values()) await closeSession(session);
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
