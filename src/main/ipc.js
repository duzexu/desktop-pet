const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, clipboard, dialog, ipcMain, screen, shell } = require("electron");
const { createConfigStore } = require("./services/config-store");
const {
  clearLogs,
  configureLogger,
  createLogger,
  getLoggerSettings,
  listLogFiles,
  readLogFile
} = require("./services/logger");
const {
  copyAssetToPackageWithProgress,
  deleteAssetFromPackage,
  replaceAssetInPackageWithProgress,
  bakeGreenScreenInPackage,
  getAssetDurationMs
} = require("./services/asset-store");
const { exportPetpack, importPetpack } = require("./services/petpack");
const { SAMPLE_PETPACK_URL, installSamplePetpack } = require("./services/sample-petpack");
const { checkForUpdates, getOfficialLink } = require("./services/app-updates");
const { getLaunchAtLogin, setLaunchAtLogin } = require("./startup");
const { validateManifest, validateCondition, validateAction } = require("../shared/manifest-validator");
const { isSafeRelativePath } = require("../shared/path-safety");
const { SUPPORTED_ASSET_EXTENSIONS } = require("../shared/schema");
const { DEFAULT_CONFIG } = require("../shared/defaults");

const CHANNELS = [
  "asset:list",
  "asset:pick",
  "asset:import",
  "asset:replace",
  "asset:delete",
  "asset:bake-green-screen",
  "config:load",
  "config:save",
  "log:write",
  "menu:open-context-menu",
  "panel:show",
  "package:create",
  "package:delete",
  "package:list",
  "package:switch",
  "pet:apply-display",
  "pet:load-runtime",
  "pet:get-displays",
  "pet:reset-position",
  "pet:get-runtime-state",
  "petpack:export",
  "petpack:import",
  "petpack:install-sample",
  "rules:export",
  "rules:import",
  "pet:set-always-on-top",
  "pet:set-mouse-passthrough",
  "pet:set-interactions-paused",
  "pet:set-bounds",
  "pet:set-position",
  "system:get-launch-at-login",
  "system:set-launch-at-login",
  "system:about:get-info",
  "system:about:open-link",
  "system:about:check-updates",
  "system:logs:get-settings",
  "system:logs:list",
  "system:logs:read",
  "system:logs:clear",
  "system:logs:open-directory",
  "app:quit"
];

const logger = createLogger("ipc");
const PET_BASE_WINDOW_SIZE = 320;
const RULES_FILE_TYPE = "desktop-pet.triggerRules";
const RULES_FILE_SCHEMA_VERSION = 1;

function usableWindow(window) {
  return window && !window.isDestroyed();
}

function getPetWindow(getWindows) {
  const { pet } = getWindows();
  return usableWindow(pet) ? pet : null;
}

function getPanelWindow(getWindows) {
  const { panel } = getWindows();
  return usableWindow(panel) ? panel : null;
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) {
    throw new TypeError("Invalid pet bounds");
  }

  const nextBounds = {};
  for (const key of ["x", "y", "width", "height"]) {
    const value = bounds[key];
    if (!Number.isFinite(value)) {
      throw new TypeError("Invalid pet bounds");
    }
    nextBounds[key] = Math.round(value);
  }

  if (nextBounds.width <= 0 || nextBounds.height <= 0) {
    throw new TypeError("Invalid pet bounds");
  }

  return nextBounds;
}

function normalizePosition(position) {
  if (!position || typeof position !== "object" || Array.isArray(position)) {
    throw new TypeError("Invalid pet position");
  }

  const x = Number(position.x);
  const y = Number(position.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError("Invalid pet position");
  }

  return {
    x: Math.round(x),
    y: Math.round(y)
  };
}

function createPetPositionScheduler({
  getWindows,
  scheduleTask = setImmediate,
  now = () => (globalThis.performance && typeof globalThis.performance.now === "function"
    ? globalThis.performance.now()
    : Date.now()),
  schedulerLogger = logger,
  slowPositionMs = 16,
  slowLogIntervalMs = 500
} = {}) {
  let latestPosition = null;
  let flushScheduled = false;
  let coalescedUpdates = 0;
  let lastSlowLogAt = Number.NEGATIVE_INFINITY;

  function scheduleFlush() {
    if (flushScheduled || !latestPosition) return;
    flushScheduled = true;
    scheduleTask(flush);
  }

  function flush() {
    flushScheduled = false;
    if (!latestPosition) return;

    const position = latestPosition;
    const mergedUpdateCount = coalescedUpdates;
    latestPosition = null;
    coalescedUpdates = 0;

    const petWindow = getPetWindow(getWindows);
    if (!petWindow || typeof petWindow.setPosition !== "function") return;

    const startedAt = now();
    try {
      petWindow.setPosition(position.x, position.y);
    } catch (error) {
      schedulerLogger.error("Failed to apply pet drag position", {
        position,
        error: error.message || error
      });
      scheduleFlush();
      return;
    }

    const finishedAt = now();
    const durationMs = Math.round((finishedAt - startedAt) * 100) / 100;
    if (durationMs >= slowPositionMs && finishedAt - lastSlowLogAt >= slowLogIntervalMs) {
      lastSlowLogAt = finishedAt;
      schedulerLogger.warn("Pet drag position applied slowly", {
        durationMs,
        position,
        coalescedUpdates: mergedUpdateCount
      });
    }
    scheduleFlush();
  }

  return {
    request(position) {
      let nextPosition;
      try {
        nextPosition = normalizePosition(position);
      } catch (error) {
        schedulerLogger.warn("Ignoring invalid pet drag position", {
          position,
          error: error.message || error
        });
        return false;
      }

      if (latestPosition) coalescedUpdates += 1;
      latestPosition = nextPosition;
      scheduleFlush();
      return true;
    }
  };
}

function getDisplayScale(display = {}) {
  const scale = Number(display.scale);
  if (Number.isFinite(scale) && scale > 0) return scale;
  return DEFAULT_CONFIG.display.scale;
}

function resizePetWindowForScale(petWindow, display = {}) {
  if (!petWindow || typeof petWindow.getBounds !== "function" || typeof petWindow.setBounds !== "function") return;
  if (!Object.prototype.hasOwnProperty.call(display, "scale")) return;

  const currentBounds = petWindow.getBounds();
  const size = Math.max(1, Math.round(PET_BASE_WINDOW_SIZE * getDisplayScale(display)));
  if (currentBounds.width === size && currentBounds.height === size) return;

  const centerX = currentBounds.x + currentBounds.width / 2;
  const centerY = currentBounds.y + currentBounds.height / 2;
  const nextBounds = {
    x: Math.round(centerX - size / 2),
    y: Math.round(centerY - size / 2),
    width: size,
    height: size
  };
  logger.debug("Resizing pet window for display scale", {
    scale: display.scale,
    previousBounds: currentBounds,
    nextBounds
  });
  petWindow.setBounds(nextBounds);
}

function getDisplayLayouts() {
  if (!screen || typeof screen.getAllDisplays !== "function") return [];
  return screen.getAllDisplays()
    .map((display) => {
      const bounds = display && display.bounds;
      const workArea = display && (display.workArea || bounds);
      if (!bounds || !workArea) return null;

      const normalizeRect = (rect) => {
        const { x, y, width, height } = rect;
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
        return {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height)
        };
      };
      const normalizedBounds = normalizeRect(bounds);
      const normalizedWorkArea = normalizeRect(workArea);
      if (!normalizedBounds || !normalizedWorkArea) return null;

      return {
        id: display.id,
        bounds: normalizedBounds,
        workArea: normalizedWorkArea
      };
    })
    .filter(Boolean);
}

function replaceHandler(channel, handler) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, handler);
}

function replaceListener(channel, listener) {
  if (typeof ipcMain.removeAllListeners === "function") {
    ipcMain.removeAllListeners(channel);
  }
  ipcMain.on(channel, listener);
}

function focusWindow(window) {
  if (usableWindow(window)) {
    window.focus();
  }
}

function sanitizePackageId(packageId, fallbackPackageId = "default-pet") {
  const fallback = typeof fallbackPackageId === "string" && fallbackPackageId.trim()
    ? fallbackPackageId
    : "default-pet";
  const rawValue = typeof packageId === "string" && packageId.trim() ? packageId : fallback;
  const sanitized = rawValue
    .normalize("NFKC")
    .replace(/[\\/]+/g, "-")
    .replace(/[^\p{L}\p{N}._-]/gu, "-")
    .replace(/^\.+/, "")
    .replace(/-+/g, "-")
    .slice(0, 80);

  return sanitized || "default-pet";
}

function getSenderId(event) {
  return event && event.sender && event.sender.id;
}

function sendAssetProgress(event, operationId, payload) {
  if (!operationId || !event || !event.sender) return;
  if (typeof event.sender.isDestroyed === "function" && event.sender.isDestroyed()) return;
  event.sender.send("asset:progress", {
    operationId,
    ...payload
  });
}

function sanitizeLogData(data) {
  if (data === undefined) return undefined;
  if (typeof data === "string") return data.slice(0, 8000);
  try {
    return JSON.stringify(data).slice(0, 8000);
  } catch (_error) {
    return String(data).slice(0, 8000);
  }
}

function sanitizeLogPayload(payload = {}) {
  const scope = typeof payload.scope === "string" && payload.scope.trim()
    ? payload.scope.trim().slice(0, 80)
    : "renderer";
  const level = typeof payload.level === "string" ? payload.level : "info";
  const message = typeof payload.message === "string"
    ? payload.message.slice(0, 4000)
    : "";
  const data = sanitizeLogData(payload.data);

  return { scope, level, message, data };
}

function isSafePackageId(packageId) {
  return isSafeRelativePath(packageId) && !packageId.includes("/");
}

function collectPackageFiles(packageDir, currentDir = packageDir, files = []) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(packageDir, absolutePath).split(path.sep).join("/");

    if (!isSafeRelativePath(relativePath) || entry.isSymbolicLink()) {
      return { ok: false, error: "Active package contains unsafe entries" };
    }

    if (entry.isDirectory()) {
      const result = collectPackageFiles(packageDir, absolutePath, files);
      if (!result.ok) return result;
      continue;
    }

    if (!entry.isFile()) {
      return { ok: false, error: "Active package contains unsupported entries" };
    }

    files.push(relativePath);
  }

  return { ok: true, files };
}

function readJsonFile(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (_error) {
    return { ok: false, error: "Active package manifest is invalid" };
  }
}

function addAssetReference(assetReferences, asset) {
  if (typeof asset === "string" && asset.trim()) {
    assetReferences.add(asset);
  }
}

function collectManifestAssetReferences(manifest, config) {
  const assetReferences = new Set();

  addAssetReference(assetReferences, manifest && manifest.preview);
  const animations = (config && config.animations) || (manifest && manifest.animations) || {};
  addAssetReference(assetReferences, animations.default && animations.default.asset);
  if (Array.isArray(animations.clips)) {
    animations.clips.forEach((clip) => addAssetReference(assetReferences, clip && clip.asset));
  }

  return assetReferences;
}

function getBundledDefaultPackageDir() {
  return path.resolve(__dirname, "..", "assets", "default-pet");
}

function createPackageManifest(packageId, config = {}) {
  return {
    schemaVersion: "2.0.0",
    packageId,
    name: packageId,
    version: "1.0.0",
    animations: config.animations || DEFAULT_CONFIG.animations,
    triggerRules: Array.isArray(config.triggerRules) ? config.triggerRules : []
  };
}

function copyDirectory(sourceDir, targetDir, rootDir = sourceDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath, rootDir);
      continue;
    }
    if (entry.isFile()) {
      const relativePath = path.relative(rootDir, sourcePath).split(path.sep).join("/");
      if (relativePath !== "manifest.json" && !SUPPORTED_ASSET_EXTENSIONS.includes(path.extname(relativePath).toLowerCase())) {
        continue;
      }
      if (!fs.existsSync(targetPath)) {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }
}

function ensurePackageDir(userDataDir, packageId, config = {}) {
  const packagesDir = path.join(userDataDir, "packages");
  const packageDir = path.join(packagesDir, packageId);
  const packageExists = fs.existsSync(packageDir);
  if (!isSafePackageId(packageId)) {
    return { ok: false, error: "Package ID is unsafe" };
  }

  if (!packageExists) {
    copyDirectory(getBundledDefaultPackageDir(), packageDir);
  }

  const manifestPath = path.join(packageDir, "manifest.json");
  const manifestConfig = packageId === "default-pet" && !packageExists ? DEFAULT_CONFIG : config;
  if (!fs.existsSync(manifestPath) || !packageExists) {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(createPackageManifest(packageId, manifestConfig), null, 2),
      "utf8"
    );
  }

  return { ok: true, packageDir, packagesDir };
}

function getPackageConfigFromManifest(packageDir, fallbackConfig = {}) {
  const manifestResult = readJsonFile(path.join(packageDir, "manifest.json"));
  if (!manifestResult.ok) return manifestResult;

  const manifest = manifestResult.value || {};
  return {
    ok: true,
    animations: manifest.animations || fallbackConfig.animations || DEFAULT_CONFIG.animations,
    triggerRules: Array.isArray(manifest.triggerRules)
      ? manifest.triggerRules
      : (Array.isArray(fallbackConfig.triggerRules) ? fallbackConfig.triggerRules : [])
  };
}

function loadPackageConfig(userDataDir, packageId, fallbackConfig = {}) {
  const ensured = ensurePackageDir(userDataDir, packageId, fallbackConfig);
  if (!ensured.ok) return ensured;
  const packageConfig = getPackageConfigFromManifest(ensured.packageDir, fallbackConfig);
  if (!packageConfig.ok) return packageConfig;
  return { ...packageConfig, packageDir: ensured.packageDir };
}

function loadConfigForActivePackage(userDataDir, config = {}) {
  const packageId = config && config.currentPackageId;
  if (typeof packageId !== "string" || !isSafePackageId(packageId)) {
    logger.debug("config:load skipped active package merge (no safe packageId)", {
      hasPackageId: typeof packageId === "string"
    });
    return config;
  }
  const packageConfig = loadPackageConfig(userDataDir, packageId, config);
  if (!packageConfig.ok) {
    logger.debug("config:load fell back to saved config (package config not ok)", { packageId });
    return config;
  }
  return {
    ...config,
    currentPackageId: packageId,
    animations: packageConfig.animations,
    triggerRules: packageConfig.triggerRules
  };
}

function saveConfigToActivePackageManifest(userDataDir, config) {
  const packageId = config && config.currentPackageId;
  if (typeof packageId !== "string" || !isSafePackageId(packageId)) {
    return;
  }

  const packagesDir = path.resolve(userDataDir, "packages");
  if (packageId === "default-pet") {
    const ensured = ensurePackageDir(userDataDir, packageId, config);
    if (!ensured.ok) return;
  }

  const packageDir = path.resolve(packagesDir, packageId);
  const relative = path.relative(packagesDir, packageDir);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(packageDir)) {
    return;
  }

  const manifestPath = path.join(packageDir, "manifest.json");
  const manifestResult = readJsonFile(manifestPath);
  const manifest = manifestResult.ok
    ? manifestResult.value
    : createPackageManifest(packageId, config);

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      packageId,
      animations: config.animations || manifest.animations || DEFAULT_CONFIG.animations,
      triggerRules: Array.isArray(config.triggerRules) ? config.triggerRules : []
    }, null, 2),
    "utf8"
  );
}

function listPackages(userDataDir, currentPackageId) {
  const packagesDir = path.join(userDataDir, "packages");
  const packageIds = new Set(["default-pet"]);
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && isSafePackageId(entry.name)) {
        packageIds.add(entry.name);
      }
    }
  }
  return [...packageIds].sort().map((packageId) => ({
    packageId,
    isCurrent: packageId === currentPackageId,
    source: packageId === "default-pet" && !fs.existsSync(path.join(packagesDir, packageId)) ? "bundled" : "user"
  }));
}

function deletePackageDir(userDataDir, packageId) {
  if (packageId === "default-pet") {
    return { ok: false, error: "Default package cannot be deleted" };
  }
  if (!isSafePackageId(packageId)) {
    return { ok: false, error: "Package ID is unsafe" };
  }

  const packagesDir = path.resolve(userDataDir, "packages");
  const packageDir = path.resolve(packagesDir, packageId);
  const relative = path.relative(packagesDir, packageDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, error: "Package path is unsafe" };
  }
  if (!fs.existsSync(packageDir)) {
    return { ok: false, error: "Package does not exist" };
  }

  fs.rmSync(packageDir, { recursive: true, force: true });
  return { ok: true, packageId };
}

function listPackageAssets(userDataDir, packageId, config = {}) {
  const ensured = ensurePackageDir(userDataDir, packageId, config);
  if (!ensured.ok) return ensured;
  const assetsDir = path.join(ensured.packageDir, "assets");
  if (!fs.existsSync(assetsDir)) return { ok: true, assets: [] };

  const assets = [];
  for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_ASSET_EXTENSIONS.includes(ext)) continue;
    const asset = `assets/${entry.name}`;
    const absolutePath = path.join(assetsDir, entry.name);
    const durationMs = getAssetDurationMs(absolutePath, ext);
    assets.push({
      asset,
      name: entry.name,
      ext,
      url: getPackageAssetUrl(ensured.packageDir, asset),
      ...(durationMs ? { durationMs } : {})
    });
  }
  return { ok: true, assets: assets.sort((a, b) => a.asset.localeCompare(b.asset)) };
}

function getPackageAssetUrl(packageDir, asset) {
  if (!isSafeRelativePath(asset)) return "";

  const assetPath = path.resolve(packageDir, asset);
  const relative = path.relative(packageDir, assetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  if (!fs.existsSync(assetPath)) return "";

  const stats = fs.lstatSync(assetPath);
  if (!stats.isFile() || stats.isSymbolicLink()) return "";

  return `${pathToFileURL(assetPath).href}?v=${Math.round(stats.mtimeMs)}`;
}

function loadActivePackageRuntime(userDataDir, config) {
  const packageId = config && config.currentPackageId;
  if (typeof packageId !== "string" || !isSafePackageId(packageId)) {
    return { package: null, packageError: "Active package ID is invalid" };
  }

  const packagesDir = path.resolve(userDataDir, "packages");
  const packageDir = path.resolve(packagesDir, packageId);
  const relativePackageDir = path.relative(packagesDir, packageDir);
  if (relativePackageDir.startsWith("..") || path.isAbsolute(relativePackageDir)) {
    return { package: null, packageError: "Active package path is invalid" };
  }

  if (packageId === "default-pet" && !fs.existsSync(packageDir)) {
    const ensured = ensurePackageDir(userDataDir, packageId, config);
    if (!ensured.ok) {
      return { package: null, packageError: ensured.error };
    }
  }

  if (!fs.existsSync(packageDir)) {
    return { package: null, packageError: "Active package is unavailable" };
  }

  const collected = collectPackageFiles(packageDir);
  if (!collected.ok) {
    return { package: null, packageError: collected.error };
  }

  const manifestResult = readJsonFile(path.join(packageDir, "manifest.json"));
  if (!manifestResult.ok) {
    return { package: null, packageError: manifestResult.error };
  }

  const manifest = manifestResult.value;
  const validation = validateManifest(manifest, new Set(collected.files));
  if (!validation.ok || manifest.packageId !== packageId) {
    return { package: null, packageError: "Active package manifest is invalid" };
  }

  const assetsByPath = {};
  for (const asset of collectManifestAssetReferences(manifest, config)) {
    const url = getPackageAssetUrl(packageDir, asset);
    if (url) {
      assetsByPath[asset] = url;
    }
  }

  return {
    package: {
      packageId,
      manifest,
      assetsByPath
    },
    packageError: null
  };
}

let lastBroadcastDisplayJson = "";
function sendDisplayUpdate(getWindows, display) {
  const petWindow = getPetWindow(getWindows);
  if (!petWindow || !petWindow.webContents) return;
  // Resize is cheap (short-circuits when the size is unchanged), but the
  // pet:display-updated broadcast triggers renderer work — skip it when the
  // display payload is identical to the last one we broadcast.
  resizePetWindowForScale(petWindow, display);
  const json = JSON.stringify(display || {});
  if (json === lastBroadcastDisplayJson) return;
  lastBroadcastDisplayJson = json;
  petWindow.webContents.send("pet:display-updated", display);
}

function sendRuntimeUpdate(getWindows, userDataDir, config) {
  const petWindow = getPetWindow(getWindows);
  if (petWindow && petWindow.webContents) {
    petWindow.webContents.send("pet:runtime-updated", {
      config,
      ...loadActivePackageRuntime(userDataDir, config)
    });
  }
}

function normalizeExportRulesPayload(payload = {}) {
  const packageId = typeof payload.packageId === "string" && payload.packageId.trim()
    ? payload.packageId.trim()
    : "default-pet";
  const rules = Array.isArray(payload.rules)
    ? payload.rules.filter((rule) => rule && typeof rule === "object" && !Array.isArray(rule))
    : [];
  const target = payload.target === "clipboard" ? "clipboard" : "file";
  return { packageId, rules, target };
}

function normalizeImportRulesPayload(payload = {}) {
  return {
    source: payload && payload.source === "clipboard" ? "clipboard" : "file"
  };
}

function createRulesFilePayload(packageId, rules) {
  return {
    type: RULES_FILE_TYPE,
    schemaVersion: RULES_FILE_SCHEMA_VERSION,
    packageId,
    exportedAt: new Date().toISOString(),
    rules
  };
}

function stringifyRulesFilePayload(packageId, rules) {
  return `${JSON.stringify(createRulesFilePayload(packageId, rules), null, 2)}\n`;
}

function parseRulesFile(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (_error) {
    return { ok: false, error: "Invalid rules file: JSON parse failed" };
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.type !== RULES_FILE_TYPE ||
    parsed.schemaVersion !== RULES_FILE_SCHEMA_VERSION ||
    !Array.isArray(parsed.rules)
  ) {
    return { ok: false, error: "Invalid rules file: expected desktop-pet trigger rules" };
  }

  const rules = parsed.rules.filter((rule) => rule && typeof rule === "object" && !Array.isArray(rule));
  if (rules.length !== parsed.rules.length) {
    return { ok: false, error: "Invalid rules file: rules must be objects" };
  }

  // Validate each rule's conditions and actions against the schema
  const validationErrors = [];
  for (const [ruleIndex, rule] of rules.entries()) {
    const ruleLabel = `rules[${ruleIndex}]`;
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    conditions.forEach((condition, conditionIndex) => {
      validateCondition(condition, `${ruleLabel}.conditions[${conditionIndex}]`, validationErrors);
    });
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    actions.forEach((action, actionIndex) => {
      validateAction(action, `${ruleLabel}.actions[${actionIndex}]`, null, validationErrors);
    });
    const state = rule.state && typeof rule.state === "object" && !Array.isArray(rule.state) ? rule.state : null;
    const exitConditions = state && Array.isArray(state.exitConditions) ? state.exitConditions : [];
    exitConditions.forEach((condition, conditionIndex) => {
      validateCondition(condition, `${ruleLabel}.state.exitConditions[${conditionIndex}]`, validationErrors);
    });
    const exitActions = state && Array.isArray(state.exitActions) ? state.exitActions : [];
    exitActions.forEach((action, actionIndex) => {
      validateAction(action, `${ruleLabel}.state.exitActions[${actionIndex}]`, null, validationErrors);
    });
  }
  if (validationErrors.length > 0) {
    return { ok: false, error: `Invalid rules file: ${validationErrors[0]}` };
  }

  return {
    ok: true,
    rules,
    meta: {
      packageId: typeof parsed.packageId === "string" ? parsed.packageId : "",
      exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : "",
      schemaVersion: parsed.schemaVersion
    }
  };
}

function sendInteractionsPausedUpdate(getWindows, enabled) {
  const petWindow = getPetWindow(getWindows);
  if (petWindow && petWindow.webContents) {
    petWindow.webContents.send("pet:interactions-paused", Boolean(enabled));
  }
}

function registerIpc({ getWindows, createPanelWindow, configStore: injectedConfigStore, openContextMenu } = {}) {
  const userDataDir = app.getPath("userData");
  const configStore = injectedConfigStore || createConfigStore(userDataDir);
  const initialConfig = configStore.load() || DEFAULT_CONFIG;
  configureLogger({
    userDataDir,
    enabled: initialConfig.system?.logging?.enabled !== false,
    level: initialConfig.system?.logging?.level || DEFAULT_CONFIG.system.logging.level
  });
  logger.info("IPC registered", { userDataDir });
  const approvedAssetPathsBySender = new Map();
  const petPositionScheduler = createPetPositionScheduler({ getWindows });

  replaceListener("asset:approve-dropped", (event, sourcePath) => {
    const senderId = getSenderId(event);
    if (senderId === undefined || typeof sourcePath !== "string" || !sourcePath) return;
    const approvedPaths = approvedAssetPathsBySender.get(senderId) || new Set();
    approvedPaths.add(sourcePath);
    approvedAssetPathsBySender.set(senderId, approvedPaths);
  });

  // Token-bucket rate limiter for renderer log writes
  const logBucket = { tokens: 100, max: 100, refillRate: 50, lastRefill: Date.now(), warned: false };

  replaceListener("log:write", (_event, payload) => {
    const now = Date.now();
    const elapsed = (now - logBucket.lastRefill) / 1000;
    logBucket.tokens = Math.min(logBucket.max, logBucket.tokens + elapsed * logBucket.refillRate);
    logBucket.lastRefill = now;

    if (logBucket.tokens < 1) {
      if (!logBucket.warned) {
        logBucket.warned = true;
        logger.warn("Renderer log rate limit reached, dropping messages");
      }
      return;
    }

    logBucket.tokens -= 1;
    if (logBucket.warned && logBucket.tokens > logBucket.max * 0.5) {
      logBucket.warned = false;
    }

    const nextLog = sanitizeLogPayload(payload);
    const rendererLogger = createLogger(nextLog.scope);
    const write = typeof rendererLogger[nextLog.level] === "function"
      ? rendererLogger[nextLog.level]
      : rendererLogger.info;
    write(nextLog.message, nextLog.data);
  });

  replaceHandler("package:list", () => {
    const loadedConfig = configStore.load();
    return {
      ok: true,
      packages: listPackages(userDataDir, loadedConfig.currentPackageId || "default-pet")
    };
  });
  replaceHandler("package:create", (_event, packageId) => {
    const loadedConfig = configStore.load();
    const nextPackageId = sanitizePackageId(packageId, "pet-package");
    logger.info("Creating package", { requestedPackageId: packageId, packageId: nextPackageId });
    const packageConfig = loadPackageConfig(userDataDir, nextPackageId, {
      ...DEFAULT_CONFIG,
      currentPackageId: nextPackageId
    });
    if (!packageConfig.ok) return packageConfig;
    const savedConfig = configStore.save({
      ...loadedConfig,
      currentPackageId: nextPackageId,
      animations: packageConfig.animations,
      triggerRules: packageConfig.triggerRules
    });
    sendRuntimeUpdate(getWindows, userDataDir, savedConfig);
    return savedConfig;
  });
  replaceHandler("package:delete", (_event, packageId) => {
    const loadedConfig = configStore.load();
    const selectedPackageId = sanitizePackageId(packageId, "");
    logger.info("Deleting package", { packageId: selectedPackageId });
    const deleted = deletePackageDir(userDataDir, selectedPackageId);
    if (!deleted.ok) return deleted;

    const shouldSwitchToDefault = loadedConfig.currentPackageId === selectedPackageId;
    const savedConfig = shouldSwitchToDefault
      ? (() => {
        const packageConfig = loadPackageConfig(userDataDir, "default-pet", loadedConfig);
        if (!packageConfig.ok) return packageConfig;
        return configStore.save({
          ...loadedConfig,
          currentPackageId: "default-pet",
          animations: packageConfig.animations,
          triggerRules: packageConfig.triggerRules
        });
      })()
      : loadedConfig;

    if (savedConfig && savedConfig.ok === false) return savedConfig;

    if (shouldSwitchToDefault) {
      sendRuntimeUpdate(getWindows, userDataDir, savedConfig);
    }

    return {
      ok: true,
      packageId: selectedPackageId,
      currentPackageId: savedConfig.currentPackageId || "default-pet"
    };
  });
  replaceHandler("package:switch", (_event, packageId) => {
    const loadedConfig = configStore.load();
    const nextPackageId = sanitizePackageId(packageId, loadedConfig.currentPackageId || "default-pet");
    logger.info("Switching package", { packageId: nextPackageId });
    const packageConfig = loadPackageConfig(userDataDir, nextPackageId, loadedConfig);
    if (!packageConfig.ok) return packageConfig;
    const savedConfig = configStore.save({
      ...loadedConfig,
      currentPackageId: nextPackageId,
      animations: packageConfig.animations,
      triggerRules: packageConfig.triggerRules
    });
    sendRuntimeUpdate(getWindows, userDataDir, savedConfig);
    return savedConfig;
  });
  replaceHandler("asset:list", (_event, packageId) => {
    const loadedConfig = configStore.load();
    const selectedPackageId = sanitizePackageId(packageId, loadedConfig.currentPackageId || "default-pet");
    return listPackageAssets(userDataDir, selectedPackageId, loadedConfig);
  });
  replaceHandler("asset:pick", async (event) => {
    const panelWindow = getPanelWindow(getWindows);
    const dialogOptions = {
      properties: ["openFile"],
      filters: [
        {
          name: "Pet assets",
          extensions: SUPPORTED_ASSET_EXTENSIONS.map((extension) => extension.slice(1))
        }
      ]
    };
    const result = panelWindow
      ? await dialog.showOpenDialog(panelWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return null;
    }

    const selectedPath = result.filePaths[0];
    const senderId = getSenderId(event);
    if (senderId !== undefined) {
      const approvedPaths = approvedAssetPathsBySender.get(senderId) || new Set();
      approvedPaths.add(selectedPath);
      approvedAssetPathsBySender.set(senderId, approvedPaths);
    }

    return selectedPath;
  });
  replaceHandler("asset:import", async (event, payload) => {
    const sourcePath = payload && payload.sourcePath;
    const senderId = getSenderId(event);
    const approvedPaths = approvedAssetPathsBySender.get(senderId);
    if (!approvedPaths || !approvedPaths.has(sourcePath)) {
      logger.warn("Rejected asset import without picker approval", { senderId, sourcePath });
      return { ok: false, error: "Asset path was not selected" };
    }

    const loadedConfig = configStore.load();
    const packageId = sanitizePackageId(
      payload && payload.packageId,
      loadedConfig.currentPackageId || "default-pet"
    );
    const ensured = ensurePackageDir(userDataDir, packageId, loadedConfig);
    if (!ensured.ok) return ensured;

    logger.info("Importing asset", { packageId, importName: payload && payload.importName });
    return copyAssetToPackageWithProgress({
      sourcePath,
      packageDir: ensured.packageDir,
      importName: payload && payload.importName,
      onProgress: (progress) => sendAssetProgress(event, payload && payload.operationId, progress)
    });
  });
  replaceHandler("asset:replace", async (event, payload) => {
    const loadedConfig = configStore.load();
    const packageId = sanitizePackageId(
      payload && payload.packageId,
      loadedConfig.currentPackageId || "default-pet"
    );
    const ensured = ensurePackageDir(userDataDir, packageId, loadedConfig);
    if (!ensured.ok) return ensured;

    const result = await replaceAssetInPackageWithProgress({
      sourcePath: payload && payload.sourcePath,
      packageDir: ensured.packageDir,
      targetAssetPath: payload && payload.targetAssetPath,
      onProgress: (progress) => sendAssetProgress(event, payload && payload.operationId, progress)
    });
    if (result.ok) {
      logger.info("Replaced asset", { packageId, assetPath: payload && payload.targetAssetPath });
      sendRuntimeUpdate(getWindows, userDataDir, loadedConfig);
    }
    return result;
  });
  replaceHandler("asset:delete", (_event, payload) => {
    const loadedConfig = configStore.load();
    const packageId = sanitizePackageId(
      payload && payload.packageId,
      loadedConfig.currentPackageId || "default-pet"
    );
    const ensured = ensurePackageDir(userDataDir, packageId, loadedConfig);
    if (!ensured.ok) return ensured;
    logger.info("Deleting asset", { packageId, assetPath: payload && payload.assetPath });
    return deleteAssetFromPackage({ packageDir: ensured.packageDir, assetPath: payload && payload.assetPath });
  });
  replaceHandler("asset:bake-green-screen", async (event, payload) => {
    const loadedConfig = configStore.load();
    const packageId = sanitizePackageId(
      payload && payload.packageId,
      loadedConfig.currentPackageId || "default-pet"
    );
    const ensured = ensurePackageDir(userDataDir, packageId, loadedConfig);
    if (!ensured.ok) return ensured;

    logger.info("Baking green screen to transparent webm", {
      packageId,
      sourceAssetPath: payload && payload.sourceAssetPath
    });
    const result = await bakeGreenScreenInPackage({
      packageDir: ensured.packageDir,
      sourceAssetPath: payload && payload.sourceAssetPath,
      color: payload && payload.color,
      tolerance: payload && payload.tolerance,
      softness: payload && payload.softness,
      onProgress: (progress) => sendAssetProgress(event, payload && payload.operationId, progress)
    });
    if (result.ok) {
      logger.info("Baked green screen asset", { packageId, asset: result.asset });
      sendRuntimeUpdate(getWindows, userDataDir, loadedConfig);
    } else {
      logger.warn("Green screen baking failed", { packageId, error: result.error });
    }
    return result;
  });
  replaceHandler("petpack:import", async () => {
    const panelWindow = getPanelWindow(getWindows);
    const dialogOptions = {
      properties: ["openFile"],
      filters: [
        { name: "Petpacks", extensions: ["petpack", "zip"] }
      ]
    };
    const result = panelWindow
      ? await dialog.showOpenDialog(panelWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return null;
    }

    logger.info("Importing petpack from picker");
    return importPetpack(result.filePaths[0], userDataDir);
  });
  replaceHandler("petpack:install-sample", async () => {
    logger.info("Downloading and importing sample petpack", { url: SAMPLE_PETPACK_URL });
    try {
      const result = await installSamplePetpack({
        fetchImpl: globalThis.fetch,
        userDataDir
      });
      if (!result || result.ok === false) {
        logger.warn("Sample petpack import failed", { error: result && result.error });
        return result || { ok: false, error: "Sample petpack import failed" };
      }
      logger.info("Sample petpack imported", { packageId: result.packageId || "" });
      return result;
    } catch (error) {
      logger.warn("Could not download and import sample petpack", { error: error.message || error });
      return { ok: false, error: error.message || String(error) };
    }
  });
  replaceHandler("petpack:export", async (_event, packageId) => {
    const loadedConfig = configStore.load();
    const selectedPackageId = typeof packageId === "string" && packageId.trim()
      ? packageId.trim()
      : loadedConfig.currentPackageId || "default-pet";
    const panelWindow = getPanelWindow(getWindows);
    const dialogOptions = {
      defaultPath: `${selectedPackageId}.petpack`,
      filters: [
        { name: "Petpack", extensions: ["petpack"] },
        { name: "Zip", extensions: ["zip"] }
      ]
    };
    const result = panelWindow
      ? await dialog.showSaveDialog(panelWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
      return null;
    }

    const packageConfig = loadPackageConfig(userDataDir, selectedPackageId, loadedConfig);
    if (!packageConfig.ok) return packageConfig;
    logger.info("Exporting petpack", { packageId: selectedPackageId, targetPath: result.filePath });
    return exportPetpack(selectedPackageId, userDataDir, result.filePath, {
      animations: packageConfig.animations,
      triggerRules: packageConfig.triggerRules
    });
  });
  replaceHandler("rules:export", async (_event, payload = {}) => {
    const { packageId, rules, target } = normalizeExportRulesPayload(payload);
    const fileContents = stringifyRulesFilePayload(packageId, rules);
    if (target === "clipboard") {
      logger.info("Copying trigger rules to clipboard", { packageId, count: rules.length });
      try {
        clipboard.writeText(fileContents);
      } catch (error) {
        logger.error("Failed to copy trigger rules to clipboard", { error: error.message || error });
        return { ok: false, error: `Rule export failed: ${error.message || error}` };
      }
      return { ok: true, target: "clipboard", count: rules.length };
    }

    const panelWindow = getPanelWindow(getWindows);
    const dialogOptions = {
      defaultPath: `${packageId}-rules.json`,
      filters: [
        { name: "Rules JSON", extensions: ["json"] }
      ]
    };
    const result = panelWindow
      ? await dialog.showSaveDialog(panelWindow, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);

    if (result.canceled || !result.filePath) {
      return null;
    }

    logger.info("Exporting trigger rules", { packageId, count: rules.length, targetPath: result.filePath });
    try {
      fs.writeFileSync(result.filePath, fileContents, "utf8");
    } catch (error) {
      logger.error("Failed to export trigger rules", { targetPath: result.filePath, error: error.message || error });
      return { ok: false, error: `Rule export failed: ${error.message || error}` };
    }
    return { ok: true, targetPath: result.filePath, count: rules.length };
  });
  replaceHandler("rules:import", async (_event, payload = {}) => {
    const { source } = normalizeImportRulesPayload(payload);
    if (source === "clipboard") {
      logger.info("Importing trigger rules from clipboard");
      try {
        return parseRulesFile(clipboard.readText());
      } catch (error) {
        return { ok: false, error: `Invalid rules file: ${error.message || error}` };
      }
    }

    const panelWindow = getPanelWindow(getWindows);
    const dialogOptions = {
      properties: ["openFile"],
      filters: [
        { name: "Rules JSON", extensions: ["json"] }
      ]
    };
    const result = panelWindow
      ? await dialog.showOpenDialog(panelWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return null;
    }

    const sourcePath = result.filePaths[0];
    logger.info("Importing trigger rules", { sourcePath });
    try {
      return parseRulesFile(fs.readFileSync(sourcePath, "utf8"));
    } catch (error) {
      return { ok: false, error: `Invalid rules file: ${error.message || error}` };
    }
  });
  replaceHandler("config:load", () => loadConfigForActivePackage(userDataDir, configStore.load()));
  replaceHandler("config:save", (_event, config) => {
    const savedConfig = configStore.save(config);
    configureLogger({
      enabled: savedConfig.system?.logging?.enabled !== false,
      level: savedConfig.system?.logging?.level || DEFAULT_CONFIG.system.logging.level
    });
    logger.info("Config saved", { packageId: savedConfig.currentPackageId });
    saveConfigToActivePackageManifest(userDataDir, savedConfig);
    sendDisplayUpdate(getWindows, savedConfig.display || {});
    sendRuntimeUpdate(getWindows, userDataDir, savedConfig);
    return savedConfig;
  });
  replaceHandler("menu:open-context-menu", () => {
    if (typeof openContextMenu === "function") {
      openContextMenu();
    }
  });
  replaceHandler("panel:show", async () => {
    const panelWindow = getPanelWindow(getWindows);
    if (panelWindow) {
      panelWindow.show();
      focusWindow(panelWindow);
      return;
    }

    const nextPanelWindow = await createPanelWindow({ show: true });
    focusWindow(nextPanelWindow);
  });
  replaceHandler("pet:load-runtime", () => {
    const config = configStore.load();
    return {
      config,
      ...loadActivePackageRuntime(userDataDir, config)
    };
  });
  replaceHandler("pet:get-displays", () => getDisplayLayouts());
  replaceHandler("pet:apply-display", (_event, display) => {
    const nextDisplay = display && typeof display === "object" && !Array.isArray(display) ? display : {};
    sendDisplayUpdate(getWindows, nextDisplay);
  });
  replaceHandler("pet:reset-position", (_event, position = {}) => {
    const petWindow = getPetWindow(getWindows);
    if (!petWindow) return;

    const currentBounds = petWindow.getBounds();
    const x = Number.isFinite(position.x) ? Math.round(position.x) : currentBounds.x;
    const y = Number.isFinite(position.y) ? Math.round(position.y) : currentBounds.y;
    petWindow.setBounds({
      ...currentBounds,
      x,
      y
    });
  });
  replaceHandler("pet:set-always-on-top", (_event, enabled) => {
    const petWindow = getPetWindow(getWindows);
    if (petWindow) {
      petWindow.setAlwaysOnTop(Boolean(enabled));
    }
  });
  replaceHandler("pet:set-mouse-passthrough", (_event, enabled) => {
    const petWindow = getPetWindow(getWindows);
    if (petWindow) {
      petWindow.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
    }
  });
  replaceHandler("pet:set-interactions-paused", (_event, enabled) => {
    const nextEnabled = Boolean(enabled);
    const config = configStore.load() || {};
    const savedConfig = configStore.save({
      ...config,
      system: {
        ...DEFAULT_CONFIG.system,
        ...(config.system || {}),
        interactionsPaused: nextEnabled
      }
    });
    logger.info("Pet interactions pause changed", { enabled: nextEnabled });
    sendInteractionsPausedUpdate(getWindows, nextEnabled);
    return savedConfig;
  });
  replaceHandler("pet:set-bounds", (_event, bounds) => {
    const nextBounds = normalizeBounds(bounds);
    const petWindow = getPetWindow(getWindows);
    if (petWindow) {
      petWindow.setBounds(nextBounds);
    }
  });
  replaceListener("pet:set-position", (_event, position) => {
    petPositionScheduler.request(position);
  });
  replaceHandler("system:get-launch-at-login", () => getLaunchAtLogin(app));
  replaceHandler("system:set-launch-at-login", (_event, enabled) => {
    const nextEnabled = Boolean(enabled);
    setLaunchAtLogin(app, nextEnabled);
    logger.info("Launch at login changed", { enabled: nextEnabled });

    const config = configStore.load();
    configStore.save({
      ...config,
      system: {
        ...(config.system || {}),
        launchAtLogin: nextEnabled
      }
    });

    return nextEnabled;
  });
  replaceHandler("system:about:get-info", () => ({
    ok: true,
    version: app.getVersion()
  }));
  replaceHandler("system:about:open-link", async (_event, target) => {
    const url = getOfficialLink(target);
    if (!url) {
      logger.warn("Rejected unknown official link target", { target });
      return { ok: false, error: "Unknown official link" };
    }

    logger.info("Opening official application link", { target, url });
    try {
      await shell.openExternal(url);
      return { ok: true, target };
    } catch (error) {
      logger.warn("Could not open official application link", { target, error: error.message || error });
      return { ok: false, error: error.message || String(error) };
    }
  });
  replaceHandler("system:about:check-updates", async () => {
    const currentVersion = app.getVersion();
    logger.info("Checking for application updates", { currentVersion });
    try {
      const result = await checkForUpdates({
        fetchImpl: globalThis.fetch,
        currentVersion
      });
      logger.info("Application update check completed", {
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        updateAvailable: result.updateAvailable
      });
      return result;
    } catch (error) {
      logger.warn("Application update check failed", { error: error.message || error });
      return { ok: false, error: error.message || String(error), currentVersion };
    }
  });
  replaceHandler("system:logs:get-settings", () => getLoggerSettings());
  replaceHandler("system:logs:list", () => listLogFiles());
  replaceHandler("system:logs:read", (_event, payload = {}) => readLogFile(payload.fileName, {
    maxBytes: payload.maxBytes
  }));
  replaceHandler("system:logs:clear", () => {
    return clearLogs();
  });
  replaceHandler("system:logs:open-directory", async () => {
    const settings = getLoggerSettings();
    fs.mkdirSync(settings.logsDir, { recursive: true });
    const result = await shell.openPath(settings.logsDir);
    return result ? { ok: false, error: result } : { ok: true, logsDir: settings.logsDir };
  });
  replaceHandler("app:quit", () => app.quit());

  // Runtime state query handler
  replaceHandler("pet:get-runtime-state", async () => {
    const petWindow = getPetWindow(getWindows);
    if (!petWindow || !petWindow.webContents) {
      return { ok: false, error: "Pet window not available" };
    }

    try {
      const state = await petWindow.webContents.executeJavaScript(
        "typeof window.__getPetRuntimeState === 'function' ? window.__getPetRuntimeState() : null"
      );
      return { ok: true, state };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Runtime state push forwarder
  ipcMain.on("pet:push-runtime-state", (_event, state) => {
    const panelWindow = getPanelWindow(getWindows);
    if (panelWindow && panelWindow.webContents) {
      panelWindow.webContents.send("pet:runtime-state-updated", state);
    }
  });
}

module.exports = {
  CHANNELS,
  createPetPositionScheduler,
  loadActivePackageRuntime,
  normalizeBounds,
  normalizePosition,
  registerIpc,
  sanitizePackageId
};
