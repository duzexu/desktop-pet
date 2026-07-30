import { createRequire } from "node:module";
import Module from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
const exposeInMainWorld = vi.fn();
const ipcRenderer = {
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
};

describe("pet preload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Module._load = function mockElectron(request, parent, isMain) {
      if (request === "electron") {
        return {
          contextBridge: { exposeInMainWorld },
          ipcRenderer
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const preloadPath = require.resolve("../../src/preload/pet-preload");
    delete require.cache[preloadPath];
    require(preloadPath);
  });

  afterEach(() => {
    Module._load = originalLoad;
  });

  it("sends drag positions over the one-way high-frequency channel", () => {
    const api = exposeInMainWorld.mock.calls[0][1];

    expect(api.pet.setPosition({ x: 120, y: 240 })).toBeUndefined();
    expect(ipcRenderer.send).toHaveBeenCalledWith("pet:set-position", { x: 120, y: 240 });
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith("pet:set-position", expect.anything());
  });
});
