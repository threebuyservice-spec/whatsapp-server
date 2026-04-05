import { logger } from "./logger.mjs";
import { randomUUID } from "crypto";

export const serverInstanceId = randomUUID();
let isLeader = false;

export async function initLeaderElection(redisConnection, onElected, onDemoted) {
  if (!redisConnection) {
    logger.warn("No Redis connection, defaulting to standalone leader mode");
    isLeader = true;
    if (onElected) onElected();
    return true;
  }
  
  const LOCK_KEY = "global:whatsapp_server_leader";
  const TTL_SEC = 15;

  const heartbeat = async () => {
    try {
      const current = await redisConnection.get(LOCK_KEY);
      if (!current || current === serverInstanceId) {
        // Acquire or renew lock
        await redisConnection.setex(LOCK_KEY, TTL_SEC, serverInstanceId);
        if (!isLeader) {
          isLeader = true;
          logger.info({ serverInstanceId }, "became_webhook_leader");
          if (onElected) onElected();
        }
      } else {
        if (isLeader) {
          isLeader = false;
          logger.warn({ serverInstanceId, activeLeader: current }, "lost_leadership");
          if (onDemoted) onDemoted();
        }
      }
    } catch (e) {
      logger.error({ err: e.message }, "leader_election_error");
    }
  };

  await heartbeat();
  setInterval(heartbeat, 5000); // 5s heartbeat

  return isLeader;
}

export function currentIsLeader() {
  return isLeader;
}
