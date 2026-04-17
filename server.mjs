import * as dotenv from "dotenv";
dotenv.config();

import { inspect } from "node:util";
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
import { getChatId } from "@whiskeysockets/baileys/lib/Utils/process-message.js";
import { useSupabaseAuthState } from "./lib/useSupabaseAuthState.mjs";
import { logger, childLogger, createBaileysLogger } from "./lib/logger.mjs";
import { createQueue, redisConnection } from "./lib/queues.mjs";
import { initLeaderElection, currentIsLeader } from "./lib/leader.mjs";
import {
  tryAcquireSessionOwnerLock,
  releaseSessionOwnerLock,
  renewSessionOwnerLock,
} from "./lib/sessionRedisLock.mjs";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const AUTH_ROOT = path.resolve(process.env.AUTH_ROOT || "auth_info");
const DEFAULT_SESSION_ID = sanitizeSessionId(process.env.DEFAULT_SESSION_ID || "default") || "default";
// By default, only auto-start based on devices DB in production.
const AUTO_START_DEFAULT = process.env.AUTO_START_DEFAULT === "true";
/** Set WHATSAPP_DISABLE_AUTO_START_SAVED=1 to skip DB-driven session startup (debug / single-device tests). */
const AUTO_START_SAVED_ENABLED = process.env.WHATSAPP_DISABLE_AUTO_START_SAVED !== "true";
/** Set WHATSAPP_DEBUG_DISCONNECT=1 to log raw lastDisconnect once and stop reconnect for that process. */
const DEBUG_DISCONNECT = process.env.WHATSAPP_DEBUG_DISCONNECT === "1";

const RECONNECT_BASE_MS = Number(process.env.RECONNECT_BASE_MS || 3000);
const RECONNECT_MAX_MS = Number(process.env.RECONNECT_MAX_MS || 120_000);
const QR_THROTTLE_MS = Number(process.env.QR_THROTTLE_MS || 15_000);
/** When Redis is set, require exclusive session ownership (multi-replica Railway). Set WA_SESSION_REDIS_LOCK=false to disable. */
const WA_SESSION_REDIS_LOCK = process.env.WA_SESSION_REDIS_LOCK !== "false";
/** Optional pinned Baileys web version JSON, e.g. [2,3000,0] — avoids fetch/version drift vs stored keys. */
const BAILEYS_VERSION_JSON = process.env.BAILEYS_VERSION_JSON || "";
/** Set DEVICES_EXTENDED_FIELDS=false if `devices` has no whatsapp_jid / last_connected_at yet. */
const DEVICES_EXTENDED_FIELDS = process.env.DEVICES_EXTENDED_FIELDS !== "false";

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
if (DEBUG_DISCONNECT) {
  logger.warn(
    "WHATSAPP_DEBUG_DISCONNECT=1: first close logs raw_last_disconnect; reconnect_blocked_debug_mode stops auto-reconnect"
  );
  if (AUTO_START_SAVED_ENABLED) {
    logger.warn(
      "WHATSAPP_DEBUG_DISCONNECT=1: also set WHATSAPP_DISABLE_AUTO_START_SAVED=1 to skip DB auto-start noise"
    );
  }
}
if (!AUTO_START_SAVED_ENABLED) {
  logger.info("WHATSAPP_DISABLE_AUTO_START_SAVED=1: auto_start_saved_sessions disabled");
}

const sessions = new Map();
const connectingNow = new Set();


let cachedBaileysVersion;

function nowIso() {
  return new Date().toISOString();
}

/** Panel/Supabase `devices` row timestamp — must match DB column (usually `updated_at`). */
function devicesUpdatedPayload() {
  return { updated_at: nowIso() };
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

/** Boom, Error, or arbitrary value → safe string for logs / webhook payloads (never pass raw objects as socket data). */
function safeErrorMessage(err) {
  if (err == null) return "unknown";
  if (typeof err === "string") return err.slice(0, 4000);
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  if (typeof err?.message === "string" && err.message) return err.message.slice(0, 4000);
  try {
    const s = JSON.stringify(err);
    if (s && s !== "{}") return s.slice(0, 2000);
  } catch {}
  try {
    return String(err).slice(0, 2000);
  } catch {
    return "unserializable_error";
  }
}

/**
 * First-disconnect debug: only string/primitive fields (no raw error objects in log payload).
 */
function rawDisconnectDebugFields(lastDisconnect) {
  const err = lastDisconnect?.error;
  const rawInspect = inspect(lastDisconnect, {
    depth: 10,
    maxStringLength: 12_000,
    breakLength: 120,
    compact: false,
  });
  let raw_error_constructor_name = "n/a";
  if (err != null && typeof err === "object" && err.constructor?.name) {
    raw_error_constructor_name = String(err.constructor.name);
  } else if (err == null) {
    raw_error_constructor_name = "null";
  } else {
    raw_error_constructor_name = typeof err;
  }
  let raw_error_keys = "n/a";
  if (err != null && typeof err === "object") {
    try {
      raw_error_keys = JSON.stringify(Object.keys(err).slice(0, 64));
    } catch {
      raw_error_keys = "keys_unavailable";
    }
  }
  const raw_error_message_if_present =
    typeof err?.message === "string" ? err.message.slice(0, 4000) : "";
  const raw_error_stack_if_present =
    typeof err?.stack === "string" ? err.stack.slice(0, 8000) : "";
  return {
    rawInspect,
    raw_error_constructor_name,
    raw_error_keys,
    raw_error_message_if_present,
    raw_error_stack_if_present,
  };
}

/**
 * Normalize Baileys connection.update lastDisconnect (Boom, Error, plain object).
 */
function normalizeDisconnect(lastDisconnect) {
  const err = lastDisconnect?.error;
  const outputStatusCode =
    err != null && typeof err === "object" && typeof err.output?.statusCode === "number"
      ? err.output.statusCode
      : null;
  let statusCode = outputStatusCode;
  if (statusCode == null && typeof err === "number") statusCode = err;

  const rawDr = lastDisconnect?.disconnectReason;
  let disconnectReasonName = null;
  if (typeof rawDr === "number" && typeof DisconnectReason === "object" && DisconnectReason != null) {
    disconnectReasonName =
      Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === rawDr) || null;
  }

  return {
    reason: safeErrorMessage(err),
    statusCode,
    outputStatusCode,
    disconnectReasonCode: typeof rawDr === "number" ? rawDr : null,
    disconnectReasonName,
    disconnect_parse_source: err != null ? "lastDisconnect.error" : "lastDisconnect_empty",
  };
}

/**
 * Close Baileys socket without stripping event listeners or calling ws.close() with odd state
 * (those paths have triggered Node "data must be string or Buffer" errors with Baileys 7).
 */
function cleanupBaileysSocket(session, sock) {
  if (!sock) return;
  try {
    if (typeof sock.end === "function") sock.end();
  } catch (e) {
    session.log.debug({ err: safeErrorMessage(e) }, "socket_end_failed");
  }
  if (session.boundSock === sock) session.boundSock = null;
  session.log.info({ sessionId: session.id }, "socket_cleanup_complete");
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
      /** @type {ReturnType<typeof setInterval> | null} */
      ownerLockRenewInterval: null,
      /** @type {string | null} */
      linkedPhone: null,
      /** @type {string | null} */
      linkedName: null,
      /** @type {string | null} */
      linkedWaJid: null,
      /** @type {string | null} */
      connectionOpenedAt: null,
    });
  }
  return sessions.get(id);
}

async function resolveAuthDir(sessionId) {
  return path.join(AUTH_ROOT, sessionId);
}

async function getBaileysVersion() {
  if (cachedBaileysVersion) return cachedBaileysVersion;
  if (BAILEYS_VERSION_JSON.trim()) {
    try {
      const parsed = JSON.parse(BAILEYS_VERSION_JSON);
      if (Array.isArray(parsed) && parsed.length >= 1) {
        cachedBaileysVersion = parsed;
        logger.info({ version: cachedBaileysVersion }, "baileys_version_pinned_from_env");
        return cachedBaileysVersion;
      }
    } catch (e) {
      logger.warn({ err: String(e) }, "BAILEYS_VERSION_JSON_invalid");
    }
  }
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedBaileysVersion = version;
    return version;
  } catch (e) {
    logger.warn({ err: String(e) }, "fetchLatestBaileysVersion_failed");
    return undefined;
  }
}

/**
 * Linked WhatsApp account from Baileys sock.user (PN vs LID — prefer digits when present).
 */
function extractLinkedWaAccount(sock) {
  const u = sock?.user;
  if (!u) {
    return { phoneNumber: null, profileName: null, waJid: null };
  }
  const rawId = u.id != null ? String(u.id) : u.jid != null ? String(u.jid) : "";
  const waJid = rawId || null;
  let phoneNumber = null;
  if (waJid && waJid.includes("@")) {
    const userPart = waJid.split("@")[0];
    const head = userPart.includes(":") ? userPart.split(":")[0] : userPart;
    const digits = head.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) phoneNumber = digits;
  }
  const profileName =
    (typeof u.name === "string" && u.name.trim()) ||
    (typeof u.verifiedName === "string" && u.verifiedName.trim()) ||
    (typeof u.notify === "string" && u.notify.trim()) ||
    phoneNumber ||
    null;
  return { phoneNumber, profileName, waJid };
}

/** True “can send” — not only status === connected (avoids false positives right after open). */
function isSessionSendReady(session) {
  if (!session?.sock) return { ok: false, reason: "no_socket" };
  if (session.status !== "connected") return { ok: false, reason: `status_${session.status}` };
  const ws = session.sock.ws;
  if (ws && typeof ws.readyState === "number" && ws.readyState !== 1) {
    return { ok: false, reason: `ws_readyState_${ws.readyState}` };
  }
  if (!session.sock.user?.id && !session.sock.user?.jid) {
    return { ok: false, reason: "no_baileys_user" };
  }
  return { ok: true, reason: "ready" };
}

function clearSessionOwnerLockRenewal(session) {
  if (session.ownerLockRenewInterval) {
    clearInterval(session.ownerLockRenewInterval);
    session.ownerLockRenewInterval = null;
  }
}

function startSessionOwnerLockRenewal(session) {
  if (!redisConnection || !WA_SESSION_REDIS_LOCK) return;
  clearSessionOwnerLockRenewal(session);
  session.ownerLockRenewInterval = setInterval(() => {
    renewSessionOwnerLock(session.id).catch(() => {});
  }, 60_000);
}

function clearReconnectTimer(session) {
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
}

async function updateSupabaseDevice(sessionId, data) {
  if (!supabase) return;
  const session = sessions.get(sessionId);
  try {
    let query = supabase.from("devices").update({ ...data, ...devicesUpdatedPayload() });
    if (session?.panelDeviceId && isUuid(session.panelDeviceId)) {
      query = query.eq("id", session.panelDeviceId);
    } else if (isUuid(sessionId)) {
      query = query.eq("id", sessionId);
    } else {
      query = query.eq("session_data", sessionId);
    }
    const { error } = await query;
    if (error) {
      session?.log?.warn(
        {
          msg: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
          devices_column: "updated_at",
        },
        "devices_db_update_error"
      );
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

/**
 * Bind panel devices.id to this Baileys session key (devices.session_data).
 * Call on connect when the panel sends the canonical device UUID.
 */
async function bindPanelDeviceToSession(session, panelDeviceId) {
  if (!supabase || !panelDeviceId || !isUuid(panelDeviceId)) return;
  try {
    const { error } = await supabase
      .from("devices")
      .update({ session_data: session.id, ...devicesUpdatedPayload() })
      .eq("id", panelDeviceId);
    if (error) {
      session.log.warn(
        {
          msg: error.message,
          code: error.code,
          details: error.details,
          panelDeviceId,
          devices_column: "updated_at",
        },
        "bind_panel_device_session_data_failed"
      );
      return;
    }
    session.panelDeviceId = panelDeviceId;
    session.log.info(
      { panel_device_id: panelDeviceId, sessionId: session.id },
      "panel_device_session_data_bound"
    );
  } catch (e) {
    session.log.warn({ err: String(e), panelDeviceId }, "bind_panel_device_exception");
  }
}

/**
 * Resolve panel devices.id for webhooks — only UUIDs that exist in `devices`.
 * Never treat an arbitrary UUID session slug as devices.id without a DB row.
 */
async function resolvePanelDeviceId(session) {
  if (!supabase) {
    if (session.panelDeviceId && isUuid(session.panelDeviceId)) return session.panelDeviceId;
    return null;
  }
  try {
    const { data: bySessionData, error: err1 } = await supabase
      .from("devices")
      .select("id")
      .eq("session_data", session.id)
      .limit(1)
      .maybeSingle();
    if (err1) session.log.warn({ msg: err1.message }, "resolve_device_id_session_data_error");
    if (bySessionData?.id) {
      session.panelDeviceId = bySessionData.id;
      session.log = session.log.child({ device_id: bySessionData.id });
      session.log.info({ deviceId: bySessionData.id }, "device_id_resolved_by_session_data");
      return bySessionData.id;
    }

    if (isUuid(session.id)) {
      const { data: byId, error: err2 } = await supabase
        .from("devices")
        .select("id")
        .eq("id", session.id)
        .limit(1)
        .maybeSingle();
      if (err2) session.log.warn({ msg: err2.message }, "resolve_device_id_uuid_error");
      if (byId?.id) {
        session.panelDeviceId = byId.id;
        session.log = session.log.child({ device_id: byId.id });
        session.log.info({ deviceId: byId.id }, "device_id_resolved_by_devices_id");
        return byId.id;
      }
    }

    if (session.panelDeviceId && isUuid(session.panelDeviceId)) {
      const { data: byPanel, error: err3 } = await supabase
        .from("devices")
        .select("id")
        .eq("id", session.panelDeviceId)
        .limit(1)
        .maybeSingle();
      if (err3) {
        session.log.warn({ msg: err3.message }, "resolve_device_id_panel_hint_error");
        return null;
      }
      if (byPanel?.id) {
        session.panelDeviceId = byPanel.id;
        session.log = session.log.child({ device_id: byPanel.id });
        session.log.info({ deviceId: byPanel.id }, "device_id_resolved_by_connect_hint");
        return byPanel.id;
      }
      session.log.warn(
        { stale_panel_device_id: session.panelDeviceId, sessionId: session.id },
        "panel_device_id_not_in_db_clearing"
      );
      session.panelDeviceId = null;
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

  session.panelDeviceId = deviceId;

  // Canonical session key = Baileys session id (matches devices.session_data after bind).
  const canonicalSessionId = session.id;

  session.log.info(
    {
      sessionId: canonicalSessionId,
      panel_device_id: deviceId,
      outgoing_webhook_device_id: deviceId,
      event: structuredPayload.event,
    },
    "webhook_identity"
  );

  let finalBody = {};
  let targetUrl = WEBHOOK_URL;

  if (structuredPayload.type === "message" && !ENABLE_EVENT_WRAPPER) {
    // Flat legacy structure expected by most panel BFF routes
    finalBody = {
      ...structuredPayload.payload,
      sessionId: canonicalSessionId,
      device_id: deviceId,
      panel_device_id: deviceId,
    };
  } else if (structuredPayload.type === "connection") {
    // Session lifecycle events — always include device_id so the panel can
    // map the event without a secondary DB look-up.
    targetUrl = SESSION_WEBHOOK_URL;
    finalBody = {
      sessionId: canonicalSessionId,
      device_id: deviceId,
      panel_device_id: deviceId,
      event: structuredPayload.event,
      meta: structuredPayload.payload || {},
      timestamp: Date.now(),
    };
  } else {
    // Wrapped envelope mode
    finalBody = {
      type: structuredPayload.type,
      device_id: deviceId,
      panel_device_id: deviceId,
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

/** Serialize Baileys IMessageKey for JSON / panel BFF (strings only). */
function serializeMessageKeyPlain(key) {
  if (!key || typeof key !== "object") return {};
  const out = {};
  for (const name of [
    "id",
    "remoteJid",
    "participant",
    "participantAlt",
    "remoteJidAlt",
    "participantLid",
    "senderLid",
    "senderPn",
  ]) {
    const v = key[name];
    if (v != null && v !== "") out[name] = String(v);
  }
  if (typeof key.fromMe === "boolean") out.fromMe = key.fromMe;
  return out;
}

function digitsFromWaJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  const user = jid.split("@")[0];
  return user.split(":")[0].replace(/\D/g, "");
}

/** Full inbound identity for panel reply routing (preserves JIDs; legacy `from` = digits). */
function buildIncomingWebhookPayload(msg, { text, messageType, isGroup }) {
  const keyPlain = serializeMessageKeyPlain(msg.key);
  const chatId = getChatId({
    remoteJid: msg.key?.remoteJid,
    participant: msg.key?.participant,
    fromMe: msg.key?.fromMe,
  });
  const senderJid = isGroup ? msg.key?.participant || "" : msg.key?.remoteJid || "";
  const legacyFrom = digitsFromWaJid(senderJid || chatId || msg.key?.remoteJid);

  return {
    from: legacyFrom,
    text,
    message_type: messageType,
    is_group: isGroup,
    key: keyPlain,
    message: { key: { ...keyPlain } },
    pushName: msg.pushName != null ? String(msg.pushName) : "",
    fromMe: Boolean(msg.key?.fromMe),
    chat_id: chatId ? String(chatId) : "",
    sender_jid: senderJid ? String(senderJid) : "",
    conversation_jid: msg.key?.remoteJid ? String(msg.key.remoteJid) : "",
    raw_remote_jid: msg.key?.remoteJid ? String(msg.key.remoteJid) : "",
    raw_participant_jid: msg.key?.participant ? String(msg.key.participant) : "",
    reply_target_jid: chatId ? String(chatId) : "",
    key_id: keyPlain.id || "",
    key_remoteJid: keyPlain.remoteJid || "",
    key_participant: keyPlain.participant || "",
    key_participantAlt: keyPlain.participantAlt || "",
    key_remoteJidAlt: keyPlain.remoteJidAlt || "",
    message_key_id: keyPlain.id || "",
    message_key_remoteJid: keyPlain.remoteJid || "",
    message_key_participant: keyPlain.participant || "",
    message_key_fromMe: typeof keyPlain.fromMe === "boolean" ? keyPlain.fromMe : false,
  };
}

/**
 * Outbound send: preserve full JIDs (e.g. …@lid, …@g.us). Legacy digit-only strings become …@s.whatsapp.net.
 * Do not run global \\D stripping — that destroys @lid and breaks reply routing.
 */
/** Map Baileys/sendMessage failures to actionable categories for logs and clients. */
function classifyOutboundSendError(err) {
  const msg = safeErrorMessage(err).toLowerCase();
  if (!msg || msg === "unknown") return "unknown";
  if (msg.includes("bad mac") || msg.includes("badmac") || msg.includes("decrypt"))
    return "crypto_session_degraded";
  if (msg.includes("not-authorized") || msg.includes("401") || msg.includes("logged out"))
    return "session_auth_invalid";
  if (msg.includes("not registered") || msg.includes("not on whatsapp"))
    return "recipient_invalid";
  if (msg.includes("connection") && (msg.includes("closed") || msg.includes("lost")))
    return "socket_not_connected";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (msg.includes("conflict") || msg.includes("stream")) return "stream_conflict";
  return "send_failed_other";
}

function normalizeOutboundRecipient(raw) {
  const s0 = String(raw ?? "").trim();
  if (!s0) {
    return { jid: "", outbound_to_kind: "invalid" };
  }
  if (!s0.includes("@")) {
    const digits = s0.replace(/\D/g, "");
    if (!digits) {
      return { jid: "", outbound_to_kind: "invalid" };
    }
    const jid = `${digits}@s.whatsapp.net`;
    return { jid, outbound_to_kind: "digits_legacy_pn" };
  }
  const at = s0.lastIndexOf("@");
  const userRaw = s0.slice(0, at).trim();
  const domain = s0.slice(at + 1).trim().toLowerCase();
  const user = userRaw.replace(/^\+/, "");
  const jid = `${user}@${domain}`;
  let outbound_to_kind = "full_jid_other";
  if (domain === "lid") outbound_to_kind = "lid";
  else if (domain === "g.us") outbound_to_kind = "group";
  else if (domain === "s.whatsapp.net" || domain === "c.us") outbound_to_kind = "pn";
  return { jid, outbound_to_kind };
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

      const payload = buildIncomingWebhookPayload(msg, {
        text,
        messageType,
        isGroup,
      });

      session.log.info(
        {
          sessionId: session.id,
          chat_id: payload.chat_id,
          reply_target_jid: payload.reply_target_jid,
          key_remoteJid: payload.key_remoteJid,
          sender_jid: payload.sender_jid,
          from_digits_legacy: payload.from,
          has_full_remote_jid: Boolean(payload.key_remoteJid),
        },
        "webhook_inbound_identity_snapshot"
      );

      if (!payload.key_remoteJid) {
        session.log.warn(
          { sessionId: session.id, from_digits_legacy: payload.from },
          "webhook_inbound_identity_low_confidence"
        );
      }

      await postIncomingWebhook(session, payload);
    }
  };

  sock.ev.on("messages.upsert", handler);
  session.boundSock = sock;
  session.log.info("messages.upsert_listener_bound");
}

async function closeSession(session, { logout = false, removeAuth = false } = {}) {
  session.shouldReconnect = false;
  clearReconnectTimer(session);
  clearSessionOwnerLockRenewal(session);
  await releaseSessionOwnerLock(session.id);

  if (session.sock) {
    try {
      if (logout) await session.sock.logout();
    } catch {}
    cleanupBaileysSocket(session, session.sock);
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
  if (DEBUG_DISCONNECT) {
    session.log.info("reconnect_skipped_debug_mode");
    return;
  }
  if (!session.shouldReconnect) return;
  clearReconnectTimer(session);
  session.status = "reconnecting";
  session.reconnectAttempts += 1;
  session.updatedAt = nowIso();
  session.lastQrSavedAt = 0;

  const delay = forceDelayMs ?? reconnectDelayMs(session);
  session.log.info({ delayMs: delay, attempt: session.reconnectAttempts }, "reconnect_scheduled");

  session.reconnectTimer = setTimeout(() => {
    const panelDeviceId =
      session.panelDeviceId && isUuid(session.panelDeviceId) ? session.panelDeviceId : undefined;
    connectSession(session.id, panelDeviceId ? { panelDeviceId } : {}).catch((err) => {
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
  session.status = "qr_pending";
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
    status: "qr_pending",
  });

  await postWebhook(session, {
    type: "connection",
    event: "qr",
    payload: { status: "qr_pending", qr_code: dataUrl }
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
    await bindPanelDeviceToSession(s, opts.panelDeviceId);
  }

  if (connectingNow.has(id)) {
    const s = getOrCreateSession(id);
    s.log.info({ sessionId: id }, "reconnect_skipped_already_connecting");
    return s;
  }

  const session = getOrCreateSession(id);

  // QR pairing / stream resets call connect again without a body; reaffirm session_data so
  // lookups stay aligned (idempotent UPDATE).
  if (!opts.panelDeviceId && session.panelDeviceId && isUuid(session.panelDeviceId)) {
    await bindPanelDeviceToSession(session, session.panelDeviceId);
  }

  if (
    !force &&
    (session.status === "connected" || session.status === "connecting" || session.status === "qr_pending")
  ) {
    const elapsed = Date.now() - new Date(session.updatedAt).getTime();
    if (elapsed < 30_000) {
      session.log.info({ status: session.status }, "connect_skip_recent_state");
      return session;
    }
  }

  let socketCreated = false;

  try {
    connectingNow.add(id);
    if (redisConnection && WA_SESSION_REDIS_LOCK) {
      const lock = await tryAcquireSessionOwnerLock(id);
      if (!lock.acquired) {
        connectingNow.delete(id);
        throw new Error(
          `Session is owned by another instance (Redis lock holder: ${lock.owner}). Use a single active replica or wait for release.`
        );
      }
      if (!lock.failOpen) {
        session.log.info(
          { reentrant: lock.reentrant === true },
          "session_owner_lock_acquired"
        );
      }
    }
    session.shouldReconnect = true;
    session.lastError = null;
    session.lastQrSavedAt = 0;
    session.updatedAt = nowIso();
    clearReconnectTimer(session);

    if (session.sock) {
      session.log.info("ending_previous_socket");
      cleanupBaileysSocket(session, session.sock);
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
    socketCreated = true;
    session.status = "connecting";
    session.qrDataUrl = null;
    session.updatedAt = nowIso();

    const hangGuard = setTimeout(() => {
      if (connectingNow.has(id) && session.sock === sock) {
        connectingNow.delete(id);
        clearSessionOwnerLockRenewal(session);
        releaseSessionOwnerLock(id).catch(() => {});
        session.log.warn(
          { sessionId: id, status: session.status },
          "connecting_stale_timeout_releasing_lock"
        );
      }
    }, 180_000);

    sock.ev.on("creds.update", async () => {
      if (session.sock !== sock) return;
      try {
        await saveCreds();
        session.log.debug("creds_saved_success");
      } catch (err) {
        session.log.error(
          {
            err: safeErrorMessage(err),
            table: "whatsapp_baileys_auth",
            phase: "saveCreds",
            hint:
              "Check RLS, service role key, and that columns match whatsapp_baileys_auth (session_id, file_key, value, updated_at).",
          },
          "creds_save_failed_safe"
        );
      }
    });

    bindMessagesUpsert(session, sock);

    sock.ev.on("connection.update", async (update) => {
      if (session.sock !== sock) return;
      clearTimeout(hangGuard);
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        // Always route QR through handleQR so session.qrDataUrl stays fresh when Baileys
        // rotates the code. DB/webhook writes inside handleQR remain throttled (QR_THROTTLE_MS).
        await handleQR(session, qr);
      }

      if (connection === "open") {
        connectingNow.delete(id);
        session.status = "connected";
        session.qrDataUrl = null;
        session.reconnectAttempts = 0;
        session.lastDisconnectCode = null;
        session.lastError = null;
        session.lastQrSavedAt = 0;
        session.updatedAt = nowIso();

        // Eagerly persist device_id so every subsequent webhook includes it.
        await resolvePanelDeviceId(session);

        session.log.info(
          {
            sessionId: session.id,
            panel_device_id: session.panelDeviceId,
            connection: "open",
          },
          "connection_open"
        );

        startSessionOwnerLockRenewal(session);

        const linked = extractLinkedWaAccount(sock);
        session.linkedPhone = linked.phoneNumber;
        session.linkedName = linked.profileName;
        session.linkedWaJid = linked.waJid;
        session.connectionOpenedAt = nowIso();

        session.log.info(
          {
            linked_phone: linked.phoneNumber,
            linked_wa_jid: linked.waJid,
            linked_profile_name: linked.profileName,
          },
          "session_linked_account_metadata"
        );

        const phoneNumber = linked.phoneNumber;
        const profileName = linked.profileName || "WhatsApp Device";

        const baseDeviceRow = {
          status: "connected",
          phone_number: phoneNumber,
          name: profileName,
          qr_code: null,
        };
        if (DEVICES_EXTENDED_FIELDS) {
          Object.assign(baseDeviceRow, {
            whatsapp_jid: linked.waJid,
            last_connected_at: session.connectionOpenedAt,
          });
        }
        await updateSupabaseDevice(id, baseDeviceRow);

        await postWebhook(session, {
          type: "connection",
          event: "connected",
          payload: {
            phone_number: phoneNumber,
            name: profileName,
            whatsapp_jid: linked.waJid,
            wa_jid: linked.waJid,
            connected_at: Date.now(),
            last_connected_at: session.connectionOpenedAt,
          },
        });
      }

      if (connection === "close") {
        if (DEBUG_DISCONNECT && !session._rawDisconnectLogged) {
          session._rawDisconnectLogged = true;
          try {
            const raw = rawDisconnectDebugFields(lastDisconnect);
            session.log.warn(
              {
                sessionId: session.id,
                rawInspect: raw.rawInspect,
                raw_error_constructor_name: raw.raw_error_constructor_name,
                raw_error_keys: raw.raw_error_keys,
                raw_error_message_if_present: raw.raw_error_message_if_present,
                raw_error_stack_if_present: raw.raw_error_stack_if_present,
                disconnect_parse_source: "util_inspect_lastDisconnect",
              },
              "raw_last_disconnect"
            );
          } catch (e) {
            session.log.warn(
              { err: safeErrorMessage(e) },
              "raw_last_disconnect_inspect_failed"
            );
          }
        }

        const norm = normalizeDisconnect(lastDisconnect);
        const statusCode = norm.statusCode;
        const reason = norm.reason;
        session.lastDisconnectCode = statusCode;
        session.updatedAt = nowIso();
        session.sock = null;

        // 515 = stream replaced / server-side reset
        const isStreamError = statusCode === 515;
        // Closed while the user was scanning the QR — likely the normal
        // "restart after pairing" event.  Do NOT count this as a hard error.
        const wasPairing = session.status === "qr_pending";

        session.log.warn(
          {
            sessionId: session.id,
            panel_device_id: session.panelDeviceId,
            connection: "close",
            currentStatus: session.status,
            statusCode,
            outputStatusCode: norm.outputStatusCode,
            disconnectReasonCode: norm.disconnectReasonCode,
            disconnectReasonName: norm.disconnectReasonName,
            disconnect_parse_source: norm.disconnect_parse_source,
            reason,
            isStreamError,
            wasPairing,
          },
          "connection_close_normalized"
        );

        connectingNow.delete(id);

        if (statusCode === DisconnectReason.loggedOut) {
          clearSessionOwnerLockRenewal(session);
          await releaseSessionOwnerLock(session.id);
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
          session.qrDataUrl = null;
          await updateSupabaseDevice(id, { status: "connecting", qr_code: null });
          session.log.info(
            { statusCode, isStreamError, wasPairing },
            "disconnect_during_handshake_will_resume_shortly"
          );
          postWebhook(session, {
            type: "connection",
            event: "connecting",
            payload: { statusCode, reason, transient: true },
          });
        } else {
          // Only notify the panel about a hard error when the close was not
          // the expected QR pairing restart / stream replacement.
          postWebhook(session, {
            type: "connection",
            event: "error",
            payload: { statusCode, reason },
          });
        }

        if (DEBUG_DISCONNECT) {
          session.shouldReconnect = false;
          clearReconnectTimer(session);
          session.status = "error";
          session.lastError = reason.slice(0, 500);
          session.log.warn({ sessionId: session.id }, "reconnect_blocked_debug_mode");
          return;
        }

        // Longer delay for stream errors and pairing interruptions to let the
        // WhatsApp server fully process the credential exchange before we try again.
        let delayMs;
        if (isStreamError) delayMs = 8_000;
        else if (wasPairing) delayMs = 5_000;
        scheduleReconnect(session, delayMs);
      }
    });

    return session;
  } catch (err) {
    session.log.error({ err: safeErrorMessage(err) }, "connectSession_failed");
    throw err;
  } finally {
    if (!socketCreated) {
      connectingNow.delete(id);
      clearSessionOwnerLockRenewal(session);
      await releaseSessionOwnerLock(id);
    }
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
  if (!session || !session.qrDataUrl) {
    const log = session?.log || logger.child({ sessionId: id });
    log.debug(
      {
        reason: !session ? "no_in_memory_session" : "qr_data_url_empty",
        status: session?.status,
      },
      "qr_image_unavailable"
    );
    return res.status(404).send("QR not ready");
  }

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

  const sendReady = isSessionSendReady(session);
  res.json({
    status: session.status,
    connected: session.status === "connected",
    /** True only when socket + WS + Baileys user are ready (stricter than `connected` alone). */
    sessionReady: sendReady.ok,
    sessionReadyReason: sendReady.reason,
    qr: Boolean(session.qrDataUrl),
    updatedAt: session.updatedAt,
    panelDeviceId: session.panelDeviceId || null,
    reconnectAttempts: session.reconnectAttempts,
    phone_number: session.linkedPhone,
    name: session.linkedName,
    whatsapp_jid: session.linkedWaJid,
    connectionOpenedAt: session.connectionOpenedAt,
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
  const sendReady = isSessionSendReady(session);
  if (!sendReady.ok) {
    return res.status(400).json({
      error: "Device not ready to send",
      reason: sendReady.reason,
      status: session?.status,
    });
  }

  try {
    const normalized = normalizeOutboundRecipient(to);
    if (!normalized.jid) {
      return res.status(400).json({ error: "Invalid to / JID" });
    }
    const jid = normalized.jid;

    session.log.info(
      {
        outbound_to_received: to,
        outbound_to_kind: normalized.outbound_to_kind,
        outbound_to_after_internal_normalization: jid,
        final_sendMessage_jid: jid,
      },
      "outbound_send_precise"
    );

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

    session.log.info({ jid, send_ready_reason: sendReady.reason }, "send_ok");
    res.json({ success: true, status: "sent" });
  } catch (err) {
    const kind = classifyOutboundSendError(err);
    session.log.error(
      {
        err: err?.message,
        send_error_kind: kind,
        session_status: session.status,
        has_socket: Boolean(session.sock),
        send_ready_snapshot: isSessionSendReady(session),
      },
      "send_error"
    );
    res.status(500).json({ error: err.message, kind });
  }
});

app.get("/send", requireApiAuth, async (req, res) => {
  const { to, message, sessionId } = req.query;
  const targetId = sanitizeSessionId(sessionId) || DEFAULT_SESSION_ID;
  if (!to || !message || !targetId) return res.json({ status: false, message: "Missing required fields" });
  try {
    const session = sessions.get(targetId);
    const sendReady = isSessionSendReady(session);
    if (!sendReady.ok) {
      return res.json({ status: false, message: "Device not ready to send", reason: sendReady.reason });
    }

    const normalized = normalizeOutboundRecipient(to);
    if (!normalized.jid) {
      return res.json({ status: false, message: "Invalid to / JID" });
    }
    const jid = normalized.jid;

    session.log.info(
      {
        outbound_to_received: to,
        outbound_to_kind: normalized.outbound_to_kind,
        outbound_to_after_internal_normalization: jid,
        final_sendMessage_jid: jid,
      },
      "outbound_send_precise"
    );

    if (!session.sendQueue) session.sendQueue = Promise.resolve();

    session.sendQueue = session.sendQueue
      .then(() => new Promise((r) => setTimeout(r, 1000)))
      .then(() => session.sock.sendMessage(jid, { text: message }));

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
      sessionReady: isSessionSendReady(s).ok,
    })),
  });
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, auth: useSupabaseAuth ? "supabase" : "filesystem" }, "listening");
});

async function autoStartSavedSessions() {
  if (!AUTO_START_SAVED_ENABLED) return;
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
