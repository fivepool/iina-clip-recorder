(function (root, factory) {
  "use strict";

  var api = factory();
  root.IINAClipRecorderPreferenceUtils = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function coerceBooleanPreference(value, fallback) {
    if (typeof value === "boolean") {
      return value;
    }
    if (value === 1 || value === "1") {
      return true;
    }
    if (value === 0 || value === "0") {
      return false;
    }
    if (typeof value === "string") {
      var normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
    return fallback;
  }

  function normalizeFormatPreferences(mp4Value, gifValue, defaults) {
    return {
      mp4Enabled: coerceBooleanPreference(
        mp4Value,
        defaults.mp4Enabled,
      ),
      gifEnabled: coerceBooleanPreference(
        gifValue,
        defaults.gifEnabled,
      ),
    };
  }

  return {
    coerceBooleanPreference: coerceBooleanPreference,
    normalizeFormatPreferences: normalizeFormatPreferences,
  };
});
