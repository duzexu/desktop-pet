import { describe, expect, it, vi } from "vitest";
import {
  applyPetHiddenState,
  resolveMousePassthroughForPointer,
  shouldDispatchHiddenMouseLeave,
  shouldSkipRuntimeEventWhileHidden
} from "../../src/renderer/pet/pet-visibility.js";

describe("pet visibility state", () => {
  it("hides the root and enables mouse passthrough", () => {
    const root = { style: { visibility: "visible" } };
    const setMousePassthrough = vi.fn();
    const logger = vi.fn();

    const result = applyPetHiddenState({
      root,
      hidden: true,
      display: { mousePassthrough: false },
      setMousePassthrough,
      logger,
      actionType: "hidePet",
      eventType: "mouseEnter"
    });

    expect(root.style.visibility).toBe("hidden");
    expect(setMousePassthrough).toHaveBeenCalledWith(true);
    expect(result).toEqual({ hidden: true, mousePassthrough: true });
    expect(logger).toHaveBeenCalledWith("visibility:set", expect.objectContaining({
      actionType: "hidePet",
      eventType: "mouseEnter",
      hidden: true,
      configuredMousePassthrough: false,
      mousePassthrough: true
    }));
  });

  it("shows the root and restores non-passthrough when display allows mouse events", () => {
    const root = { style: { visibility: "hidden" } };
    const setMousePassthrough = vi.fn();

    const result = applyPetHiddenState({
      root,
      hidden: false,
      display: { mousePassthrough: false },
      setMousePassthrough
    });

    expect(root.style.visibility).toBe("visible");
    expect(setMousePassthrough).toHaveBeenCalledWith(false);
    expect(result).toEqual({ hidden: false, mousePassthrough: false });
  });

  it("shows the root while preserving configured mouse passthrough", () => {
    const root = { style: { visibility: "hidden" } };
    const setMousePassthrough = vi.fn();

    const result = applyPetHiddenState({
      root,
      hidden: false,
      display: { mousePassthrough: true },
      setMousePassthrough
    });

    expect(root.style.visibility).toBe("visible");
    expect(setMousePassthrough).toHaveBeenCalledWith(true);
    expect(result).toEqual({ hidden: false, mousePassthrough: true });
  });

  it("keeps mouse passthrough enabled while the pet is hidden", () => {
    const result = resolveMousePassthroughForPointer({
      hidden: true,
      display: { mousePassthrough: false },
      pointer: { x: 10, y: 10 },
      rect: { x: 0, y: 0, width: 20, height: 20 }
    });

    expect(result).toBe(true);
  });

  it("disables mouse passthrough only when visible pointer is inside media bounds", () => {
    expect(resolveMousePassthroughForPointer({
      hidden: false,
      display: { mousePassthrough: false },
      pointer: { x: 10, y: 10 },
      rect: { x: 0, y: 0, width: 20, height: 20 }
    })).toBe(false);

    expect(resolveMousePassthroughForPointer({
      hidden: false,
      display: { mousePassthrough: false },
      pointer: { x: 30, y: 30 },
      rect: { x: 0, y: 0, width: 20, height: 20 }
    })).toBe(true);
  });

  it("keeps mouse passthrough disabled for the entire active drag session", () => {
    expect(resolveMousePassthroughForPointer({
      dragActive: true,
      hidden: false,
      display: { mousePassthrough: false },
      pointer: { x: 300, y: 300 },
      rect: { x: 0, y: 0, width: 20, height: 20 }
    })).toBe(false);

    expect(resolveMousePassthroughForPointer({
      dragActive: true,
      hidden: true,
      display: { mousePassthrough: true }
    })).toBe(false);
  });

  it("dispatches hidden mouse leave only after the pointer physically exits hidden bounds", () => {
    const bounds = { x: 0, y: 0, width: 20, height: 20 };

    expect(shouldDispatchHiddenMouseLeave({
      hidden: true,
      leaveDispatched: false,
      pointer: { x: 10, y: 10 },
      bounds
    })).toBe(false);

    expect(shouldDispatchHiddenMouseLeave({
      hidden: true,
      leaveDispatched: false,
      pointer: { x: 30, y: 30 },
      bounds
    })).toBe(true);

    expect(shouldDispatchHiddenMouseLeave({
      hidden: true,
      leaveDispatched: true,
      pointer: { x: 30, y: 30 },
      bounds
    })).toBe(false);
  });

  it("skips normal runtime evaluation for global mouse moves while hidden", () => {
    expect(shouldSkipRuntimeEventWhileHidden({
      hidden: true,
      event: { type: "mouseMove", eventSource: "globalMouse" }
    })).toBe(true);

    expect(shouldSkipRuntimeEventWhileHidden({
      hidden: false,
      event: { type: "mouseMove", eventSource: "globalMouse" }
    })).toBe(false);

    expect(shouldSkipRuntimeEventWhileHidden({
      hidden: true,
      event: { type: "mouseLeave", eventSource: "globalMouse" }
    })).toBe(false);
  });
});
