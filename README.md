# whatsapp-server (Baileys)

Production-oriented WhatsApp session service for the panel BFF.

## Supabase (required for durable sessions on Railway)

1. Run `supabase_whatsapp_baileys_auth.sql` in the Supabase SQL editor.
2. Set on Railway (or `.env`):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (recommended) or `SUPABASE_KEY` — must be allowed to read/write `whatsapp_baileys_auth` and update `devices`.
3. Default auth storage is **Supabase** whenever URL + key are set. To force local files only: `AUTH_MODE=filesystem` (ephemeral on Railway).

## Webhook → panel

- `WHATSAPP_WEBHOOK_URL` — e.g. `https://<panel>/api/webhooks/whatsapp/incoming`
- `WHATSAPP_WEBHOOK_SECRET` — same as panel

Incoming payloads include `device_id` (UUID from `devices`) when resolvable from `session_data`.

## Connect with explicit device UUID (optional)

If `sessionId` does not match `devices.session_data`, pass the panel device id:

`POST /sessions/:sessionId/connect`  
Body: `{ "device_id": "<uuid>", "force": true }`

## Logging

- `LOG_LEVEL` — `debug` | `info` | `warn` | `error` (default `info` in production)
- `BAILEYS_LOG_LEVEL` — Baileys internal logs (default `fatal` to reduce noise); set to `warn` or `debug` when debugging Baileys.

## Other env

| Variable | Purpose |
|----------|---------|
| `PORT` | Listen port |
| `DEFAULT_SESSION_ID` | Auto-started session (default `default`) |
| `AUTO_START_DEFAULT` | `false` to skip auto-start |
| `RECONNECT_BASE_MS` | Initial reconnect delay (default 3000) |
| `RECONNECT_MAX_MS` | Cap for exponential backoff (default 120000) |
| `QR_THROTTLE_MS` | Min interval between QR writes to `devices` |
| `DEVICES_EXTENDED_FIELDS` | Default `true`. Set `false` if `devices` has no `whatsapp_jid` / `last_connected_at` columns yet (see `supabase_devices_whatsapp_server.sql`). |
| `BAILEYS_VERSION_JSON` | Optional pinned Baileys web version JSON array, e.g. `[2,3000,1015901307]` — avoids drift vs `fetchLatestBaileysVersion` and stored keys. |
| `WA_SESSION_REDIS_LOCK` | Default `true` when `REDIS_URL` is set. Uses Redis so only one replica owns a Baileys session (reduces “Stream Errored (conflict)”). Set `false` to disable (single-replica only). |
| `WA_SESSION_REDIS_LOCK_TTL_SEC` | Redis session lock TTL (default 480). |
| `REDIS_URL` | **Required for Enterprise features** (internal Railway URL: `redis://...@redis.railway.internal:6379`). DO NOT use `REDIS_PUBLIC_URL` locally as it will incur egress costs and potential latency issues on Railway. |

## Enterprise Level 2 Features (Redis)

- **BullMQ Persistence:** When `REDIS_URL` is set, all webhooks and incoming messages are handled via durable Redis queues instead of an in-memory fallback.
- **Master-Node Leader Election:** Prevents duplicated work and conflicting TCP connections in multi-region deployments.
- **Session owner lock:** When `REDIS_URL` is set, each Baileys session id acquires a Redis lock so two Railway replicas cannot run the same WhatsApp session (major cause of conflict / Bad MAC). Leader election alone does not gate `POST /connect` from the panel.
- **Failover:** If the leader server goes down, another node takes over seamlessly.

## Panel sync (`GET /sessions/:id/status`)

- `connected` — Baileys reported `connection === "open"` (same as before).
- `sessionReady` — stricter: WebSocket open + `sock.user` present (use this before relying on send).
- `phone_number`, `name`, `whatsapp_jid`, `connectionOpenedAt` — linked account metadata after pairing (also written to `devices` when columns exist).

## Connected webhook payload

`event: "connected"` includes `phone_number`, `name`, `whatsapp_jid`, `wa_jid`, `connected_at`, `last_connected_at` for the panel BFF.

```bash
npm ci
npm start
```
