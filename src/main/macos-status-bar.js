function getErrorMessage(error) {
  if (error && typeof error.message === "string") {
    return error.message;
  }

  return String(error);
}

function configureMacStatusBarMode({ app, platform = process.platform }) {
  if (platform !== "darwin") {
    return {
      applied: false,
      method: "not-applicable"
    };
  }

  const errors = [];

  if (app && typeof app.setActivationPolicy === "function") {
    try {
      app.setActivationPolicy("accessory");
      return {
        applied: true,
        method: "activation-policy"
      };
    } catch (error) {
      errors.push({
        method: "activation-policy",
        error: getErrorMessage(error)
      });
    }
  }

  if (app && app.dock && typeof app.dock.hide === "function") {
    try {
      app.dock.hide();
      return {
        applied: true,
        method: "dock-hide",
        errors
      };
    } catch (error) {
      errors.push({
        method: "dock-hide",
        error: getErrorMessage(error)
      });
    }
  }

  return {
    applied: false,
    method: "unavailable",
    errors
  };
}

module.exports = {
  configureMacStatusBarMode
};
