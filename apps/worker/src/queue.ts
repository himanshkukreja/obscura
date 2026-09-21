import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_NAME, type JobPayload } from '@obscura/shared';

export { QUEUE_NAME };
export type { JobPayload, Job };

export function createConnection(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createQueue(url: string): Queue<JobPayload> {
  return new Queue<JobPayload>(QUEUE_NAME, { connection: createConnection(url) });
}

export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86_400 },
};

export function createWorker(
  url: string, concurrency: number, handler: (job: Job<JobPayload>) => Promise<void>,
): Worker<JobPayload> {
  return new Worker<JobPayload>(QUEUE_NAME, handler, {
    connection: createConnection(url),
    concurrency,
    lockDuration: 120_000,
    stalledInterval: 60_000,
  });
}
