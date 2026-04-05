import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { logger } from "./logger.mjs";
import fs from "fs/promises";

// Track in-memory metrics for /internal/metrics/webhooks
export const metrics = {
  webhooks: {
    sent: 0,
    retries: 0,
    failed: 0,
    queued: 0,
  },
};

const REDIS_URL = process.env.REDIS_URL || "";
export let redisConnection = null;

if (REDIS_URL) {
  try {
    redisConnection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null, // Required by BullMQ
      retryStrategy(times) {
        return Math.min(times * 50, 2000);
      },
    });
    // Check connection eagerly
    redisConnection.on("error", (err) => {
      logger.error({ err: err.message }, "redis_connection_error");
    });
    logger.info("redis_connected_for_queues");
  } catch (e) {
    logger.error({ err: e.message }, "redis_connection_failed");
  }
}

export const useRedisQueue = Boolean(redisConnection);

/**
 * Creates a Queue + Worker. Uses BullMQ if Redis available, else graceful In-Memory fallback.
 */
export function createQueue(name, processFn) {
  if (useRedisQueue) {
    logger.info({ name }, "creating_bullmq_queue");
    const queue = new Queue(name, { connection: redisConnection });
    const worker = new Worker(
      name,
      async (job) => {
        return processFn(job.data, job);
      },
      { connection: redisConnection, concurrency: 5 }
    );
    
    worker.on("failed", async (job, err) => {
      logger.error({ queue: name, jobId: job.id, err: err.message }, "bullmq_job_failed");
      if (name === "incoming-messages" || name === "webhooks") {
        metrics.webhooks.retries++;
        if (job.attemptsMade >= (job.opts.attempts || 5)) {
          metrics.webhooks.failed++;
          try {
            await fs.appendFile("failed_webhooks.json", JSON.stringify({ body: job.data.body || job.data }) + "\n");
          } catch (e) {
            // ignore
          }
        }
      }
    });
    
    worker.on("completed", (job) => {
      if (name === "incoming-messages" || name === "webhooks") {
        metrics.webhooks.sent++;
      }
    });

    return {
      add: async (jobName, data, opts) => {
        if (name === "incoming-messages" || name === "webhooks") metrics.webhooks.queued++;
        return queue.add(jobName, data, opts);
      },
      getMetrics: async () => {
        const counts = await queue.getJobCounts();
        return {
          ...metrics.webhooks,
          queued: counts.waiting + counts.active + counts.delayed,
        };
      },
      worker
    };
  } else {
    logger.warn({ name }, "creating_in_memory_queue_fallback");
    const queueArray = [];
    let processing = false;

    const processNext = async () => {
      if (processing || queueArray.length === 0) return;
      processing = true;
      while (queueArray.length > 0) {
        const job = queueArray[0];
        try {
          await processFn(job.data, job);
          queueArray.shift();
          if (name === "incoming-messages" || name === "webhooks") {
            metrics.webhooks.sent++;
            metrics.webhooks.queued = Math.max(0, metrics.webhooks.queued - 1);
          }
        } catch (err) {
          job.attempts++;
          const maxRetries = job.opts?.attempts || 5;
          logger.error({ queue: name, err: err.message, attempts: job.attempts }, "in_memory_job_failed");
          
          if (name === "incoming-messages" || name === "webhooks") {
            metrics.webhooks.retries++;
          }

          if (job.attempts >= maxRetries) {
            queueArray.shift(); // Drop after max retries
            if (name === "incoming-messages" || name === "webhooks") {
              metrics.webhooks.failed++;
              metrics.webhooks.queued = Math.max(0, metrics.webhooks.queued - 1);
              try {
                await fs.appendFile("failed_webhooks.json", JSON.stringify({ body: job.data.body || job.data }) + "\n");
              } catch (e) {}
            }
          } else {
            // Backoff logic
            const baseDelay = job.opts?.backoff?.delay || 1000;
            const backoffMs = baseDelay * Math.pow(2, job.attempts - 1);
            await new Promise((r) => setTimeout(r, backoffMs));
          }
        }
      }
      processing = false;
    };

    return {
      add: async (jobName, data, opts) => {
        queueArray.push({ name: jobName, data, attempts: 0, opts });
        if (name === "incoming-messages" || name === "webhooks") metrics.webhooks.queued++;
        processNext().catch((e) => logger.error({ err: e.message }, "in_memory_queue_crash"));
      },
      getMetrics: async () => {
        return {
          ...metrics.webhooks,
          queued: queueArray.length,
        };
      },
      worker: {
        pause: () => { processing = true; }, // mock pause
        resume: () => { processing = false; processNext(); } // mock resume
      }
    };
  }
}

