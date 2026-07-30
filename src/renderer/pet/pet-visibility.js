export function applyPetHiddenState({
  root,
  hidden,
  display = {},
  setMousePassthrough,
  logger,
  actionType,
  eventType
} = {}) {
  const nextHidden = Boolean(hidden);
  const configuredMousePassthrough = Boolean(display && display.mousePassthrough);
  const nextMousePassthrough = nextHidden || configuredMousePassthrough;

  if (root && root.style) {
    root.style.visibility = nextHidden ? "hidden" : "visible";
  }

  if (typeof logger === "function") {
    logger("visibility:set", {
      actionType,
      eventType,
      hidden: nextHidden,
      configuredMousePassthrough,
      mousePassthrough: nextMousePassthrough
    });
  }

  if (typeof setMousePassthrough === "function") {
    setMousePassthrough(nextMousePassthrough);
  }

  return {
    hidden: nextHidden,
    mousePassthrough: nextMousePassthrough
  };
}

export function resolveMousePassthroughForPointer({
  dragActive,
  hidden,
  display = {},
  pointer,
  rect
} = {}) {
  if (dragActive) return false;
  if (hidden) return true;
  if (display && display.mousePassthrough) return true;
  if (!pointer || !rect) return true;

  return !isPointInsideRect(pointer, rect);
}

export function isPointInsideRect(point, rect) {
  return Boolean(point && rect) &&
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height;
}

export function shouldDispatchHiddenMouseLeave({
  hidden,
  leaveDispatched,
  pointer,
  bounds
} = {}) {
  return Boolean(hidden && !leaveDispatched && pointer && bounds && !isPointInsideRect(pointer, bounds));
}

export function shouldSkipRuntimeEventWhileHidden({ hidden, event } = {}) {
  return Boolean(hidden && event && event.type === "mouseMove" && event.eventSource === "globalMouse");
}
