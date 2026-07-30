const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_CONFIG } = require("../../shared/defaults");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneConfigValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeConfig(config) {
  const defaultConfig = cloneConfigValue(DEFAULT_CONFIG);
  const nextConfig = isPlainObject(config) ? cloneConfigValue(config) : {};

  return {
    ...defaultConfig,
    ...nextConfig,
    display: {
      ...defaultConfig.display,
      ...(isPlainObject(nextConfig.display) ? nextConfig.display : {})
    },
    system: {
      ...defaultConfig.system,
      ...(isPlainObject(nextConfig.system) ? nextConfig.system : {})
    },
    interactions: {
      ...defaultConfig.interactions,
      ...(isPlainObject(nextConfig.interactions) ? nextConfig.interactions : {}),
      bubble: {
        ...defaultConfig.interactions.bubble,
        ...(isPlainObject(nextConfig.interactions && nextConfig.interactions.bubble) ? nextConfig.interactions.bubble : {})
      }
    }
  };
}

function createConfigStore(userDataDir) {
  const configPath = path.join(userDataDir, "config.json");

  function exists() {
    return fs.existsSync(configPath);
  }

  function ensureUserDataDir() {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  function load() {
    ensureUserDataDir();

    if (!fs.existsSync(configPath)) {
      return mergeConfig();
    }

    const contents = fs.readFileSync(configPath, "utf8");

    try {
      return mergeConfig(JSON.parse(contents));
    } catch (error) {
      if (error instanceof SyntaxError) {
        return mergeConfig();
      }

      throw error;
    }
  }

  function save(nextConfig) {
    ensureUserDataDir();
    const config = mergeConfig(nextConfig);
    const serialized = JSON.stringify(config, null, 2);
    fs.writeFileSync(configPath, serialized, "utf8");
    return JSON.parse(serialized);
  }

  return {
    configPath,
    exists,
    load,
    save
  };
}

module.exports = { createConfigStore };
