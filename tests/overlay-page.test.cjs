const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("saved overlay sends a JSON-safe reveal message", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "overlay", "clip-saved.html"),
    "utf8",
  );
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "overlay script is present");

  const listeners = new Map();
  const elements = new Map(
    ["title", "detail", "reveal"].map((id) => [
      id,
      {
        textContent: "",
        addEventListener(name, callback) {
          listeners.set(`${id}:${name}`, callback);
        },
      },
    ]),
  );
  const messages = [];
  const incomingHandlers = new Map();

  vm.runInNewContext(script, {
    document: {
      getElementById(id) {
        return elements.get(id);
      },
    },
    iina: {
      onMessage(name, callback) {
        incomingHandlers.set(name, callback);
      },
      postMessage(name, data) {
        messages.push([name, data, arguments.length]);
      },
    },
  });

  assert.deepEqual(messages, []);
  assert.equal(typeof incomingHandlers.get("clip-recorder-show-saved"), "function");

  const click = listeners.get("reveal:click");
  assert.equal(typeof click, "function");
  click();
  assert.deepEqual(messages[0], ["clip-recorder-reveal", null, 2]);
});

test("overlay cards use a restrained glass treatment", () => {
  for (const file of ["clip-saved.html", "export-warning.html"]) {
    const html = fs.readFileSync(
      path.join(__dirname, "..", "overlay", file),
      "utf8",
    );
    assert.match(html, /backdrop-filter:\s*blur\(22px\)\s+saturate\(135%\)/);
    assert.match(html, /border:\s*1px solid rgba\(255,\s*255,\s*255,\s*0\.14\)/);
    assert.match(html, /linear-gradient\(145deg/);
    assert.doesNotMatch(
      html,
      /background:\s*rgba\(30,\s*31,\s*29,\s*0\.9[45]\)/,
    );
  }
});

function loadExportWarningPage() {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "overlay", "export-warning.html"),
    "utf8",
  );
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "export warning script is present");
  assert.match(
    html,
    /id="confirm"[^>]*data-clickable|data-clickable[^>]*id="confirm"/,
  );
  assert.match(
    html,
    /id="cancel"[^>]*data-clickable|data-clickable[^>]*id="cancel"/,
  );

  const listeners = new Map();
  const elements = new Map(
    [
      "title",
      "duration",
      "estimates",
      "disk",
      "warning",
      "confirm",
      "cancel",
    ].map((id) => [
      id,
      {
        textContent: "",
        disabled: false,
        addEventListener(name, callback) {
          listeners.set(`${id}:${name}`, callback);
        },
      },
    ]),
  );
  const messages = [];
  const incomingHandlers = new Map();
  vm.runInNewContext(script, {
    document: {
      getElementById(id) {
        return elements.get(id);
      },
    },
    iina: {
      onMessage(name, callback) {
        incomingHandlers.set(name, callback);
      },
      postMessage(name, data) {
        messages.push([name, data, arguments.length]);
      },
    },
  });
  return { elements, incomingHandlers, listeners, messages };
}

test("export warning renders with textContent and confirms only once", () => {
  const page = loadExportWarningPage();
  const show = page.incomingHandlers.get(
    "clip-recorder-show-export-warning",
  );
  assert.equal(typeof show, "function");
  show({
    title: "<Review export>",
    duration: "Selected range: 5 min",
    estimates: "GIF: about 480 MB",
    disk: "Free space: 10 GB",
    warning: "This export may take a while.",
    confirmLabel: "Export",
    cancelLabel: "Cancel",
  });
  assert.equal(page.elements.get("title").textContent, "<Review export>");
  assert.equal(page.elements.get("estimates").textContent, "GIF: about 480 MB");
  assert.equal(
    page.elements.get("warning").textContent,
    "This export may take a while.",
  );

  const confirm = page.listeners.get("confirm:click");
  assert.equal(typeof confirm, "function");
  confirm();
  confirm();
  page.listeners.get("cancel:click")();
  assert.deepEqual(page.messages, [
    ["clip-recorder-confirm-export", null, 2],
  ]);
  assert.equal(page.elements.get("confirm").disabled, true);
  assert.equal(page.elements.get("cancel").disabled, true);
});

test("export warning cancel sends an explicit JSON payload", () => {
  const page = loadExportWarningPage();
  page.listeners.get("cancel:click")();
  assert.deepEqual(page.messages, [
    ["clip-recorder-cancel-export", null, 2],
  ]);
});
