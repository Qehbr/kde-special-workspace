// SPDX-License-Identifier: GPL-2.0-or-later
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../contents/code/main.js"), "utf8");

function start() {
  const context = vm.createContext({
    workspace: { desktops: [], stackingOrder: [], windowRemoved: { connect: () => {} } },
    readConfig: (key, fallback) => fallback,
    registerShortcut: () => {},
    callDBus: () => {},
    print: () => {},
  });
  vm.runInContext(source, context);
  return context;
}

const script = start();

function win(resourceClass, caption = "") {
  return { resourceClass, resourceName: resourceClass.toLowerCase(), caption };
}

function matches(spec, w) {
  return script.matches(w, script.parseMatcher(spec));
}

test("a '|' inside a regex group belongs to the regex", () => {
  assert.equal(script.parseMatcher("re:^(spotify|kitty)$").length, 1);
  assert.equal(matches("re:^(spotify|kitty)$", win("spotify")), true);
  assert.equal(matches("re:^(spotify|kitty)$", win("kitty")), true);
  assert.equal(matches("re:^(spotify|kitty)$", win("kitty2")), false);
});

test("a '|' inside a regex character class or escaped belongs to the regex", () => {
  assert.equal(script.parseMatcher("re:^[|x]$").length, 1);
  assert.equal(matches("re:^[|x]$", win("app", "|")), true);
  assert.equal(script.parseMatcher("re:^a\\|b$").length, 1);
  assert.equal(matches("re:^a\\|b$", win("app", "a|b")), true);
});

test("a top-level '|' still separates rules, after a regex too", () => {
  assert.equal(script.parseMatcher("re:^kitty$|spotify").length, 2);
  assert.equal(matches("re:^kitty$|spotify", win("kitty")), true);
  assert.equal(matches("re:^kitty$|spotify", win("Spotify")), true);
  assert.equal(script.parseMatcher("spotify|LM Studio").length, 2);
  assert.equal(matches("spotify|LM Studio", win("LM Studio")), true);
});

test("parentheses outside a regex do not hold back the next rule", () => {
  assert.equal(script.parseMatcher("title:Song (Live|kitty").length, 2);
  assert.equal(matches("title:Song (Live|kitty", win("kitty")), true);
});

test("'?' in a wildcard matches a literal question mark", () => {
  assert.equal(matches("title:Why?*", win("app", "Why? Because")), true);
  assert.equal(matches("title:Why?*", win("app", "Whale")), false);
  assert.equal(matches("title:*Scratch*", win("app", "my Scratch pad")), true);
});
