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

## Run

```bash
npm ci
npm start
```
