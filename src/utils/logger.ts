/**
 * Pino logger singleton. Pretty-prints in dev when logging.pretty=true.
 * Module-scoped so workers/server share the same instance.
 */

import pino from "pino";
import { loadConfig } from "../config/index.js";

const cfg = loadConfig();

export const logger = pino({
  level: cfg.logging.level,
  ...(cfg.logging.pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            singleLine: false,
            translateTime: "yyyy-mm-dd HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;
