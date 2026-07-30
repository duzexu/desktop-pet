import { describe, expect, it, vi } from "vitest";
import {
  createBoundsScheduler,
  createPetController,
  createPositionScheduler,
  resolveDisplayForPoint,
  resolveDragPlacement,
  resolveDragTopBoundary,
  stopPetEvent
} from "../../src/renderer/pet/pet-controller";

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createController(overrides = {}) {
  const calls = {
    returnToDefault: [],
    messages: [],
    scheduledIdle: 0,
    clearedIdle: 0,
    movedBounds: [],
    dragging: [],
    captured: [],
    released: [],
    visualOffsets: []
  };

  const controller = createPetController({
    returnToDefault: () => calls.returnToDefault.push("idle"),
    showMessage: (text) => calls.messages.push(text),
    scheduleIdle: () => {
      calls.scheduledIdle += 1;
    },
    clearIdle: () => {
      calls.clearedIdle += 1;
    },
    movePetWindow: (bounds) => calls.movedBounds.push(bounds),
    getWindowPosition: () => ({ x: 10, y: 20 }),
    getWindowSize: () => ({ width: 320, height: 320 }),
    setDraggingClass: (enabled) => calls.dragging.push(enabled),
    setDragVisualOffset: (offset) => calls.visualOffsets.push(offset),
    setPointerCapture: (pointerId) => calls.captured.push(pointerId),
    releasePointerCapture: (pointerId) => calls.released.push(pointerId),
    hasPointerCapture: () => true,
    ...overrides
  });

  return { controller, calls };
}

describe("createBoundsScheduler", () => {
  it("coalesces moves to the latest bounds and avoids concurrent setBounds calls", async () => {
    const frames = [];
    const firstMove = createDeferred();
    const setBounds = vi.fn(() => firstMove.promise);
    const scheduler = createBoundsScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      setBounds
    });

    scheduler.request({ x: 1, y: 1, width: 320, height: 320 });
    scheduler.request({ x: 2, y: 2, width: 320, height: 320 });
    frames.shift()();

    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(setBounds).toHaveBeenLastCalledWith({ x: 2, y: 2, width: 320, height: 320 });

    scheduler.request({ x: 3, y: 3, width: 320, height: 320 });
    scheduler.request({ x: 4, y: 4, width: 320, height: 320 });

    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);

    firstMove.resolve();
    await firstMove.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(frames).toHaveLength(1);
    frames.shift()();
    expect(setBounds).toHaveBeenCalledTimes(2);
    expect(setBounds).toHaveBeenLastCalledWith({ x: 4, y: 4, width: 320, height: 320 });
  });

  it("logs native bounds update timing and pending coalesced movement", async () => {
    const frames = [];
    const firstMove = createDeferred();
    const setBounds = vi.fn(() => firstMove.promise);
    let clock = 100;
    const logger = {
      debug: vi.fn(),
      warn: vi.fn()
    };
    const scheduler = createBoundsScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      setBounds,
      now: () => clock,
      logger,
      slowSetBoundsMs: 20
    });

    scheduler.request({ x: 10, y: 20, width: 320, height: 320 });
    frames.shift()();
    scheduler.request({ x: 30, y: 40, width: 320, height: 320 });

    clock = 135;
    firstMove.resolve();
    await firstMove.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.warn).toHaveBeenCalledWith("pet window setBounds completed slowly", {
      durationMs: 35,
      bounds: { x: 10, y: 20, width: 320, height: 320 },
      hasPendingBounds: true
    });
    expect(logger.debug).not.toHaveBeenCalledWith("pet window setBounds completed", expect.anything());
  });
});

describe("createPositionScheduler", () => {
  it("coalesces each frame without waiting for the previous position result", () => {
    const frames = [];
    const unresolved = createDeferred();
    const setPosition = vi.fn(() => unresolved.promise);
    const scheduler = createPositionScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      setPosition
    });

    scheduler.request({ x: 1, y: 1 });
    scheduler.request({ x: 2, y: 2 });
    frames.shift()();

    expect(setPosition).toHaveBeenCalledTimes(1);
    expect(setPosition).toHaveBeenLastCalledWith({ x: 2, y: 2 });

    scheduler.request({ x: 3, y: 3 });
    expect(frames).toHaveLength(1);
    frames.shift()();

    expect(setPosition).toHaveBeenCalledTimes(2);
    expect(setPosition).toHaveBeenLastCalledWith({ x: 3, y: 3 });
  });

  it("flushes the final drag position immediately", () => {
    const frames = [];
    const cancelFrame = vi.fn();
    const setPosition = vi.fn();
    const scheduler = createPositionScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return 42;
      },
      cancelFrame,
      setPosition
    });

    scheduler.request({ x: 80, y: 90 });
    scheduler.flushNow();

    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(setPosition).toHaveBeenCalledWith({ x: 80, y: 90 });
  });
});

describe("resolveDragPlacement", () => {
  it("clamps the native window and keeps top overflow as a deterministic visual offset", () => {
    expect(resolveDragPlacement({
      requestedBounds: { x: 10, y: -120, width: 320, height: 320 },
      topBoundary: 25
    })).toEqual({
      windowBounds: { x: 10, y: 25, width: 320, height: 320 },
      visualOffset: { x: 0, y: -145 }
    });
  });

  it("leaves bounds unchanged when the requested top is inside the display work area", () => {
    expect(resolveDragPlacement({
      requestedBounds: { x: 10, y: 80, width: 320, height: 320 },
      topBoundary: 25
    })).toEqual({
      windowBounds: { x: 10, y: 80, width: 320, height: 320 },
      visualOffset: { x: 0, y: 0 }
    });
  });

  it("falls back to the requested bounds when no valid display boundary is available", () => {
    const requestedBounds = { x: -160, y: -120, width: 320, height: 320 };
    expect(resolveDragPlacement({ requestedBounds, topBoundary: null })).toEqual({
      windowBounds: requestedBounds,
      visualOffset: { x: 0, y: 0 }
    });
  });
});

describe("multi-display drag targeting", () => {
  const displays = [
    {
      id: "main-landscape",
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 25, width: 2560, height: 1390 }
    },
    {
      id: "left-portrait",
      bounds: { x: -1440, y: -1120, width: 1440, height: 2560 },
      workArea: { x: -1440, y: -1120, width: 1440, height: 2560 }
    }
  ];

  it("uses the pointer display at a shared edge instead of the window-owned display", () => {
    expect(resolveDisplayForPoint(displays, { x: 0, y: 0 })?.id).toBe("main-landscape");
    expect(resolveDragTopBoundary({
      displays,
      pointer: { x: 0, y: 0 },
      fallback: -1120
    })).toBe(25);

    expect(resolveDragTopBoundary({
      displays,
      pointer: { x: -1, y: 0 },
      fallback: 25
    })).toBe(-1120);
  });

  it("uses the nearest display for points in a layout gap", () => {
    expect(resolveDisplayForPoint(displays, { x: 10, y: -10 })?.id).toBe("main-landscape");
  });

  it("falls back cleanly when display topology or pointer data is unavailable", () => {
    expect(resolveDisplayForPoint(displays, null)).toBeNull();
    expect(resolveDragTopBoundary({
      displays: [],
      pointer: { x: 10, y: 10 },
      fallback: 42
    })).toBe(42);
  });
});

describe("createPetController", () => {
 it("does not drag or suppress click below the movement threshold", () => {
   const onClick = vi.fn(() => false);
   const { controller, calls } = createController({ onClick });

   controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
   controller.continueDrag({ pointerId: 7, screenX: 102, screenY: 101 });
   controller.endDrag({ pointerId: 7 });
   controller.click();

   expect(calls.movedBounds).toEqual([]);
   // 点击交互完全交给规则；无硬编码问候/回默认。
   expect(onClick).toHaveBeenCalledTimes(1);
   expect(calls.returnToDefault).toEqual([]);
   expect(calls.messages).toEqual([]);
   expect(calls.scheduledIdle).toBe(0);
 });

 it("does not fire onDragStart when pointer is pressed without moving", () => {
   const dragStart = vi.fn(() => false);
   const dragging = vi.fn(() => false);
   const dragEnd = vi.fn(() => false);
   const { controller, calls } = createController({
     onDragStart: dragStart,
     onDragging: dragging,
     onDragEnd: dragEnd
   });

   controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });

   expect(dragStart).not.toHaveBeenCalled();
   expect(dragging).not.toHaveBeenCalled();
   expect(calls.returnToDefault).toEqual([]);

   controller.endDrag({ pointerId: 7 });
   expect(dragEnd).not.toHaveBeenCalled();
 });

  it("fires onDragStart only once when threshold is crossed", () => {
   const dragStart = vi.fn(() => false);
   const dragging = vi.fn(() => false);
   const { controller } = createController({
     onDragStart: dragStart,
     onDragging: dragging
   });

   controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
   controller.continueDrag({ pointerId: 7, screenX: 130, screenY: 100 });
   controller.continueDrag({ pointerId: 7, screenX: 140, screenY: 100 });

   expect(dragStart).toHaveBeenCalledTimes(1);
   expect(dragging).toHaveBeenCalledTimes(2);
 });

  it("reports the full pointer input session around a completed drag", () => {
    const onDragSessionStart = vi.fn();
    const onDragSessionEnd = vi.fn();
    const { controller } = createController({ onDragSessionStart, onDragSessionEnd });

    controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    controller.continueDrag({ pointerId: 7, screenX: 130, screenY: 125 });
    controller.endDrag({ pointerId: 7, screenX: 132, screenY: 126 });

    expect(onDragSessionStart).toHaveBeenCalledWith({
      reason: "pointer-down",
      pointerId: 7,
      screenX: 100,
      screenY: 100
    });
    expect(onDragSessionEnd).toHaveBeenCalledWith({
      reason: "pointer-up",
      pointerId: 7,
      screenX: 132,
      screenY: 126,
      didDrag: true
    });

    controller.lostPointerCapture({ pointerId: 7 });
    expect(onDragSessionEnd).toHaveBeenCalledTimes(1);
  });

  it("flushes pointer-up coordinates as the final drag target", () => {
    const { controller, calls } = createController();

    controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    controller.continueDrag({ pointerId: 7, screenX: 130, screenY: 125 });
    controller.endDrag({ pointerId: 7, screenX: 160, screenY: 150 });

    expect(calls.movedBounds.at(-1)).toEqual({
      x: 70,
      y: 70,
      width: 320,
      height: 320
    });
  });

  it("uses deterministic clamped bounds without reading native position during later drag frames", () => {
    const getWindowPosition = vi.fn()
      .mockReturnValueOnce({ x: 10, y: 20 })
      .mockReturnValueOnce({ x: 999, y: -999 });
    const getWindowSize = vi.fn()
      .mockReturnValueOnce({ width: 320, height: 320 })
      .mockReturnValue({ width: 999, height: 999 });
    const { controller, calls } = createController({
      getWindowPosition,
      getWindowSize,
      getDragTopBoundary: () => 25
    });

    controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    controller.continueDrag({ pointerId: 7, screenX: 130, screenY: -40 });
    controller.continueDrag({ pointerId: 7, screenX: 140, screenY: -30 });

    expect(getWindowPosition).toHaveBeenCalledTimes(2);
    expect(getWindowSize).toHaveBeenCalledTimes(1);
    expect(calls.movedBounds).toEqual([
      { x: 40, y: 25, width: 320, height: 320 },
      { x: 50, y: 25, width: 320, height: 320 }
    ]);
    expect(calls.visualOffsets).toEqual([
      { x: 0, y: -145 },
      { x: 0, y: -135 }
    ]);
  });

  it("suppresses the accidental click after a drag", () => {
    const { controller, calls } = createController();

    controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    controller.continueDrag({ pointerId: 7, screenX: 130, screenY: 100 });
    controller.endDrag({ pointerId: 7 });
    controller.click();

    // 拖拽结束不再强制回默认（交给动画系统内部/dragEnd 规则）。
    expect(calls.returnToDefault).toEqual([]);
    expect(calls.messages).toEqual([]);
    expect(calls.scheduledIdle).toBe(0);
    expect(calls.visualOffsets.at(-1)).toEqual({ x: 0, y: 0 });
  });

  it("only notifies drag cancel on lost pointer capture after an actual drag", () => {
    const noDrag = createController({ onDragCancel: vi.fn() });

    noDrag.controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    noDrag.controller.lostPointerCapture();

    // 未真正拖动：不回默认、不通知取消。
    expect(noDrag.calls.returnToDefault).toEqual([]);
    expect(noDrag.calls.dragging).toEqual([true, false]);

    const onDragCancel = vi.fn();
    const dragged = createController({ onDragCancel });

    dragged.controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    dragged.controller.continueDrag({ pointerId: 7, screenX: 130, screenY: 100 });
    dragged.controller.lostPointerCapture();

    // 真正拖动后取消：通知 onDragCancel，但不再强制回默认（交给动画系统/规则）。
    expect(dragged.calls.returnToDefault).toEqual([]);
    expect(onDragCancel).toHaveBeenCalledTimes(1);
    expect(dragged.calls.dragging).toEqual([true, false]);
    expect(dragged.calls.visualOffsets.at(-1)).toEqual({ x: 0, y: 0 });
  });

  it("notifies runtime cleanup when pointer capture is lost during an actual drag", () => {
    const onDragCancel = vi.fn();
    const onDragSessionEnd = vi.fn();
    const { controller } = createController({ onDragCancel, onDragSessionEnd });

    controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    controller.continueDrag({ pointerId: 7, screenX: 130, screenY: 125 });
    controller.lostPointerCapture();

    expect(onDragCancel).toHaveBeenCalledTimes(1);
    expect(onDragCancel).toHaveBeenCalledWith({
      pointerId: 7,
      screenX: 130,
      screenY: 125
    });
    expect(onDragSessionEnd).toHaveBeenCalledWith({
      reason: "pointer-capture-lost",
      pointerId: 7,
      screenX: 130,
      screenY: 125,
      didDrag: true
    });
  });

  it("does not notify runtime cleanup when pointer capture is lost before dragging starts", () => {
    const onDragCancel = vi.fn();
    const onDragSessionEnd = vi.fn();
    const { controller } = createController({ onDragCancel, onDragSessionEnd });

    controller.startDrag({ button: 0, pointerId: 7, screenX: 100, screenY: 100 });
    controller.lostPointerCapture();

    expect(onDragCancel).not.toHaveBeenCalled();
    expect(onDragSessionEnd).toHaveBeenCalledWith({
      reason: "pointer-capture-lost",
      pointerId: 7,
      screenX: 100,
      screenY: 100,
      didDrag: false
    });
  });
});

describe("stopPetEvent", () => {
  it("stops propagation for settings button events", () => {
    const event = {
      stopPropagation: vi.fn()
    };

    stopPetEvent(event);

    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});
