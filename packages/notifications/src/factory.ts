import type { NotificationProvider } from "./core.js";
import { MemoryProvider } from "./core.js";
import { TwilioProvider, type TwilioConfig } from "./twilio.js";

export interface NotificationConfig {
  provider: "memory" | "twilio";
  twilio?: TwilioConfig;
  log?: (line: string) => void;
}

export function createNotificationProvider(cfg: NotificationConfig): NotificationProvider {
  if (cfg.provider === "twilio") {
    return new TwilioProvider(cfg.twilio ?? {});
  }
  return new MemoryProvider(cfg.log);
}
