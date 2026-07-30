import { describe, expect, it, vi } from "vitest";
import systemLanguageModule from "../../src/main/services/system-language";

const {
  detectSystemLanguage,
  loadConfigWithFirstRunLanguage,
  normalizeSystemLanguage
} = systemLanguageModule;

describe("system language detection", () => {
  it.each(["zh", "zh-CN", "zh-Hant", "ZH_tw"])("maps %s to Chinese", (locale) => {
    expect(normalizeSystemLanguage(locale)).toBe("zh");
  });

  it.each(["en", "en-US", "ja-JP", "fr-FR", ""])("maps %s to English", (locale) => {
    expect(normalizeSystemLanguage(locale)).toBe("en");
  });

  it("uses the first system-preferred language", () => {
    const electronApp = {
      getPreferredSystemLanguages: vi.fn(() => ["zh-CN", "en-US"]),
      getLocale: vi.fn(() => "en-US")
    };

    expect(detectSystemLanguage(electronApp)).toEqual({
      language: "zh",
      locale: "zh-CN",
      source: "preferredSystemLanguages"
    });
    expect(electronApp.getLocale).not.toHaveBeenCalled();
  });

  it("falls back to the application locale when preferred languages are unavailable", () => {
    const electronApp = {
      getPreferredSystemLanguages: vi.fn(() => []),
      getLocale: vi.fn(() => "zh-Hant")
    };

    expect(detectSystemLanguage(electronApp)).toEqual({
      language: "zh",
      locale: "zh-Hant",
      source: "appLocale"
    });
  });

  it("falls back to English when Electron cannot report a locale", () => {
    const electronApp = {
      getPreferredSystemLanguages: vi.fn(() => {
        throw new Error("unavailable");
      }),
      getLocale: vi.fn(() => null)
    };

    expect(detectSystemLanguage(electronApp)).toEqual({
      language: "en",
      locale: null,
      source: "fallback"
    });
  });

  it("persists the detected language into a new config", () => {
    const initialConfig = {
      system: { language: "en", launchAtLogin: false },
      display: { scale: 1 }
    };
    const savedConfig = {
      ...initialConfig,
      system: { ...initialConfig.system, language: "zh" }
    };
    const configStore = {
      exists: vi.fn(() => false),
      load: vi.fn(() => initialConfig),
      save: vi.fn(() => savedConfig)
    };

    const result = loadConfigWithFirstRunLanguage(configStore, {
      getPreferredSystemLanguages: () => ["zh-CN"]
    });

    expect(configStore.save).toHaveBeenCalledWith(savedConfig);
    expect(result).toEqual({
      config: savedConfig,
      detection: {
        language: "zh",
        locale: "zh-CN",
        source: "preferredSystemLanguages"
      }
    });
  });

  it("does not replace the language in an existing config", () => {
    const existingConfig = { system: { language: "en" } };
    const configStore = {
      exists: vi.fn(() => true),
      load: vi.fn(() => existingConfig),
      save: vi.fn()
    };
    const electronApp = {
      getPreferredSystemLanguages: vi.fn(() => ["zh-CN"])
    };

    expect(loadConfigWithFirstRunLanguage(configStore, electronApp)).toEqual({
      config: existingConfig,
      detection: null
    });
    expect(configStore.save).not.toHaveBeenCalled();
    expect(electronApp.getPreferredSystemLanguages).not.toHaveBeenCalled();
  });
});
