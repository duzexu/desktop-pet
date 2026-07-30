import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { configureMacStatusBarMode } = require("../../src/main/macos-status-bar");

describe("configureMacStatusBarMode", () => {
  it("sets the accessory activation policy on macOS", () => {
    const app = {
      setActivationPolicy: vi.fn(),
      dock: { hide: vi.fn() }
    };

    const result = configureMacStatusBarMode({ app, platform: "darwin" });

    expect(result).toEqual({
      applied: true,
      method: "activation-policy"
    });
    expect(app.setActivationPolicy).toHaveBeenCalledWith("accessory");
    expect(app.dock.hide).not.toHaveBeenCalled();
  });

  it("falls back to hiding the Dock icon when activation policy fails", () => {
    const app = {
      setActivationPolicy: vi.fn(() => {
        throw new Error("policy unavailable");
      }),
      dock: { hide: vi.fn() }
    };

    const result = configureMacStatusBarMode({ app, platform: "darwin" });

    expect(result).toEqual({
      applied: true,
      method: "dock-hide",
      errors: [{
        method: "activation-policy",
        error: "policy unavailable"
      }]
    });
    expect(app.dock.hide).toHaveBeenCalledOnce();
  });

  it("does nothing on non-macOS platforms", () => {
    const app = {
      setActivationPolicy: vi.fn(),
      dock: { hide: vi.fn() }
    };

    const result = configureMacStatusBarMode({ app, platform: "win32" });

    expect(result).toEqual({
      applied: false,
      method: "not-applicable"
    });
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
    expect(app.dock.hide).not.toHaveBeenCalled();
  });
});
