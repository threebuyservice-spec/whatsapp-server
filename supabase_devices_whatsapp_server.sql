-- whatsapp-server expects a `devices` table compatible with the panel (often Supabase).
-- Backend writes: session_data, status, qr_code, phone_number, name, updated_at
--
-- Run in Supabase SQL editor if you need to align columns or fix triggers.
-- Idempotent: safe to re-run with IF NOT EXISTS / OR REPLACE where noted.

-- Expected columns (panel may already define these):
--   id uuid PRIMARY KEY
--   session_data text (Baileys session slug; matches whatsapp-server session id)
--   status text
--   qr_code text (nullable; data URL for QR image)
--   phone_number text (nullable)
--   name text (nullable)
--   updated_at timestamptz
--   whatsapp_jid text (nullable; full WA user id, e.g. 123...@s.whatsapp.net)
--   last_connected_at timestamptz (nullable; last successful Baileys open)

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS whatsapp_jid text;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS last_connected_at timestamptz;

-- If your table has `updated_date` instead of `updated_at`, either rename:
--   ALTER TABLE public.devices RENAME COLUMN updated_date TO updated_at;
-- Or change app env (not recommended): keep one canonical name project-wide.

-- Fix a common trigger bug: referencing NEW.updated_date when the column is updated_at.
-- Example replacement (adjust trigger name to match your DB):
/*
CREATE OR REPLACE FUNCTION public.set_devices_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := COALESCE(NEW.updated_at, now());
  RETURN NEW;
END;
$$;
*/
