const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason } = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const AUTH_ROOT = path.resolve(process.env.AUTH_ROOT || "auth_info");
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "default";

// ❌ AUTO START کامل حذف شد
// const AUTO_START_DEFAULT = process.env.AUTO_START_DEFAULT !== "false";

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kbnbbbnbaukbdzehkkzz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtibmJiYm5iYXVrYmR6ZWhra3p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1MTgxMTQsImV4cCI6MjA4NjA5NDExNH0.wwqY_wGSM_TDDmW31GnpnV7RXMZc2YUkQagy3-BJoMM';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const sessions = new Map();

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
      updatedAt: nowIso(),
      authDir: null,
    });
  }
  return sessions.get(id);
}

async function resolveAuthDir(sessionId) {
  return path.join(AUTH_ROOT, sessionId);
}

// اتصال به واتساپ
async function connectSession(sessionId) {
  const id = sanitizeSessionId(sessionId);
  if (!id) throw new Error("Invalid sessionId");

  const session = getOrCreateSession(id);

  const authDir = await resolveAuthDir(id);
  session.authDir = authDir;
  await fs.mkdir(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS("Desktop"),
  });

  session.sock = sock;
  session.status = "connecting";

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update;

    // 🎯 QR ساخته شد
    if (qr) {
      session.qrDataUrl = await QRCode.toDataURL(qr);
      session.status = "qr_ready";

      console.log(`[${session.id}] QR generated`);

      await supabase
        .from("devices")
        .update({
          qr_code: session.qrDataUrl,
          status: "scanning",
        })
        .eq("session_data", session.id);
    }

    // ✅ وصل شد
    if (connection === "open") {
      session.status = "connected";
      session.qrDataUrl = null;

      console.log(`[${session.id}] Connected`);

      const user = sock.user;

      await supabase
        .from("devices")
        .update({
          status: "connected",
          qr_code: null,
          phone_number: user?.id,
        })
        .eq("session_data", session.id);
    }

    // ❌ قطع شد (دیگه reconnect نداریم)
    if (connection === "close") {
      console.log(`[${session.id}] Disconnected`);
      session.status = "closed";

      await supabase
        .from("devices")
        .update({
          status: "disconnected",
          qr_code: null,
        })
        .eq("session_data", session.id);
    }
  });

  return session;
}

// 📌 API برای استارت دستی
app.post("/sessions/:sessionId/connect", async (req, res) => {
  try {
    const session = await connectSession(req.params.sessionId);
    res.json({ status: true, message: "QR started", sessionId: session.id });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
});

// 📌 نمایش QR
app.get("/sessions/:sessionId/qr", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session || !session.qrDataUrl) {
    return res.send("QR not ready");
  }
  res.send(session.qrDataUrl);
});

// 📌 تست ارسال پیام
app.get("/send", async (req, res) => {
  const session = sessions.get(DEFAULT_SESSION_ID);

  if (!session || session.status !== "connected") {
    return res.send({ status: false, message: "Not connected" });
  }

  await session.sock.sendMessage(req.query.to + "@s.whatsapp.net", {
    text: req.query.message,
  });

  res.send({ status: true });
});

// health
app.get("/health", (req, res) => {
  res.json({ status: true });
});

// 🚀 start server فقط (بدون واتساپ)
app.listen(PORT, () => {
  console.log("Server started");
});
