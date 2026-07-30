import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import configStoreModule from "../../src/main/services/config-store";
import defaultsModule from "../../src/shared/defaults";

const { createConfigStore } = configStoreModule;
const { DEFAULT_CONFIG } = defaultsModule;

describe("createConfigStore", () => {
  let tempDir;
  let userDataDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-pet-config-"));
    userDataDir = path.join(tempDir, "user-data");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads defaults when config file does not exist", () => {
    const store = createConfigStore(userDataDir);

    expect(store.exists()).toBe(false);
    expect(store.load()).toEqual(DEFAULT_CONFIG);
  });

  it("persists updates", () => {
    const store = createConfigStore(userDataDir);

    const saved = store.save({
      currentPackageId: "sleepy-cat",
      display: { x: 240, scale: 1.5 },
      system: { language: "en-US" }
    });

    expect(saved).toEqual({
      ...DEFAULT_CONFIG,
      currentPackageId: "sleepy-cat",
      display: { ...DEFAULT_CONFIG.display, x: 240, scale: 1.5 },
      system: { ...DEFAULT_CONFIG.system, language: "en-US" }
    });
    expect(store.load()).toEqual(saved);
    expect(store.exists()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(userDataDir, "config.json"), "utf8"))).toEqual(saved);
  });

  it("merges interaction bubble settings without dropping default messages", () => {
    const store = createConfigStore(userDataDir);

    const saved = store.save({
      interactions: {
        bubble: { maxWidth: 280 }
      }
    });

    expect(saved.interactions).toEqual({
      ...DEFAULT_CONFIG.interactions,
      bubble: {
        ...DEFAULT_CONFIG.interactions.bubble,
        maxWidth: 280
      }
    });
  });

  it("recovers from invalid JSON", () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, "config.json"), "{ invalid json", "utf8");

    const store = createConfigStore(userDataDir);

    expect(store.load()).toEqual(DEFAULT_CONFIG);
  });

  it("propagates non-SyntaxError read failures", () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, "config.json"), "{}", "utf8");
    const originalReadFileSync = fs.readFileSync;
    const readError = new Error("read failed");
    fs.readFileSync = (...args) => {
      if (args[0] === path.join(userDataDir, "config.json")) {
        throw readError;
      }

      return originalReadFileSync(...args);
    };

    try {
      const store = createConfigStore(userDataDir);

      expect(() => store.load()).toThrow(readError);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });

  it("preserves unknown top-level keys", () => {
    const store = createConfigStore(userDataDir);

    const saved = store.save({
      display: { y: 320 },
      metadata: { author: "tao" }
    });

    expect(saved.metadata).toEqual({ author: "tao" });
    expect(store.load().metadata).toEqual({ author: "tao" });
  });

  it("does not mutate DEFAULT_CONFIG when saving nested display/system values", () => {
    const originalDefaults = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const store = createConfigStore(userDataDir);

    store.save({
      display: { x: 999, alwaysOnTop: false },
      system: { language: "en-US", launchAtLogin: true }
    });

    expect(DEFAULT_CONFIG).toEqual(originalDefaults);
  });

  it("isolates saved config from caller input mutations", () => {
    const store = createConfigStore(userDataDir);
    const nextConfig = {
      display: { x: 42 },
      triggerRules: [{ id: "wave-rule", payload: { animation: "wave" } }]
    };

    const saved = store.save(nextConfig);
    nextConfig.display.x = 900;
    nextConfig.triggerRules[0].payload.animation = "changed";

    expect(saved.display.x).toBe(42);
    expect(saved.triggerRules[0].payload.animation).toBe("wave");
    expect(store.load().triggerRules[0].payload.animation).toBe("wave");
  });

  it("isolates loaded config mutations from defaults and later loads", () => {
    const originalDefaults = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const store = createConfigStore(userDataDir);

    const loaded = store.load();
    loaded.display.x = 777;
    loaded.system.language = "en-US";

    expect(DEFAULT_CONFIG).toEqual(originalDefaults);
    expect(store.load()).toEqual(originalDefaults);
  });
});
