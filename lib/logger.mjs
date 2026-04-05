import pino from "pino";

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

// High-performance asynchronous destination suitable for log shippers (ELK / Datadog)
const dest = pino.destination({ sync: false, minLength: 4096 });

export const logger = pino({
  level,
  base: { source: "whatsapp-server", env: process.env.NODE_ENV || "development" },
  timestamp: () => `,"timestamp":${Date.now()}`, // Datadog/ELK standard unix ms
  formatters: {
    level(label) {
      return { level: label }; // Datadog exact 'level' standard instead of 'msg'
    },
    log(obj) {
      if (obj.err && typeof obj.err === "object") {
        obj.error = obj.err; // Maps error blocks cleanly to DD tracing
        delete obj.err;
      }
      return obj;
    }
  },
}, dest);

// To ensure logs are flushed in async mode
setInterval(() => {
  logger.flush();
}, 10000).unref();

/** @param {string} sessionId */
export function childLogger(sessionId) {
  return logger.child({ sessionId });
}

/** Separate logger for Baileys internals (very noisy at info/debug). */
export function createBaileysLogger() {
  return pino({
    level: process.env.BAILEYS_LOG_LEVEL || "fatal",
    base: { source: "baileys" },
    timestamp: () => `,"timestamp":${Date.now()}`,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  }, dest);
}
