-- Run in Supabase SQL editor (once). Stores Baileys multi-file auth keys so sessions survive Railway redeploys.
-- Use service_role key on the WhatsApp server (not anon) for read/write.

CREATE TABLE IF NOT EXISTS public.whatsapp_baileys_auth (
  session_id text NOT NULL,
  file_key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, file_key)
);

CREATE INDEX IF NOT EXISTS whatsapp_baileys_auth_session_idx
  ON public.whatsapp_baileys_auth (session_id);

COMMENT ON TABLE public.whatsapp_baileys_auth IS 'Baileys auth state (creds + signal keys) keyed by whatsapp-server session id (matches devices.session_data).';
