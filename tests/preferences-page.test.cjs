const assert = require("node:assert/strict");
const test = require("node:test");

const {
  coerceBooleanPreference,
  normalizeFormatPreferences,
} = require("../preferences/preferences-core.js");

const defaults = { mp4Enabled: true, gifEnabled: false };

test("coerces IINA 1.4.4 WebView boolean scalars without truthiness bugs", () => {
  assert.equal(coerceBooleanPreference(true, false), true);
  assert.equal(coerceBooleanPreference(false, true), false);
  assert.equal(coerceBooleanPreference(1, false), true);
  assert.equal(coerceBooleanPreference(0, true), false);
  assert.equal(coerceBooleanPreference("1", false), true);
  assert.equal(coerceBooleanPreference("0", true), false);
  assert.equal(coerceBooleanPreference("true", false), true);
  assert.equal(coerceBooleanPreference("false", true), false);
  assert.equal(coerceBooleanPreference("unexpected", true), true);
});

test("restores the actual GIF-only state returned by the IINA WebView bridge", () => {
  assert.deepEqual(normalizeFormatPreferences(0, 1, defaults), {
    mp4Enabled: false,
    gifEnabled: true,
  });
  assert.deepEqual(normalizeFormatPreferences(1, 0, defaults), {
    mp4Enabled: true,
    gifEnabled: false,
  });
  assert.deepEqual(normalizeFormatPreferences(1, 1, defaults), {
    mp4Enabled: true,
    gifEnabled: true,
  });
});
