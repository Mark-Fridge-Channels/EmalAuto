/**
 * Named BullMQ queues. Workers/consumers live in src/workers/*.
 */

import { Queue } from "bullmq";
import { getRedis } from "./connection.js";

export interface SendJobData {
  /** Notion page id used as idempotency key. */
  notionPageId: string;
}

export interface InboxPollJobData {
  mailboxId: number;
  email: string;
  folder: string;
}

export interface MatchJobData {
  inboxRowId: number;
}

export interface WebhookIngestJobData {
  mailboxEmail: string;
  messageId: string;
  folder: string;
}

export const QUEUE_NAMES = {
  send: "send",
  inboxPoll: "inbox-poll",
  match: "match",
  webhookIngest: "webhook-ingest",
} as const;

export const sendQueue = new Queue<SendJobData>(QUEUE_NAMES.send, {
  connection: getRedis(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { age: 60 * 60, count: 1000 },
    removeOnFail: { age: 24 * 60 * 60, count: 5000 },
  },
});

export const inboxPollQueue = new Queue<InboxPollJobData>(QUEUE_NAMES.inboxPoll, {
  connection: getRedis(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 30 * 60, count: 500 },
    removeOnFail: { age: 24 * 60 * 60, count: 1000 },
  },
});

export const matchQueue = new Queue<MatchJobData>(QUEUE_NAMES.match, {
  connection: getRedis(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { age: 60 * 60, count: 2000 },
    removeOnFail: { age: 24 * 60 * 60, count: 5000 },
  },
});

export const webhookIngestQueue = new Queue<WebhookIngestJobData>(QUEUE_NAMES.webhookIngest, {
  connection: getRedis(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 3_000 },
    removeOnComplete: { age: 60 * 60, count: 5000 },
    removeOnFail: { age: 24 * 60 * 60, count: 5000 },
  },
});
