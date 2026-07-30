const { app, dialog, Menu, shell } = require("electron");
const { configureMacStatusBarMode } = require("./macos-status-bar");

// Configure this before waiting for Electron readiness or creating any windows.
// Packaged macOS builds also set LSUIElement, while this keeps development runs
// and older packages from registering as regular Dock applications.
const macStatusBarMode = configureMacStatusBarMode({ app });

const { registerIpc } = require("./ipc");
const { createDesktopPetMenu, createMenuActions } = require("./menu");
const { createConfigStore } = require("./services/config-store");
const { configureLogger, createLogger, shutdownLogger } = require("./services/logger");
const { importPetpack } = require("./services/petpack");
const { loadConfigWithFirstRunLanguage } = require("./services/system-language");
const { createTray } = require("./tray");
const { createPanelWindow, createPetWindow, getWindows } = require("./windows");
const { createGlobalMouseTracker } = require("./global-mouse-tracker");
const { getOnboardingVersion, shouldShowOnboarding } = require("./onboarding");

let configStore;
let menuActions;
let globalMouseTracker;
let trayController;
let userDataDir;

const logger = createLogger("main");

function getPetWindow() {
  const { pet } = getWindows();
  return pet && !pet.isDestroyed() ? pet : null;
}

function getPanelWindow() {
  const { panel } = getWindows();
  return panel && !panel.isDestroyed() ? panel : null;
}

function notifyPackageChanged(payload) {
  const panelWindow = getPanelWindow();
  if (panelWindow && panelWindow.webContents) {
    panelWindow.webContents.send("package:changed", payload);
  }
}

async function importPetpackFromDialog() {
  const panelWindow = getPanelWindow();
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

  const imported = await importPetpack(result.filePaths[0], userDataDir);
  if (imported && imported.ok && imported.packageId) {
    const config = configStore.load();
    configStore.save({
      ...config,
      currentPackageId: imported.packageId
    });
    notifyPackageChanged({ packageId: imported.packageId, reason: "import" });
  }

  return imported;
}

function refreshMenus() {
  if (trayController) {
    trayController.refresh();
  }
}

function createNativeMenu() {
  return createDesktopPetMenu({
    Menu,
    configStore,
    getWindows,
    actions: menuActions
  });
}

function openContextMenu() {
  const petWindow = getPetWindow();
  if (!petWindow) return;

  createNativeMenu().popup({ window: petWindow });
}

async function boot() {
  userDataDir = app.getPath("userData");
  configStore = createConfigStore(userDataDir);
  const { config: bootConfig, detection: languageDetection } = loadConfigWithFirstRunLanguage(configStore, app);
  const showOnboarding = shouldShowOnboarding(bootConfig);
  configureLogger({
    userDataDir,
    enabled: bootConfig.system?.logging?.enabled !== false,
    level: bootConfig.system?.logging?.level
  });
  logger.info("Application boot started", {
    onboardingVersion: getOnboardingVersion(bootConfig),
    showOnboarding
  });
  if (process.platform === "darwin") {
    const logMethod = macStatusBarMode.applied ? logger.info : logger.warn;
    logMethod("macOS status bar activation configured", macStatusBarMode);
  }
  if (languageDetection) {
    logger.info("Initialized first-run language from system preference", {
      detectedLocale: languageDetection.locale,
      language: languageDetection.language,
      source: languageDetection.source
    });
  }
  menuActions = createMenuActions({
    app,
    shell,
    configStore,
    getWindows,
    createPanelWindow,
    importPetpack: importPetpackFromDialog,
    userDataDir,
    refreshMenus
  });

  registerIpc({ getWindows, createPanelWindow, configStore, openContextMenu });
  await createPetWindow({ display: configStore.load().display });
  await createPanelWindow({ show: showOnboarding });
  globalMouseTracker = createGlobalMouseTracker({ getPetWindow });
  globalMouseTracker.start();
  trayController = createTray({
    createMenu: createNativeMenu
  });
  logger.info("Application boot completed");
}

app.whenReady().then(boot).catch((error) => {
  logger.error("Application boot failed", error);
});

app.on("activate", async () => {
  const { pet } = getWindows();

  if (!pet || pet.isDestroyed()) {
    logger.info("Recreating pet window after activate");
    await createPetWindow();
    refreshMenus();
  }
});

app.on("before-quit", () => {
  logger.info("Application is quitting");
  if (globalMouseTracker) {
    globalMouseTracker.stop();
  }
  if (trayController) {
    trayController.destroy();
  }
  shutdownLogger();
});
