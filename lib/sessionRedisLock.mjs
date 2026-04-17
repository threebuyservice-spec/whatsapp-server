/**
 * Optional Redis lock so only one Railway replica owns a Baileys session at a time.
 * Fail-open if Redis is unavailable (single-instance deployments).
 */
import { redisConnection } from "./queues.mjs";
import { serverInstanceId } from "./leader.mjs";
import { logger } from "./logger.mjs";

const PREFIX = "wa:baileys_session:";
const TTL_SEC = Number(process.env.WA_SESSION_REDIS_LOCK_TTL_SEC || 480);

export async function tryAcquireSessionOwnerLock(sessionId) {
  if (!redisConnection) return { acquired: true, failOpen: true };
  const key = PREFIX + sessionId;
  try {
    const existing = await redisConnection.get(key);
    if (existing === serverInstanceId) {
      await redisConnection.expire(key, TTL_SEC);
      return { acquired: true, failOpen: false, reentrant: true };
    }
    const ok = await redisConnection.set(key, serverInstanceId, "EX", TTL_SEC, "NX");
    if (ok === "OK") return { acquired: true, failOpen: false, reentrant: false };
    const owner = await redisConnection.get(key);
    return { acquired: false, owner: owner || "unknown" };
  } catch (e) {
    logger.warn({ err: e.message, sessionId }, "session_owner_lock_redis_error_fail_open");
    return { acquired: true, failOpen: true };
  }
}

export async function releaseSessionOwnerLock(sessionId) {
  if (!redisConnection) return;
  const key = PREFIX + sessionId;
  try {
    const cur = await redisConnection.get(key);
    if (cur === serverInstanceId) await redisConnection.del(key);
  } catch (e) {
    logger.warn({ err: e.message, sessionId }, "session_owner_lock_release_failed");
  }
}

export async function renewSessionOwnerLock(sessionId) {
  if (!redisConnection) return;
  const key = PREFIX + sessionId;
  try {
    const cur = await redisConnection.get(key);
    if (cur === serverInstanceId) await redisConnection.expire(key, TTL_SEC);
  } catch (e) {
    logger.warn({ err: e.message, sessionId }, "session_owner_lock_renew_failed");
  }
}
