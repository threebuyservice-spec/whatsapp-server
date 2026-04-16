/**
 * Baileys auth state backed by Supabase (survives Railway redeploys).
 * Mirrors @whiskeysockets/baileys use-multi-file-auth-state key layout.
 */
import { Mutex } from "async-mutex";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";

const TABLE = "whatsapp_baileys_auth";

function safePersistMessage(e) {
  if (e == null) return "unknown";
  if (typeof e === "string") return e.slice(0, 2000);
  if (typeof e?.message === "string" && e.message) return e.message.slice(0, 2000);
  try {
    return String(e).slice(0, 2000);
  } catch {
    return "unserializable_error";
  }
}

function fixFileName(file) {
  return file?.replace(/\//g, "__")?.replace(/:/g, "-");
}

function getKeyLock(map, key) {
  let m = map.get(key);
  if (!m) {
    m = new Mutex();
    map.set(key, m);
  }
  return m;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} sessionId sanitized session id (matches devices.session_data)
 * @param {{ debug?: boolean, log?: (msg: string, extra?: object) => void }} opts
 */
export async function useSupabaseAuthState(supabase, sessionId, opts = {}) {
  const log = opts.log || (() => {});
  const keyLocks = new Map();

  const writeData = async (data, file) => {
    const fileKey = fixFileName(file);
    const mutex = getKeyLock(keyLocks, fileKey);
    return mutex.runExclusive(async () => {
      let serialized;
      try {
        serialized = JSON.stringify(data, BufferJSON.replacer);
      } catch (e) {
        log("session_persist_failed_safe", {
          sessionId,
          fileKey,
          phase: "json_stringify",
          message: safePersistMessage(e),
        });
        throw e;
      }
      let value;
      try {
        value = JSON.parse(serialized, BufferJSON.reviver);
      } catch {
        value = JSON.parse(serialized);
      }
      const { error } = await supabase.from(TABLE).upsert(
        {
          session_id: sessionId,
          file_key: fileKey,
          value,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "session_id,file_key" }
      );
      if (error) {
        log("session_persist_failed_safe", {
          sessionId,
          fileKey,
          phase: "supabase_upsert",
          table: TABLE,
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
        });
        log("auth_db_write_error", {
          sessionId,
          fileKey,
          message: error.message,
          code: error.code,
        });
        throw error;
      }
    });
  };

  const readData = async (file) => {
    const fileKey = fixFileName(file);
    const mutex = getKeyLock(keyLocks, fileKey);
    return mutex.runExclusive(async () => {
      const { data, error } = await supabase
        .from(TABLE)
        .select("value")
        .eq("session_id", sessionId)
        .eq("file_key", fileKey)
        .maybeSingle();
      if (error) {
        log("auth_db_read_error", { sessionId, fileKey, message: error.message });
        return null;
      }
      if (!data?.value) return null;
      try {
        // Must match Baileys use-multi-file-auth-state: round-trip through BufferJSON.replacer
        // before reviver. Plain JSON.stringify(value) breaks Buffer encoding (uses numeric arrays
        // instead of base64) and can leave crypto/noise keys as plain objects → downstream
        // "The \"data\" argument must be of type string or an instance of Buffer..." errors.
        let parsed;
        if (typeof data.value === "string") {
          parsed = JSON.parse(data.value);
        } else {
          parsed = data.value;
        }
        const normalized = JSON.stringify(parsed, BufferJSON.replacer);
        return JSON.parse(normalized, BufferJSON.reviver);
      } catch (e) {
        log("auth_state_read_failed_safe", {
          sessionId,
          fileKey,
          message: safePersistMessage(e),
        });
        return null;
      }
    });
  };

  const removeData = async (file) => {
    const fileKey = fixFileName(file);
    const mutex = getKeyLock(keyLocks, fileKey);
    return mutex.runExclusive(async () => {
      const { error } = await supabase
        .from(TABLE)
        .delete()
        .eq("session_id", sessionId)
        .eq("file_key", fileKey);
      if (error) log("auth_db_delete_error", { sessionId, fileKey, message: error.message });
    });
  };

  const creds = (await readData("creds.json")) || initAuthCreds();
  if (opts.debug) log("auth_loaded", { sessionId, hasCreds: !!creds?.registered });

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => writeData(creds, "creds.json"),
  };
}
