/**
 * Baileys auth state backed by Supabase (survives Railway redeploys).
 * Mirrors @whiskeysockets/baileys use-multi-file-auth-state key layout.
 */
import { Mutex } from "async-mutex";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";

const TABLE = "whatsapp_baileys_auth";

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
      const serialized = JSON.stringify(data, BufferJSON.replacer);
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
        log("auth_db_write_error", { sessionId, fileKey, message: error.message });
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
        const raw = typeof data.value === "string" ? data.value : JSON.stringify(data.value);
        return JSON.parse(raw, BufferJSON.reviver);
      } catch {
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
