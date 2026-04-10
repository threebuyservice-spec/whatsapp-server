import * as dotenv from "dotenv";
dotenv.config();

import express from "express";
import fs from "fs/promises";
import path from "path";
import QRCode from "qrcode";
import { createClient } from "@supabase/supabase-js";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "./lib/useSupabaseAuthState.mjs";
import { logger, childLogger, createBaileysLogger } from "./lib/logger.mjs";
import { createQueue, redisConnection } from "./lib/queues.mjs";
import { initLeaderElection, currentIsLeader } from "./lib/leader.mjs";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const AUTH_ROOT = path.resolve(process.env.AUTH_ROOT || "auth_info");
const DEFAULT_SESSION_ID = sanitizeSessionId(process.env.DEFAULT_SESSION_ID || "default") || "default";
// By default, only auto-start based on devices DB in production.
const AUTO_START_DEFAULT = process.env.AUTO_START_DEFAULT === "true";

const RECONNECT_BASE_MS = Number(process.env.RECONNECT_BASE_MS || 3000);
const RECONNECT_MAX_MS = Number(process.env.RECONNECT_MAX_MS || 120_000);
const QR_THROTTLE_MS = Number(process.env.QR_THROTTLE_MS || 15_000);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";

const AUTH_MODE = (process.env.AUTH_MODE || "").toLowerCase();

const supabase =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

/** Persist Baileys creds in whatsapp_baileys_auth (recommended on Railway). */
const useSupabaseAuth =
  AUTH_MODE === "supabase" ||
  (AUTH_MODE !== "filesystem" && Boolean(supabase));

if (AUTH_MODE === "supabase" && !supabase) {
  logger.fatal(
    "AUTH_MODE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)"
  );
  process.exit(1);
}

if (!useSupabaseAuth) {
  logger.warn(
    { AUTH_MODE: AUTH_MODE || "auto" },
    "auth_filesystem_ephemeral_on_railway_use_supabase_or_AUTH_MODE=supabase"
  );
}

const WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || "";
const API_SECRET = process.env.API_SECRET || "";
const ENABLE_EVENT_WRAPPER = process.env.ENABLE_EVENT_WRAPPER === "true";

function normalizeWebhookUrls(raw) {
  if (!raw) return { webhookUrl: "", sessionUrl: "" };
  let webhookUrl = raw.trim();
  if (webhookUrl.endsWith("/")) webhookUrl = webhookUrl.slice(0, -1);

  // Normalise to the canonical BFF incoming path
  if (webhookUrl.endsWith("/whatsapp/incoming")) {
    if (!webhookUrl.includes("/api/webhooks/")) {
      webhookUrl = webhookUrl.replace("/whatsapp/incoming", "/api/webhooks/whatsapp/incoming");
    }
  } else if (!webhookUrl.includes("/api/webhooks/")) {
    webhookUrl = `${webhookUrl}/api/webhooks/whatsapp/incoming`;
  }

  // Session-lifecycle events go to the same endpoint by default (single-endpoint panels).
  // Override with WHATSAPP_SESSION_WEBHOOK_URL if your panel uses a separate route.
  const sessionUrl =
    process.env.WHATSAPP_SESSION_WEBHOOK_URL ||
    webhookUrl.replace("/whatsapp/incoming", "/whatsapp/session");

  return { webhookUrl, sessionUrl };
}

const { webhookUrl: WEBHOOK_URL, sessionUrl: SESSION_WEBHOOK_URL } = normalizeWebhookUrls(
  process.env.WHATSAPP_WEBHOOK_URL || process.env.WEBHOOK_URL || ""
);

logger.info({ WEBHOOK_URL, SESSION_WEBHOOK_URL }, "webhook_urls_initialized");

const sessions = new Map();
const connectingNow = new Set();


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

function isUuid(s) {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
  );
}

function getOrCreateSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      log: childLogger(id),
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
      /** @type {string | null} */
      panelDeviceId: null,
      /** bound socket for messages.upsert */
      boundSock: null,
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
  } catch (e) {
    logger.warn({ err: String(e) }, "fetchLatestBaileysVersion_failed");
    return undefined;
  }
}

function clearReconnectTimer(session) {
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
}

async function updateSupabaseDevice(sessionId, data) {
  if (!supabase) return;
  const session = sessions.get(sessionId);
  try {
    let query = supabase.from("devices").update({ ...data, updated_date: nowIso() });
    if (isUuid(sessionId)) {
      query = query.eq("id", sessionId);
    } else {
      query = query.eq("session_data", sessionId);
    }
    const { error } = await query;
    if (error) {
      session?.log?.warn({ msg: error.message }, "devices_db_update_error");
    } else {
      session?.log?.info(
        { kind: data.qr_code ? "qr" : data.status || "status" },
        "devices_db_updated"
      );
    }
  } catch (err) {
    const session = sessions.get(sessionId);
    session?.log?.warn({ err: String(err) }, "devices_db_update_exception");
  }
}

/** Resolve panel devices.id for webhook (matches session_data = session id). */
async function resolvePanelDeviceId(session) {
  if (session.panelDeviceId && isUuid(session.panelDeviceId)) return session.panelDeviceId;
  if (isUuid(session.id)) {
    session.panelDeviceId = session.id;
    return session.id;
  }
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("id")
      .eq("session_data", session.id)
      .limit(1)
      .maybeSingle();
    if (error) {
      session.log.warn({ msg: error.message }, "resolve_device_id_error");
      return null;
    }
    if (data?.id) {
      session.panelDeviceId = data.id;
      session.log = session.log.child({ device_id: data.id });
      session.log.info({ deviceId: data.id }, "device_id_resolved");
      return data.id;
    }
  } catch (e) {
    session.log.warn({ err: String(e) }, "resolve_device_id_exception");
  }
  return null;
}

function requireApiAuth(req, res, next) {
  if (!API_SECRET) return next();
  const authHeader = req.headers.authorization || "";
  if (authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const webhookQueue = createQueue("webhooks", async (jobData) => {
  const { sessionId, body, targetUrl } = jobData;
  const session = sessions.get(sessionId) || { log: logger.child({ sessionId }) };
  
  if (!targetUrl) throw new Error("No targetUrl for webhook");

  session.log.info({ url: targetUrl, method: "POST" }, "webhook_dispatching");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  let res;
  try {
    res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": WEBHOOK_SECRET,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      session.log.error({ url: targetUrl }, "webhook_timeout");
      throw new Error("Webhook timeout after 10s");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "N/A");
    session.log.error(
      { 
        sessionId,
        status: res.status, 
        url: targetUrl, 
        response: responseBody.slice(0, 500), // Protect log size
        method: "POST"
      }, 
      "webhook_failed"
    );
    
    // Status-specific verbose logs for troubleshooting
    if (res.status === 404) {
      session.log.error({ sessionId, url: targetUrl }, "webhook_endpoint_not_found");
    } else if (res.status === 401) {
      session.log.error({ sessionId }, "webhook_unauthorized_check_secret");
    } else if (res.status === 400) {
      session.log.error({ sessionId, responseBody }, "webhook_bad_request_payload_mismatch");
    }

    throw new Error(`HTTP error! status: ${res.status}`);
  }

  session.log.debug({ sessionId, status: res.status, url: targetUrl }, "webhook_ok");
});

// Pause locally until we are elected leader if Redis is active
if (webhookQueue.worker && redisConnection) {
  webhookQueue.worker.pause();
}

async function postWebhook(session, structuredPayload) {
  if (!WEBHOOK_URL) {
    session.log.warn("WHATSAPP_WEBHOOK_URL not set; skipping webhook");
    return;
  }

  const deviceId = await resolvePanelDeviceId(session);

  // Prevent noisy webhook failures if the panel has no device matching this session.
  // This typically occurs for the 'default' session or manually started orphan sessions.
  if (!deviceId) {
    session.log.debug(
      { sessionId: session.id, event: structuredPayload.event },
      "webhook_skipped_no_panel_device"
    );
    return;
  }

  // The canonical session identifier sent to the panel must match devices.session_data.
  // If the session was started by UUID (panelDeviceId === session.id), the panel still
  // needs session_data in the payload so it can look up the row. We always send the
  // human/slug sessionId (session.id as stored in this process) as `sessionId` and the
  // UUID as `device_id` so the panel can correlate by either field.
  const canonicalSessionId = session.id;

  let finalBody = {};
  let targetUrl = WEBHOOK_URL;

  if (structuredPayload.type === "message" && !ENABLE_EVENT_WRAPPER) {
    // Flat legacy structure expected by most panel BFF routes
    finalBody = {
      ...structuredPayload.payload,
      sessionId: canonicalSessionId,
      device_id: deviceId,
    };
  } else if (structuredPayload.type === "connection") {
    // Session lifecycle events — always include device_id so the panel can
    // map the event without a secondary DB look-up.
    targetUrl = SESSION_WEBHOOK_URL;
    finalBody = {
      sessionId: canonicalSessionId,
      device_id: deviceId,
      event: structuredPayload.event,
      meta: structuredPayload.payload || {},
      timestamp: Date.now(),
    };
  } else {
    // Wrapped envelope mode
    finalBody = {
      type: structuredPayload.type,
      device_id: deviceId,
      sessionId: canonicalSessionId,
      event: structuredPayload.event,
      payload: structuredPayload.payload,
      timestamp: Date.now(),
    };
  }

  webhookQueue.add(
    "webhook",
    { sessionId: session.id, body: finalBody, targetUrl },
    {
      attempts: 5,
      backoff: { type: "exponential", delay: 2000 },
    }
  );
}

async function postIncomingWebhook(session, payload) {
  await postWebhook(session, {
    type: "message",
    event: "incoming_message",
    payload,
  });
}

/**
 * Register messages.upsert once per live socket so reconnect gets a fresh listener.
 */
function bindMessagesUpsert(session, sock) {
  const handler = async ({ messages, type }) => {
    if (session.sock !== sock) {
      session.log.debug({ type }, "messages.upsert_ignored_stale_socket");
      return;
    }
    if (type !== "notify") return;

    session.log.info({ count: messages?.length || 0, type }, "messages.upsert");

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;

      const isGroup = msg.key.remoteJid?.endsWith("@g.us");
      let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      let messageType = "text";
      if (msg.message.imageMessage) {
        messageType = "image";
        text = msg.message.imageMessage.caption || text;
      } else if (msg.message.documentMessage) messageType = "document";
      else if (msg.message.audioMessage) messageType = "audio";
      else if (msg.message.videoMessage) messageType = "video";

      const phone = msg.key.remoteJid.split("@")[0];

      await postIncomingWebhook(session, {
        from: phone,
        text,
        message_type: messageType,
        is_group: isGroup,
      });
    }
  };

  sock.ev.on("messages.upsert", handler);
  session.boundSock = sock;
  session.log.info("messages.upsert_listener_bound");
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
  session.boundSock = null;
  session.qrDataUrl = null;
  session.status = "closed";
  session.updatedAt = nowIso();

  await updateSupabaseDevice(session.id, { status: "disconnected", qr_code: null });

  if (removeAuth && session.authDir) {
    await fs.rm(session.authDir, { recursive: true, force: true });
  }
}

function reconnectDelayMs(session) {
  const exp = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * Math.pow(2, Math.min(session.reconnectAttempts, 8))
  );
  const jitter = Math.floor(Math.random() * 800);
  return exp + jitter;
}

function scheduleReconnect(session, forceDelayMs = null) {
  if (!session.shouldReconnect) return;
  clearReconnectTimer(session);
  session.status = "reconnecting";
  session.reconnectAttempts += 1;
  session.updatedAt = nowIso();
  session.lastQrSavedAt = 0;

  const delay = forceDelayMs ?? reconnectDelayMs(session);
  session.log.info({ delayMs: delay, attempt: session.reconnectAttempts }, "reconnect_scheduled");

  session.reconnectTimer = setTimeout(() => {
    connectSession(session.id, {}).catch((err) => {
      session.status = "error";
      session.lastError = err?.message || String(err);
      session.updatedAt = nowIso();
      session.log.error({ err: session.lastError }, "reconnect_connect_failed");
      scheduleReconnect(session);
    });
  }, delay);
}

async function handleQR(session, qr) {
  session.log.debug({ qrHash: qr.slice(0, 10) }, "handle_qr_event_received");
  
  let dataUrl;
  try {
    dataUrl = await QRCode.toDataURL(qr);
  } catch (err) {
    session.status = "error";
    session.lastError = err?.message || String(err);
    session.updatedAt = nowIso();
    session.log.error({ err: session.lastError }, "qr_encode_failed");
    return;
  }

  session.qrDataUrl = dataUrl;
  
  // Track previous status to see what we are transitioning from
  const oldStatus = session.status;
  session.status = "qr_ready";
  session.updatedAt = nowIso();

  const now = Date.now();
  const elapsed = now - session.lastQrSavedAt;

  if (elapsed < QR_THROTTLE_MS) {
    session.log.debug({ elapsed, oldStatus }, "qr_throttled_skip_db");
    return;
  }

  session.lastQrSavedAt = now;
  session.qrSaveCount += 1;
  session.log.info({ n: session.qrSaveCount, from: oldStatus }, "qr_saved_db");

  await updateSupabaseDevice(session.id, {
    qr_code: dataUrl,
    status: "scanning",
  });

  await postWebhook(session, {
    type: "connection",
    event: "qr",
    payload: { status: "scanning", qr_code: dataUrl }
  });
}

/**
 * @param {string} sessionId
 * @param {{ force?: boolean, panelDeviceId?: string | null }} opts
 */
async function connectSession(sessionId, opts = {}) {
  const force = Boolean(opts.force);
  const id = sanitizeSessionId(sessionId);
  if (!id) throw new Error("Invalid sessionId");

  if (opts.panelDeviceId && isUuid(opts.panelDeviceId)) {
    const s = getOrCreateSession(id);
    s.panelDeviceId = opts.panelDeviceId;
    s.log = s.log.child({ device_id: opts.panelDeviceId });
    s.log.info({ deviceId: opts.panelDeviceId }, "device_id_from_connect_body");
  }

  if (connectingNow.has(id)) {
    logger.warn({ id }, "connect_skip_already_connecting");
    return getOrCreateSession(id);
  }

  const session = getOrCreateSession(id);

  if (
    !force &&
    (session.status === "connected" || session.status === "connecting" || session.status === "qr_ready")
  ) {
    const elapsed = Date.now() - new Date(session.updatedAt).getTime();
    if (elapsed < 30_000) {
      session.log.info({ status: session.status }, "connect_skip_recent_state");
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
      session.log.info("ending_previous_socket");
      try {
        session.sock.end(new Error("Restarting session"));
      } catch {}
      session.sock = null;
    }

    const authDir = await resolveAuthDir(id);
    session.authDir = authDir;

    let state;
    let saveCreds;

    if (useSupabaseAuth && supabase) {
      session.log.info("auth_state_supabase");
      const auth = await useSupabaseAuthState(supabase, id, {
        debug: process.env.AUTH_DEBUG === "true",
        log: (msg, extra) => session.log.debug({ ...extra, msg }, "auth_kv"),
      });
      state = auth.state;
      saveCreds = auth.saveCreds;
    } else {
      session.log.info({ authDir }, "auth_state_filesystem");
      await fs.mkdir(authDir, { recursive: true });
      const auth = await useMultiFileAuthState(authDir);
      state = auth.state;
      saveCreds = auth.saveCreds;
    }

    const version = await getBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      browser: Browsers.macOS("Desktop"),
      version,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000, // Keep stream alive
      retryRequestDelayMs: 2000,   // Be more patient with retries
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      logger: createBaileysLogger(),
    });

    session.sock = sock;
    session.status = "connecting";
    session.qrDataUrl = null;
    session.updatedAt = nowIso();

    sock.ev.on("creds.update", async () => {
      if (session.sock !== sock) return;
      try {
        await saveCreds();
        session.log.debug("creds_saved_success");
      } catch (err) {
        session.log.error({ err: err.message }, "creds_save_failed");
      }
    });

    bindMessagesUpsert(session, sock);

    sock.ev.on("connection.update", async (update) => {
      if (session.sock !== sock) return;
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        // Debounce: suppress new QRs when already connected or freshly in the
        // QR handshake window (status is "qr_ready" or "scanning") to avoid
        // overwriting a pairing in progress.
        const now = Date.now();
        const stateAge = now - new Date(session.updatedAt || 0).getTime();
        const inHandshake =
          session.status === "qr_ready" ||
          session.status === "scanning" ||
          session.status === "connected";
        if (inHandshake && stateAge < QR_THROTTLE_MS) {
          session.log.debug(
            { status: session.status, stateAge },
            "qr_ignored_during_handshake"
          );
          return;
        }
        await handleQR(session, qr);
      }

      if (connection === "open") {
        session.status = "connected";
        session.qrDataUrl = null;
        session.reconnectAttempts = 0;
        session.lastDisconnectCode = null;
        session.lastError = null;
        session.lastQrSavedAt = 0;
        session.updatedAt = nowIso();
        session.log.info("connection_open");

        // Eagerly persist device_id so every subsequent webhook includes it.
        await resolvePanelDeviceId(session);

        const phoneNumber =
          sock.user?.id?.split(":")[0]?.split("@")[0] || null;
        const profileName =
          sock.user?.name ||
          sock.user?.verifiedName ||
          phoneNumber ||
          "WhatsApp Device";

        await updateSupabaseDevice(id, {
          status: "connected",
          phone_number: phoneNumber,
          name: profileName,
          qr_code: null,
        });

        await postWebhook(session, {
          type: "connection",
          event: "connected",
          payload: { phone_number: phoneNumber, name: profileName },
        });
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ?? null;
        const reason = lastDisconnect?.error?.message ?? "unknown";
        session.lastDisconnectCode = statusCode;
        session.updatedAt = nowIso();
        session.sock = null;

        // 515 = stream replaced / server-side reset
        const isStreamError = statusCode === 515;
        // Closed while the user was scanning the QR — likely the normal
        // "restart after pairing" event.  Do NOT count this as a hard error.
        const wasPairing =
          session.status === "qr_ready" || session.status === "scanning";

        session.log.warn(
          {
            statusCode,
            reason,
            currentStatus: session.status,
            isStreamError,
            wasPairing,
          },
          "connection_close"
        );

        if (statusCode === DisconnectReason.loggedOut) {
          session.status = "logged_out";
          session.shouldReconnect = false;
          session.qrDataUrl = null;
          await updateSupabaseDevice(id, { status: "disconnected", qr_code: null });
          // Fire-and-forget — we are shutting down this session anyway.
          postWebhook(session, {
            type: "connection",
            event: "disconnected",
            payload: { reason: "logged_out" },
          });
          return;
        }

        if (wasPairing || isStreamError) {
          // Transition to a neutral status so that a new QR from the server
          // does NOT get suppressed by the debounce check above.
          session.status = "connecting";
          session.log.info(
            { statusCode, isStreamError, wasPairing },
            "disconnect_during_handshake_will_resume_shortly"
          );
        }

        // Notify the panel about the transient error.
        postWebhook(session, {
          type: "connection",
          event: "error",
          payload: { statusCode, reason },
        });

        // Longer delay for stream errors and pairing interruptions to let the
        // WhatsApp server fully process the credential exchange before we try again.
        let delayMs;
        if (isStreamError) delayMs = 8_000;
        else if (wasPairing) delayMs = 5_000;
        scheduleReconnect(session, delayMs);
      }
    });

    return session;
  } finally {
    connectingNow.delete(id);
  }
}

app.get("/", (_req, res) => {
  res.json({
    service: "whatsapp-server",
    baileys: true,
    health: "/health",
    auth: useSupabaseAuth ? "supabase" : "filesystem",
    docs: "Use POST /sessions/:sessionId/connect and GET /sessions/:sessionId/status",
  });
});

app.get("/internal/metrics/webhooks", requireApiAuth, async (req, res) => {
  try {
    const data = await webhookQueue.getMetrics();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/sessions/:sessionId/qr/image", requireApiAuth, (req, res) => {
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
  } catch {
    res.status(500).send("Error");
  }
});

app.post("/sessions/:sessionId/connect", requireApiAuth, async (req, res) => {
  try {
    const bodyDeviceId = req.body?.device_id;
    const panelDeviceId = isUuid(bodyDeviceId) ? bodyDeviceId : null;
    const session = await connectSession(req.params.sessionId, {
      force: Boolean(req.body?.force),
      panelDeviceId,
    });
    res.json({
      status: true,
      sessionId: session.id,
      panelDeviceId: session.panelDeviceId || null,
      auth: useSupabaseAuth ? "supabase" : "filesystem",
    });
  } catch (error) {
    res.status(400).json({ status: false, message: error.message });
  }
});

app.post("/sessions/:sessionId/disconnect", requireApiAuth, async (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) return res.status(400).json({ error: "Invalid ID" });
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    const logout = Boolean(req.body?.logout);
    const removeAuth = Boolean(req.body?.removeAuth);
    await closeSession(session, { logout, removeAuth });
    res.json({ success: true, status: "disconnected" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/sessions/:sessionId/status", requireApiAuth, (req, res) => {
  const id = sanitizeSessionId(req.params.sessionId);
  if (!id) return res.status(400).json({ status: "disconnected", connected: false });
  const session = sessions.get(id);
  if (!session) return res.status(404).json({ status: "disconnected", connected: false });

  res.json({
    status: session.status,
    connected: session.status === "connected",
    qr: Boolean(session.qrDataUrl),
    updatedAt: session.updatedAt,
    panelDeviceId: session.panelDeviceId || null,
    reconnectAttempts: session.reconnectAttempts,
  });
});

app.post("/sessions/:sessionId/send", requireApiAuth, async (req, res) => {
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
    const cleanTo = String(to).replace(/\D/g, "");
    const jid = `${cleanTo}@s.whatsapp.net`;

    if (!session.sendQueue) session.sendQueue = Promise.resolve();

    const doSend = async () => {
      if (mediaUrl) {
        await session.sock.sendMessage(jid, {
          image: { url: mediaUrl },
          caption: caption || text || "",
        });
      } else {
        await session.sock.sendMessage(jid, { text });
      }
    };

    session.sendQueue = session.sendQueue
      .then(() => new Promise((resolve) => setTimeout(resolve, 1000))) // 1s rate limit
      .then(doSend);

    await session.sendQueue;

    session.log.info({ to: cleanTo }, "send_ok");
    res.json({ success: true, status: "sent" });
  } catch (err) {
    session.log.error({ err: err?.message }, "send_error");
    res.status(500).json({ error: err.message });
  }
});

app.get("/send", requireApiAuth, async (req, res) => {
  const { to, message, sessionId } = req.query;
  const targetId = sanitizeSessionId(sessionId) || DEFAULT_SESSION_ID;
  if (!to || !message || !targetId) return res.json({ status: false, message: "Missing required fields" });
  try {
    const session = sessions.get(targetId);
    if (!session || session.status !== "connected" || !session.sock) {
      return res.json({ status: false, message: "Device not connected" });
    }
    
    if (!session.sendQueue) session.sendQueue = Promise.resolve();
    
    session.sendQueue = session.sendQueue
      .then(() => new Promise((r) => setTimeout(r, 1000)))
      .then(() => session.sock.sendMessage(`${String(to).replace(/\D/g, "")}@s.whatsapp.net`, { text: message }));

    await session.sendQueue;
    res.json({ status: true });
  } catch (err) {
    res.json({ status: false, message: err.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: true,
    auth: useSupabaseAuth ? "supabase" : "filesystem",
    webhookConfigured: Boolean(WEBHOOK_URL),
    sessions: [...sessions.values()].map((s) => ({
      id: s.id,
      status: s.status,
      panelDeviceId: s.panelDeviceId || null,
    })),
  });
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, auth: useSupabaseAuth ? "supabase" : "filesystem" }, "listening");
});

async function autoStartSavedSessions() {
  if (!supabase || !currentIsLeader()) return;
  try {
    const { data: devices, error } = await supabase
      .from("devices")
      .select("id, session_data, status");
    if (error) throw error;

    const activeDevices = (devices || []).filter(
      (d) => !["deleted", "disconnected"].includes(d.status)
    );

    logger.info({ count: activeDevices.length }, "auto_start_finding_active_devices");

    let delay = 0;
    for (const device of activeDevices) {
      // Always prefer session_data (the canonical slug stored in the panel DB).
      // Fall back to the UUID only when session_data is absent so that
      // resolvePanelDeviceId can still match the row via devices.id.
      const sessionId =
        device.session_data && device.session_data.trim()
          ? device.session_data.trim()
          : device.id;

      logger.info(
        { id: sessionId, deviceId: device.id, session_data: device.session_data },
        "auto_starting_saved_session"
      );

      setTimeout(() => {
        connectSession(sessionId, { panelDeviceId: device.id }).catch((err) => {
          logger.error({ id: sessionId, err: String(err) }, "auto_start_saved_failed");
        });
      }, delay);

      delay += 1500; // Stagger startups to avoid thundering-herd on Baileys
    }
  } catch (err) {
    logger.error({ err: String(err) }, "auto_start_saved_sessions_error");
  }
}

if (AUTO_START_DEFAULT) {
  connectSession(DEFAULT_SESSION_ID, {}).catch((err) => logger.error({ err: String(err) }, "auto_start_failed"));
}

setTimeout(async () => {
  await initLeaderElection(
    redisConnection,
    // onElected
    () => {
      if (webhookQueue.worker) webhookQueue.worker.resume();
      autoStartSavedSessions();
    },
    // onDemoted
    () => {
      if (webhookQueue.worker) webhookQueue.worker.pause();
      // Optional: stop active sessions if strict single-active needed
    }
  );
  if (currentIsLeader()) {
    autoStartSavedSessions();
  }
}, 2000);

async function shutdown() {
  logger.info("shutdown");
  for (const session of sessions.values()) await closeSession(session);
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
