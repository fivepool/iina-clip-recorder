(function () {
  "use strict";

  var DEFAULTS = {
    shortcut: "Meta+r",
    mp4Enabled: true,
    mp4WithoutAudio: false,
    gifEnabled: false,
    mp4Resolution: "1080p",
    gifResolution: "720p",
    gifFps: "12",
    outputDirectory: "~/Movies/IINA Clips",
    ffmpegPath: "",
  };
  var STATUS_POLL_INTERVAL_MS = 1000;
  var statusTimer = null;
  var preferenceUtils = window.IINAClipRecorderPreferenceUtils;

  var modifierAliases = {
    alt: "Alt",
    option: "Alt",
    "⌥": "Alt",
    ctrl: "Ctrl",
    control: "Ctrl",
    "⌃": "Ctrl",
    shift: "Shift",
    "⇧": "Shift",
    meta: "Meta",
    cmd: "Meta",
    command: "Meta",
    "⌘": "Meta",
  };
  var modifierOrder = ["Ctrl", "Alt", "Shift", "Meta"];
  var namedKeys = {
    backspace: "BS",
    bs: "BS",
    delete: "DEL",
    del: "DEL",
    down: "DOWN",
    end: "END",
    enter: "ENTER",
    escape: "ESC",
    esc: "ESC",
    home: "HOME",
    left: "LEFT",
    pagedown: "PGDWN",
    pgdown: "PGDWN",
    pgdwn: "PGDWN",
    pageup: "PGUP",
    pgup: "PGUP",
    return: "ENTER",
    right: "RIGHT",
    space: "SPACE",
    tab: "TAB",
    up: "UP",
  };

  function bridgeReady() {
    return Boolean(
      window.iina &&
        window.iina.preferences &&
        typeof window.iina.preferences.get === "function" &&
        typeof window.iina.preferences.set === "function",
    );
  }

  function log(message) {
    try {
      if (window.iina && typeof window.iina.log === "function") {
        window.iina.log("[Clip Recorder Preferences] " + message);
      }
    } catch (_error) {
      // Preferences must remain usable even when host-side logging is closed.
    }
  }

  function getPreference(name, callback) {
    try {
      window.iina.preferences.get(name, callback);
    } catch (error) {
      log("Could not read " + name + ": " + String(error));
    }
  }

  function setPreference(name, value) {
    try {
      window.iina.preferences.set(name, value);
      log("Saved " + name);
      return true;
    } catch (error) {
      log("Could not save " + name + ": " + String(error));
      return false;
    }
  }

  function compactShortcutText(rawValue) {
    var value = String(rawValue || "").trim();
    var hadSymbol = /[⌘⌥⌃⇧]/.test(value);

    value = value
      .replace(/⌘/g, "+Meta+")
      .replace(/⌥/g, "+Alt+")
      .replace(/⌃/g, "+Ctrl+")
      .replace(/⇧/g, "+Shift+");

    if (value.indexOf("+") === -1 && !hadSymbol) {
      value = value.replace(/\s+/g, "+");
    } else {
      value = value.replace(/\s+/g, "");
    }
    return value;
  }

  function normalizeMainKey(token) {
    var value = String(token || "").trim();
    var lower = value.toLowerCase();
    var functionKey = /^f([1-9]|1[0-9]|20)$/i.exec(value);

    if (/^[a-z0-9]$/i.test(value)) {
      return { ok: true, value: value.toLowerCase() };
    }
    if (functionKey) {
      return { ok: true, value: "F" + functionKey[1] };
    }
    if (Object.prototype.hasOwnProperty.call(namedKeys, lower)) {
      return { ok: true, value: namedKeys[lower] };
    }
    return {
      ok: false,
      message: "Use one letter, number, F1–F20, or a named key such as Space.",
    };
  }

  function normalizeShortcut(rawValue) {
    var original = String(rawValue || "").trim();
    var compact;
    var rawParts;
    var parts = [];
    var seenModifiers = {};
    var modifiers = [];
    var index;
    var keyResult;

    if (!original) {
      return { ok: false, message: "Enter a shortcut." };
    }
    if (original.length > 80) {
      return { ok: false, message: "The shortcut is too long." };
    }
    if (
      /^\+/.test(original) ||
      /\+$/.test(original) ||
      /\+\s*\+/.test(original)
    ) {
      return {
        ok: false,
        message: "Use + only between modifiers and the key.",
      };
    }
    compact = compactShortcutText(original);

    rawParts = compact.split("+");
    for (index = 0; index < rawParts.length; index += 1) {
      if (rawParts[index]) {
        parts.push(rawParts[index]);
      }
    }
    if (parts.length < 2) {
      return {
        ok: false,
        message: "Add at least one modifier, for example Cmd+R.",
      };
    }

    for (index = 0; index < parts.length - 1; index += 1) {
      var alias = modifierAliases[parts[index].toLowerCase()] || modifierAliases[parts[index]];
      if (!alias) {
        return {
          ok: false,
          message: "Unknown modifier “" + parts[index] + "”. Use Cmd, Ctrl, Alt, or Shift.",
        };
      }
      if (seenModifiers[alias]) {
        return { ok: false, message: alias + " is included more than once." };
      }
      seenModifiers[alias] = true;
    }

    for (index = 0; index < modifierOrder.length; index += 1) {
      if (seenModifiers[modifierOrder[index]]) {
        modifiers.push(modifierOrder[index]);
      }
    }
    if (!seenModifiers.Meta && !seenModifiers.Ctrl && !seenModifiers.Alt) {
      return {
        ok: false,
        message: "The shortcut must include Cmd, Ctrl, or Alt.",
      };
    }

    if (
      modifierAliases[parts[parts.length - 1].toLowerCase()] ||
      modifierAliases[parts[parts.length - 1]]
    ) {
      return { ok: false, message: "Add a non-modifier key after the modifiers." };
    }
    keyResult = normalizeMainKey(parts[parts.length - 1]);
    if (!keyResult.ok) {
      return keyResult;
    }

    return { ok: true, value: modifiers.concat([keyResult.value]).join("+") };
  }

  function validatePath(rawValue, allowEmpty) {
    var value = String(rawValue || "").trim();
    if (allowEmpty && value === "") {
      return { ok: true, value: "" };
    }
    if (value.indexOf("\u0000") !== -1 || /[\r\n]/.test(value)) {
      return { ok: false, message: "The path contains an unsupported character." };
    }
    if (value !== "~" && value.indexOf("~/") !== 0 && value.indexOf("/") !== 0) {
      return {
        ok: false,
        message: "Use a path beginning with ~/ or an absolute path beginning with /.",
      };
    }
    return { ok: true, value: value };
  }

  function showValidation(input, messageElement, result, saved) {
    messageElement.classList.remove("is-success");
    if (!result.ok) {
      input.setAttribute("aria-invalid", "true");
      messageElement.textContent = result.message;
      return;
    }

    input.removeAttribute("aria-invalid");
    if (saved) {
      messageElement.classList.add("is-success");
      messageElement.textContent = "Saved.";
    } else if (String(input.value).trim() !== result.value) {
      messageElement.classList.add("is-success");
      messageElement.textContent = "Will be saved as " + result.value + ".";
    } else {
      messageElement.textContent = "";
    }
  }

  function bindValidatedText(options) {
    var input = document.getElementById(options.inputId);
    var message = document.getElementById(options.messageId);
    var lastSavedValue = null;

    getPreference(options.preference, function (storedValue) {
      var initialValue =
        typeof storedValue === "string" ? storedValue : options.defaultValue;
      input.value = initialValue;
      showValidation(input, message, options.validate(initialValue), false);
    });

    input.addEventListener("input", function () {
      showValidation(input, message, options.validate(input.value), false);
    });

    function commit() {
      var result = options.validate(input.value);
      if (!result.ok) {
        showValidation(input, message, result, false);
        return;
      }
      input.value = result.value;
      if (lastSavedValue !== result.value) {
        if (!setPreference(options.preference, result.value)) {
          input.setAttribute("aria-invalid", "true");
          message.classList.remove("is-success");
          message.textContent = "IINA could not save this value.";
          return;
        }
        lastSavedValue = result.value;
      }
      showValidation(input, message, result, true);
    }

    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
  }

  function checkedRadioValue(name) {
    var checked = document.querySelector('input[name="' + name + '"]:checked');
    return checked ? checked.value : null;
  }

  function selectRadioValue(name, value, fallback) {
    var selector = 'input[name="' + name + '"][value="' + value + '"]';
    var input = document.querySelector(selector);
    if (!input) {
      input = document.querySelector(
        'input[name="' + name + '"][value="' + fallback + '"]',
      );
    }
    if (input) {
      input.checked = true;
    }
  }

  function bindRadioGroup(name, preference, allowedValues, fallback) {
    var inputs = document.querySelectorAll('input[name="' + name + '"]');
    getPreference(preference, function (storedValue) {
      var value = allowedValues.indexOf(storedValue) >= 0 ? storedValue : fallback;
      selectRadioValue(name, value, fallback);
    });
    Array.prototype.forEach.call(inputs, function (input) {
      if (input.disabled) {
        return;
      }
      input.addEventListener("change", function () {
        var value = checkedRadioValue(name);
        if (allowedValues.indexOf(value) >= 0) {
          setPreference(preference, value);
        }
      });
    });
  }

  function bindFormatCheckboxes() {
    var mp4 = document.getElementById("mp4-enabled");
    var gif = document.getElementById("gif-enabled");
    var message = document.getElementById("formats-validation");
    var loaded = 0;
    var values = {
      mp4Enabled: DEFAULTS.mp4Enabled,
      gifEnabled: DEFAULTS.gifEnabled,
    };

    function showFormatValidation(text, success) {
      message.classList.toggle("is-success", Boolean(success));
      message.textContent = text;
    }

    function clearInvalidState() {
      mp4.removeAttribute("aria-invalid");
      gif.removeAttribute("aria-invalid");
    }

    function persistCurrentFormats() {
      var mp4Saved = setPreference("mp4Enabled", Boolean(mp4.checked));
      var gifSaved = setPreference("gifEnabled", Boolean(gif.checked));
      return mp4Saved && gifSaved;
    }

    function saveChange(input) {
      var previousValue = !input.checked;

      if (!mp4.checked && !gif.checked) {
        input.checked = true;
        input.setAttribute("aria-invalid", "true");
        persistCurrentFormats();
        showFormatValidation(
          "At least one output format must remain enabled.",
          false,
        );
        return;
      }

      clearInvalidState();
      if (!persistCurrentFormats()) {
        input.checked = previousValue;
        input.setAttribute("aria-invalid", "true");
        showFormatValidation("IINA could not save this format setting.", false);
        return;
      }
      showFormatValidation("Saved.", true);
    }

    function finishLoading() {
      if (loaded !== 2) {
        return;
      }

      if (!values.mp4Enabled && !values.gifEnabled) {
        values.mp4Enabled = true;
        mp4.checked = true;
        gif.checked = false;
        if (persistCurrentFormats()) {
          showFormatValidation(
            "MP4 was restored because at least one format must remain enabled.",
            false,
          );
        } else {
          showFormatValidation(
            "IINA could not repair the invalid output format settings.",
            false,
          );
        }
      }

      mp4.checked = values.mp4Enabled;
      gif.checked = values.gifEnabled;
      mp4.addEventListener("change", function () {
        saveChange(mp4);
      });
      gif.addEventListener("change", function () {
        saveChange(gif);
      });
    }

    getPreference("mp4Enabled", function (value) {
      values.mp4Enabled = preferenceUtils.coerceBooleanPreference(
        value,
        DEFAULTS.mp4Enabled,
      );
      loaded += 1;
      finishLoading();
    });
    getPreference("gifEnabled", function (value) {
      values.gifEnabled = preferenceUtils.coerceBooleanPreference(
        value,
        DEFAULTS.gifEnabled,
      );
      loaded += 1;
      finishLoading();
    });
  }

  function bindBooleanCheckbox(inputId, preference, defaultValue) {
    var input = document.getElementById(inputId);
    if (!input) {
      return;
    }
    getPreference(preference, function (value) {
      input.checked = preferenceUtils.coerceBooleanPreference(
        value,
        defaultValue,
      );
    });
    input.addEventListener("change", function () {
      if (!setPreference(preference, Boolean(input.checked))) {
        input.checked = !input.checked;
      }
    });
  }

  function statusDescription(rawValue) {
    var text = "Waiting for a player window…";
    var level = "pending";

    if (typeof rawValue === "string" && rawValue.trim()) {
      text = rawValue.trim();
    } else if (rawValue && typeof rawValue === "object") {
      if (typeof rawValue.message === "string" && rawValue.message.trim()) {
        text = rawValue.message.trim();
      } else if (typeof rawValue.status === "string" && rawValue.status.trim()) {
        text = rawValue.status.trim();
      } else if (typeof rawValue.state === "string" && rawValue.state.trim()) {
        text = rawValue.state.trim();
      }
      if (typeof rawValue.level === "string") {
        level = rawValue.level.toLowerCase();
      } else if (typeof rawValue.state === "string") {
        level = rawValue.state.toLowerCase();
      }
    }

    var lower = text.toLowerCase();
    if (
      level === "error" ||
      level === "conflict" ||
      lower.indexOf("error") >= 0 ||
      lower.indexOf("conflict") >= 0 ||
      lower.indexOf("invalid") >= 0 ||
      lower.indexOf("not applied") >= 0
    ) {
      level = "error";
    } else if (
      level === "ok" ||
      level === "active" ||
      lower.indexOf("active") >= 0 ||
      lower.indexOf("ready") >= 0
    ) {
      level = "ok";
    } else {
      level = "pending";
    }
    return { text: text, level: level };
  }

  function pollShortcutStatus() {
    var element = document.getElementById("shortcut-status");
    getPreference("shortcutStatus", function (rawValue) {
      var status = statusDescription(rawValue);
      element.textContent = status.text;
      element.className = "status-value status-" + status.level;
    });
  }

  function initialize() {
    var bridgeError = document.getElementById("bridge-error");
    if (!bridgeReady()) {
      bridgeError.hidden = false;
      return;
    }

    log("Preferences page opened");
    bindFormatCheckboxes();
    bindBooleanCheckbox(
      "mp4-without-audio",
      "mp4WithoutAudio",
      DEFAULTS.mp4WithoutAudio,
    );
    bindValidatedText({
      inputId: "shortcut",
      messageId: "shortcut-validation",
      preference: "shortcut",
      defaultValue: DEFAULTS.shortcut,
      validate: normalizeShortcut,
    });
    bindValidatedText({
      inputId: "output-directory",
      messageId: "output-directory-validation",
      preference: "outputDirectory",
      defaultValue: DEFAULTS.outputDirectory,
      validate: function (value) {
        return validatePath(value, false);
      },
    });
    bindValidatedText({
      inputId: "ffmpeg-path",
      messageId: "ffmpeg-path-validation",
      preference: "ffmpegPath",
      defaultValue: DEFAULTS.ffmpegPath,
      validate: function (value) {
        return validatePath(value, true);
      },
    });

    bindRadioGroup(
      "mp4-resolution",
      "mp4Resolution",
      ["1080p", "full"],
      DEFAULTS.mp4Resolution,
    );
    bindRadioGroup(
      "gif-resolution",
      "gifResolution",
      ["720p", "full"],
      DEFAULTS.gifResolution,
    );
    bindRadioGroup(
      "gif-fps",
      "gifFps",
      ["12", "source"],
      DEFAULTS.gifFps,
    );

    pollShortcutStatus();
    statusTimer = window.setInterval(pollShortcutStatus, STATUS_POLL_INTERVAL_MS);
    window.addEventListener("pagehide", function () {
      if (statusTimer !== null) {
        window.clearInterval(statusTimer);
        statusTimer = null;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
