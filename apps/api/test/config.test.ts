import { describe, expect, it } from "vitest";
import { loadConfig, effectiveDatabaseUrl } from "../src/config.js";

const base: Record<string, string> = {
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  VAPID_PUBLIC_KEY: "test-public-key",
  VAPID_PRIVATE_KEY: "test-private-key",
};

describe("loadConfig", () => {
  it("falls back to a dev secret when DEV_DB is on and none is provided", () => {
    const cfg = loadConfig({});
    expect(cfg.SESSION_SECRET).toHaveLength(38);
    expect(cfg.DEV_DB).toBe(true);
  });

  it("requires SESSION_SECRET when DEV_DB is off", () => {
    expect(() => loadConfig({ DEV_DB: "0" })).toThrow(/SESSION_SECRET/);
  });

  it("falls back to dev VAPID keys when DEV_DB is on and none is provided", () => {
    const cfg = loadConfig({});
    expect(cfg.VAPID_PUBLIC_KEY).not.toBe("");
    expect(cfg.VAPID_PRIVATE_KEY).not.toBe("");
  });

  it("requires VAPID keys when DEV_DB is off", () => {
    expect(() => loadConfig({ SESSION_SECRET: base.SESSION_SECRET, DATABASE_URL: "postgresql://u:p@db:5432/rmd", DEV_DB: "0" })).toThrow(/VAPID/);
  });

  it("rejects a too-short SESSION_SECRET", () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });

  it("accepts the zero-service defaults", () => {
    const cfg = loadConfig({ ...base, DEV_DB: "1" });
    expect(cfg.DEV_DB).toBe(true);
    expect(cfg.QUEUE_DRIVER).toBe("memory");
    expect(cfg.PORT).toBe(3000);
    expect(cfg.OPERATIONAL_CURRENCY).toBe("JMD");
    expect(cfg.USD_TO_JMD_RATE).toBe(155);
    expect(cfg.PIN_LENGTH).toBe(4);
  });

  it("requires DATABASE_URL when DEV_DB is off", () => {
    expect(() => loadConfig({ ...base, DEV_DB: "0" })).toThrow(/DATABASE_URL/);
  });

  it("parses the geo feature flags", () => {
    const cfg = loadConfig({ ...base, JAMNAV_ENABLED: "true", JAMNAV_API_KEY: "k" });
    expect(cfg.JAMNAV_ENABLED).toBe(true);
    expect(cfg.GOOGLE_MAPS_API_KEY).toBe("");
  });
});

describe("effectiveDatabaseUrl", () => {
  const cfg = loadConfig({ ...base, DEV_DB: "1" });
  it("falls back to the local sqlite file", () => {
    expect(effectiveDatabaseUrl(cfg, "/srv/api")).toBe("file:/srv/api/data/dev.db");
  });
  it("keeps an explicit file url", () => {
    expect(effectiveDatabaseUrl({ ...cfg, DATABASE_URL: "file:./other.db" }, "/srv/api")).toBe("file:/srv/api/other.db");
  });
  it("keeps a postgres url when DEV_DB is off", () => {
    const pg = "postgresql://u:***@db:5432/rmd";
    const prod = loadConfig({ ...base, DEV_DB: "0", DATABASE_URL: pg });
    expect(effectiveDatabaseUrl(prod, "/srv/api")).toBe(pg);
  });

  it("prefers the sqlite file over a leftover postgres URL when DEV_DB is on", () => {
    const withPg = { ...cfg, DATABASE_URL: "postgresql://u:***@db:5432/rmd" };
    expect(effectiveDatabaseUrl(withPg, "/srv/api")).toBe("file:/srv/api/data/dev.db");
  });
});
