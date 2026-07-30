function normalizeSystemLanguage(locale) {
  if (typeof locale !== "string") {
    return "en";
  }

  return /^zh(?:[-_]|$)/i.test(locale.trim()) ? "zh" : "en";
}

function detectSystemLanguage(electronApp) {
  if (electronApp && typeof electronApp.getPreferredSystemLanguages === "function") {
    try {
      const preferredLanguages = electronApp.getPreferredSystemLanguages();
      const preferredLocale = Array.isArray(preferredLanguages)
        ? preferredLanguages.find((locale) => typeof locale === "string" && locale.trim())
        : null;

      if (preferredLocale) {
        return {
          language: normalizeSystemLanguage(preferredLocale),
          locale: preferredLocale,
          source: "preferredSystemLanguages"
        };
      }
    } catch {
      // Fall through to app.getLocale(), which is available on older Electron versions.
    }
  }

  if (electronApp && typeof electronApp.getLocale === "function") {
    try {
      const locale = electronApp.getLocale();
      if (typeof locale === "string" && locale.trim()) {
        return {
          language: normalizeSystemLanguage(locale),
          locale,
          source: "appLocale"
        };
      }
    } catch {
      // Use the supported English fallback when Electron cannot report a locale.
    }
  }

  return {
    language: "en",
    locale: null,
    source: "fallback"
  };
}

function loadConfigWithFirstRunLanguage(configStore, electronApp) {
  const isFirstRun = !configStore.exists();
  const detection = isFirstRun ? detectSystemLanguage(electronApp) : null;
  let config = configStore.load();

  if (detection) {
    config = configStore.save({
      ...config,
      system: {
        ...config.system,
        language: detection.language
      }
    });
  }

  return { config, detection };
}

module.exports = {
  detectSystemLanguage,
  loadConfigWithFirstRunLanguage,
  normalizeSystemLanguage
};
