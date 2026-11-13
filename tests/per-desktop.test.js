// SPDX-License-Identifier: GPL-2.0-or-later
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../contents/code/main.js"), "utf8");

function start(workspace, messages, overrides = {}) {
  const settings = {
    slot1Matcher: "class:org.kde.konsole",
    hideMode: 1,
    placeWindows: false,
    ...overrides,
  };
  const context = vm.createContext({
    workspace,
    readConfig: (key, fallback) => (settings[key] === undefined ? fallback : settings[key]),
    registerShortcut: () => {},
    callDBus: (service, object, iface, method, icon, text) => messages.push(text),
    print: () => {},
  });
  vm.runInContext(source, context);
  context.settings = settings;
  return context;
}

function window(id, desktop) {
  return {
    internalId: id,
    normalWindow: true,
    deleted: false,
    resourceClass: "org.kde.konsole",
    desktops: [desktop],
    minimized: false,
    skipTaskbar: false,
    skipPager: false,
  };
}

test("parked slots remain tied to their original desktops, even after a script reload", () => {
  const desktops = [1, 2, 3, 4].map((id) => ({ id: String(id) }));
  const [first, second, , parking] = desktops;
  const w1 = window("one", first);
  const w2 = window("two", second);
  const w4 = window("four", parking);
  const messages = [];
  const workspace = {
    desktops,
    currentDesktop: first,
    stackingOrder: [w1, w2, w4],
    windowRemoved: { connect: () => {} },
  };
  let script = start(workspace, messages, { slot1PerDesktop: true });

  script.toggleSlot(1);
  assert.equal(w1.minimized, true);
  assert.deepEqual(
    Array.from(w1.desktops, (d) => d.id),
    ["1", "4"],
  );

  workspace.currentDesktop = second;
  script.toggleSlot(1);
  assert.equal(w2.minimized, true);
  assert.deepEqual(
    Array.from(w2.desktops, (d) => d.id),
    ["2", "4"],
  );

  workspace.currentDesktop = parking;
  script.toggleSlot(1);
  assert.equal(w4.minimized, true);
  assert.deepEqual(
    Array.from(w4.desktops, (d) => d.id),
    ["4"],
  );

  // The JavaScript binding map disappears on a KWin script reload, but the
  // desktop membership of each parked window survives.
  script = start(workspace, messages, { slot1PerDesktop: true });
  workspace.currentDesktop = first;
  script.toggleSlot(1);
  assert.equal(w1.minimized, false);
  assert.deepEqual(
    Array.from(w1.desktops, (d) => d.id),
    ["1"],
  );
  assert.equal(w2.minimized, true);

  workspace.currentDesktop = second;
  script.toggleSlot(1);
  assert.equal(w2.minimized, false);
  assert.deepEqual(
    Array.from(w2.desktops, (d) => d.id),
    ["2"],
  );

  workspace.currentDesktop = desktops[2];
  script.toggleSlot(1);
  assert.equal(messages.at(-1), "Special Workspace 1: no matching window");

  workspace.currentDesktop = parking;
  script.toggleSlot(1);
  assert.equal(w4.minimized, false);
  assert.deepEqual(
    Array.from(w4.desktops, (d) => d.id),
    ["4"],
  );
});

test("unchecked slot keeps the original global binding and exclusive parking", () => {
  const [first, second, parking] = [1, 2, 3].map((id) => ({ id: String(id) }));
  const w = window("one", first);
  const workspace = {
    desktops: [first, second, parking],
    currentDesktop: second,
    stackingOrder: [w],
    windowRemoved: { connect: () => {} },
  };
  const script = start(workspace, []);

  script.toggleSlot(1); // Find on another desktop and bring it here, as before.
  assert.equal(w.minimized, false);
  assert.deepEqual(
    Array.from(w.desktops, (d) => d.id),
    ["2"],
  );
  assert.equal(script.bound["1"], "one");

  script.toggleSlot(1);
  assert.equal(w.minimized, true);
  assert.deepEqual(
    Array.from(w.desktops, (d) => d.id),
    ["3"],
  );

  workspace.currentDesktop = first;
  script.toggleSlot(1); // The global binding still follows us.
  assert.equal(w.minimized, false);
  assert.deepEqual(
    Array.from(w.desktops, (d) => d.id),
    ["1"],
  );
});

test("ordinary and per-desktop slots can coexist; restore-all keeps context windows home", () => {
  const [first, second, parking] = [1, 2, 3].map((id) => ({ id: String(id) }));
  const w1 = window("one", first);
  const w2 = window("two", second);
  const w3 = window("three", second);
  w3.resourceClass = "org.kde.dolphin";
  const messages = [];
  const workspace = {
    desktops: [first, second, parking],
    currentDesktop: first,
    stackingOrder: [w1, w2, w3],
    windowRemoved: { connect: () => {} },
  };
  const script = start(workspace, messages, {
    slot1PerDesktop: true,
    slot2Matcher: "class:org.kde.dolphin",
  });

  script.toggleSlot(1); // Context window on desktop 1.
  workspace.currentDesktop = second;
  script.toggleSlot(1); // Context window on desktop 2.
  script.toggleSlot(2); // Ordinary slot parks exclusively.
  assert.deepEqual(
    Array.from(w3.desktops, (d) => d.id),
    ["3"],
  );

  workspace.currentDesktop = parking;
  script.unstashAll();
  assert.deepEqual(
    Array.from(w1.desktops, (d) => d.id),
    ["1"],
  );
  assert.deepEqual(
    Array.from(w2.desktops, (d) => d.id),
    ["2"],
  );
  assert.deepEqual(
    Array.from(w3.desktops, (d) => d.id),
    ["3"],
  );
  assert.equal(w1.minimized, false);
  assert.equal(w2.minimized, false);
  assert.equal(w3.minimized, false);
  assert.equal(w1.skipTaskbar, false);
  assert.equal(w2.skipPager, false);
});

test("per-desktop slots ignore windows pinned to all desktops; ordinary slots still use them", () => {
  const [first, second] = [1, 2].map((id) => ({ id: String(id) }));
  const w = window("pinned", first);
  w.desktops = [];
  const messages = [];
  const workspace = {
    desktops: [first, second],
    currentDesktop: first,
    stackingOrder: [w],
    windowRemoved: { connect: () => {} },
  };
  const script = start(workspace, messages, {
    slot1PerDesktop: true,
    slot2Matcher: "class:org.kde.konsole",
  });
  script.toggleSlot(1);
  assert.equal(messages.at(-1), "Special Workspace 1: no matching window");
  script.toggleSlot(2);
  assert.equal(w.minimized, true);
  assert.deepEqual(w.desktops, []);
});

test("changing matcher or mode clears only that slot’s old bindings", () => {
  const [first, second] = [1, 2].map((id) => ({ id: String(id) }));
  const w1 = window("one", first);
  const w2 = window("two", second);
  const workspace = {
    desktops: [first, second],
    currentDesktop: first,
    stackingOrder: [w2, w1],
    windowRemoved: { connect: () => {} },
  };
  const script = start(workspace, [], { hideMode: 0 });
  script.toggleSlot(1);
  assert.equal(script.bound["1"], "one");

  script.settings.slot1PerDesktop = true;
  script.loadConfig();
  assert.equal(script.bound["1"], undefined);
  workspace.currentDesktop = second;
  script.toggleSlot(1);
  assert.equal(script.bound["1:2"], "two");

  script.settings.slot1Matcher = "class:org.kde.dolphin";
  script.loadConfig();
  assert.equal(script.bound["1:2"], undefined);
  script.settings.slot1PerDesktop = false;
  script.loadConfig();
  assert.equal(script.cfg.slots[0].perDesktop, false);
});

test("a per-desktop slot does not erase an ordinary slot binding with the same matcher", () => {
  const first = { id: "1" };
  const w = window("one", first);
  const workspace = {
    desktops: [first],
    currentDesktop: first,
    stackingOrder: [w],
    windowRemoved: { connect: () => {} },
  };
  const script = start(workspace, [], {
    hideMode: 0,
    slot2Matcher: "class:org.kde.konsole",
    slot2PerDesktop: true,
  });
  script.toggleSlot(1);
  script.toggleSlot(2);
  assert.equal(script.bound["1"], "one");
  assert.equal(script.bound["2:1"], "one");
});
