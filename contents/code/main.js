// Special Workspace -- Hyprland-style scratchpads for KWin.
// SPDX-License-Identifier: GPL-2.0-or-later

// Hard ceiling on slots. The config dialog exposes a row per slot up to this
// number; how many of them actually claim a keyboard shortcut is configurable.
var MAX_SLOTS = 12;

// Windows this script has hidden, keyed by internalId. The value records the
// skipTaskbar/skipPager state the window had before we touched it, so showing
// it again restores what the application asked for rather than clearing the
// flags unconditionally.
var stashed = {};

// The window each slot last acted on, keyed by slot number. This is what makes
// a slot stable: once a slot has shown a window, the same window keeps coming
// back even when several windows share a resource class.
var bound = {};

var cfg = {};

// ---------------------------------------------------------------- config ----

// readConfig hands back the default's type, but a user who clears a text field
// yields an empty QString rather than the default, so strings are normalised
// here instead of trusting the return value.
function str(key, fallback){
    var v = readConfig(key, fallback);
    return (v === undefined || v === null) ? fallback : String(v);
}

function num(key, fallback){
    var v = parseInt(readConfig(key, fallback), 10);
    return isNaN(v) ? fallback : v;
}

function bool(key, fallback){
    var v = readConfig(key, fallback);
    return (v === true || v === "true" || v === 1 || v === "1");
}

function loadConfig(){
    // Kept from the previous load so that changed matchers can be detected
    // below; on first call there is nothing to compare against.
    var previous = cfg.slots || [];

    cfg = {
        widthRatio: num("widthRatio", 75) / 100,
        heightRatio: num("heightRatio", 83) / 100,
        placeWindows: bool("placeWindows", true),
        centerOnActiveScreen: bool("centerOnActiveScreen", true),
        followCurrentDesktop: bool("followCurrentDesktop", true),
        hideMode: num("hideMode", 0),
        hideFromTaskbar: bool("hideFromTaskbar", true),
        specialDesktop: num("specialDesktop", -1),
        showOsd: bool("showOsd", true),
        slotCount: Math.max(1, Math.min(MAX_SLOTS, num("slotCount", 4))),
        slots: []
    };

    for(var i = 1; i <= MAX_SLOTS; i++){
        var matcher = str("slot" + i + "Matcher", "");

        // A slot remembers the window it last acted on, and that memory
        // outranks the matcher so repeated toggles stay on one window. Editing
        // a matcher would therefore appear to do nothing -- the slot would keep
        // serving the window it already latched onto. Forget it when the
        // matcher actually changes, so the new one is consulted immediately.
        if(previous[i - 1] !== undefined && previous[i - 1].matcher !== matcher){
            delete bound[i];
        }

        cfg.slots.push({
            matcher: matcher,
            width: num("slot" + i + "Width", 0) / 100,
            height: num("slot" + i + "Height", 0) / 100
        });
    }
}

// --------------------------------------------------------------- matching ---

// A matcher is a '|'-separated list of rules. Each rule is either bare text or
// 'field:value', where field is class, name or title. Bare text is tried
// against both the resource class and the resource name, which is what you
// want when you do not yet know which of the two an application sets.
//
//   spotify              class or name contains "spotify"
//   class:org.kde.kate   resource class contains "org.kde.kate"
//   title:*Scratch*      caption matches the glob
//   re:^kitty$           regular expression, tried against class, name, title
//   spotify|LM Studio    either rule matches
//
// Everything except 're:' is case-insensitive, and matches as a substring
// unless the value contains '*', in which case it is an anchored glob. Exact
// matching is spelled 're:^value$'.
function parseMatcher(spec){
    var rules = [];
    var parts = String(spec).split("|");

    for(var i = 0; i < parts.length; i++){
        var raw = parts[i].trim();
        if(!raw){
            continue;
        }

        var field = "any";
        var value = raw;
        var sep = raw.indexOf(":");

        if(sep > 0){
            var head = raw.substring(0, sep).toLowerCase();
            if(head === "class" || head === "name" || head === "title" || head === "re"){
                field = head;
                value = raw.substring(sep + 1).trim();
            }
        }

        if(!value){
            continue;
        }

        if(field === "re"){
            // A malformed expression would otherwise throw on every keypress.
            try {
                rules.push({field: "re", re: new RegExp(value)});
            } catch(e){
                print("Special Workspace: bad regex in matcher: " + value);
            }
        } else if(value.indexOf("*") >= 0){
            rules.push({field: field, re: globToRegExp(value)});
        } else {
            rules.push({field: field, text: value.toLowerCase()});
        }
    }

    return rules;
}

function globToRegExp(glob){
    var escaped = glob.replace(/[.+^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$", "i");
}

function fieldValue(w, field){
    if(field === "class"){
        return w.resourceClass ? String(w.resourceClass) : "";
    }
    if(field === "name"){
        return w.resourceName ? String(w.resourceName) : "";
    }
    if(field === "title"){
        return w.caption ? String(w.caption) : "";
    }
    return "";
}

function ruleMatches(w, rule){
    // 're:' and bare rules span several fields, so both collapse to a list.
    var fields = rule.field === "any" ? ["class", "name"]
               : rule.field === "re"  ? ["class", "name", "title"]
               : [rule.field];

    for(var i = 0; i < fields.length; i++){
        var value = fieldValue(w, fields[i]);
        if(!value){
            continue;
        }
        if(rule.re){
            if(rule.re.test(value)){
                return true;
            }
        } else if(value.toLowerCase().indexOf(rule.text) >= 0){
            return true;
        }
    }

    return false;
}

function matches(w, rules){
    for(var i = 0; i < rules.length; i++){
        if(ruleMatches(w, rules[i])){
            return true;
        }
    }
    return false;
}

// Windows we are willing to stash. Dialogs, docks, notifications and the like
// are excluded: minimising a transient leaves its parent in a strange state,
// and parking a panel would hide part of the desktop with no way back.
function isManageable(w){
    return !!w && w.normalWindow === true && !w.deleted;
}

function idOf(w){
    return String(w.internalId);
}

function findById(id){
    if(!id){
        return null;
    }

    var order = workspace.stackingOrder;
    for(var i = 0; i < order.length; i++){
        if(order[i] && idOf(order[i]) === id){
            return isManageable(order[i]) ? order[i] : null;
        }
    }

    return null;
}

// Resolves the window a slot should act on, in decreasing order of confidence:
// the window the slot is already bound to, then a matching window we have
// stashed, then the topmost match. The middle step keeps a toggle returning to
// the same window when a matcher is broad enough to catch several.
function resolve(slot){
    var remembered = findById(bound[slot]);
    if(remembered){
        return remembered;
    }

    var rules = parseMatcher(cfg.slots[slot - 1].matcher);
    if(rules.length === 0){
        return null;
    }

    var order = workspace.stackingOrder;
    var topmost = null;

    // stackingOrder runs bottom to top, so walking it backwards visits the
    // most recently raised window first.
    for(var i = order.length - 1; i >= 0; i--){
        var w = order[i];
        if(!isManageable(w) || !matches(w, rules)){
            continue;
        }
        if(stashed[idOf(w)]){
            return w;
        }
        if(!topmost){
            topmost = w;
        }
    }

    return topmost;
}

// ------------------------------------------------------------- geometry -----

// The area a shown window may occupy, with panels excluded when KWin exposes
// the enum. Defaults to the screen the user is looking at, so a window stashed
// on one monitor comes back on whichever monitor is now active, rather than
// reappearing behind the user on the monitor it left from.
function usableArea(w){
    try {
        if(typeof KWin !== "undefined" && KWin.MaximizeArea !== undefined){
            if(cfg.centerOnActiveScreen){
                return workspace.clientArea(KWin.MaximizeArea, workspace.activeScreen,
                                            workspace.currentDesktop);
            }
            return workspace.clientArea(KWin.MaximizeArea, w);
        }
    } catch(e){
        // fall through to the raw output geometry
    }

    if(cfg.centerOnActiveScreen && workspace.activeScreen && workspace.activeScreen.geometry){
        return workspace.activeScreen.geometry;
    }
    if(w.output && w.output.geometry){
        return w.output.geometry;
    }
    return workspace.activeScreen.geometry;
}

// Resolves the parking desktop to a KWin VirtualDesktop, or null if we should
// not move windows at all. Never returns an out-of-range desktop:
// workspace.desktops shrinks when the user removes virtual desktops, and
// handing KWin an undefined desktop is what breaks hiding.
function specialDesktop(){
    var all = workspace.desktops;
    if(!all || all.length < 2){
        return null;
    }

    var idx = cfg.specialDesktop < 0 ? all.length - 1 : cfg.specialDesktop;
    if(idx < 0 || idx >= all.length){
        return null;
    }

    return all[idx];
}

// `desktops` is a whole-list property (KWin::Window::setDesktops), so assign a
// new array. Writing desktops[0] instead mutates Qt's sequence wrapper and only
// reaches KWin through a write-back path.
// An empty list means "on all desktops" -- leave those windows alone.
function moveToDesktop(w, desktop){
    if(desktop && w.desktops.length > 0){
        w.desktops = [desktop];
    }
}

// ---------------------------------------------------------- show and hide ---

function showWindow(w, slot){
    var id = idOf(w);

    if(cfg.followCurrentDesktop || cfg.hideMode === 1){
        moveToDesktop(w, workspace.currentDesktop);
    }

    // Restore the flags the application originally set rather than clearing
    // them: a window that asked to stay out of the taskbar should still be out
    // of it after passing through the scratchpad.
    var prev = stashed[id];
    if(prev){
        w.skipTaskbar = prev.skipTaskbar;
        w.skipPager = prev.skipPager;
        delete stashed[id];
    }

    // Hands placement to whatever else is managing windows -- a tiling script
    // such as Krohnkite will arrange the window itself, and a rect assigned
    // here would only be overwritten a moment later.
    //
    // The ordering matters and is not incidental. Activating a minimized window
    // is what brings it back; clearing `minimized` first would let the tiler
    // see the window reappear while it is still unfocused, which typically
    // lands it in a stack column rather than the master area.
    if(!cfg.placeWindows){
        workspace.activeWindow = w;
        if(w.minimized){
            w.minimized = false;
        }
        return;
    }

    w.minimized = false;

    var area = usableArea(w);
    var slotCfg = slot ? cfg.slots[slot - 1] : null;
    var wRatio = (slotCfg && slotCfg.width > 0) ? slotCfg.width : cfg.widthRatio;
    var hRatio = (slotCfg && slotCfg.height > 0) ? slotCfg.height : cfg.heightRatio;

    var width = Math.round(area.width * wRatio);
    var height = Math.round(area.height * hRatio);

    // Assign the rect in one go; mutating frameGeometry.width in place edits a
    // temporary copy of the value type rather than the window.
    w.frameGeometry = {
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + (area.height - height) / 2),
        width: width,
        height: height
    };

    workspace.activeWindow = w;
}

function hideWindow(w){
    var id = idOf(w);

    if(!stashed[id]){
        stashed[id] = {skipTaskbar: w.skipTaskbar, skipPager: w.skipPager};
    }

    // Minimize before parking. Minimizing hands focus to the next window
    // through KWin's normal path, while the window is still on the current
    // desktop; pulling it off-desktop first makes KWin do that focus transfer
    // against a window that is no longer where it thinks it is.
    w.minimized = true;

    if(cfg.hideFromTaskbar){
        w.skipTaskbar = true;
        w.skipPager = true;
    }

    if(cfg.hideMode === 1){
        moveToDesktop(w, specialDesktop());
    }
}

// A window counts as shown when it is on screen here and now. Checking only
// `active` would make the toggle re-focus a visible-but-unfocused window on the
// first press and hide it on the second, which reads as a missed keypress.
function isShown(w){
    if(w.minimized){
        return false;
    }
    if(w.desktops.length === 0){
        return true;
    }
    // Compare by id as well as identity: KWin hands out fresh JS wrappers for
    // the same VirtualDesktop, so `===` alone is not dependable here.
    var current = workspace.currentDesktop;
    for(var i = 0; i < w.desktops.length; i++){
        var d = w.desktops[i];
        if(d === current || (d && current && String(d.id) === String(current.id))){
            return true;
        }
    }
    return false;
}

function toggleSlot(slot){
    var w = resolve(slot);
    if(!w){
        osd("Special Workspace " + slot + ": no matching window");
        return;
    }

    bound[slot] = idOf(w);

    // One key, both directions: if the window is here on this desktop it goes
    // away, otherwise it comes back. Focus deliberately does not enter into it
    // -- requiring the window to be focused before it can be hidden turns a
    // visible-but-unfocused window into a two-press affair, where the first
    // press only raises it and reads as a missed keypress.
    if(isShown(w)){
        hideWindow(w);
    } else {
        showWindow(w, slot);
    }
}

function unstashAll(){
    var order = workspace.stackingOrder;
    var count = 0;

    for(var i = 0; i < order.length; i++){
        var w = order[i];
        if(isManageable(w) && stashed[idOf(w)]){
            showWindow(w, 0);
            count++;
        }
    }

    osd(count > 0 ? "Restored " + count + " window(s)" : "Nothing was stashed");
}

// Replaces the usual "open the WM console and tail journalctl" ritual: focus a
// window, press the key, and read the values a matcher needs off the screen.
function identifyActive(){
    var w = workspace.activeWindow;
    if(!w){
        return;
    }

    osd("class: " + w.resourceClass +
        "\nname: " + w.resourceName +
        "\ntitle: " + w.caption, true);
}

function osd(text, force){
    if(!cfg.showOsd && !force){
        return;
    }

    try {
        callDBus("org.kde.plasmashell", "/org/kde/osdService", "org.kde.osdService",
                 "showText", "preferences-system-windows", text);
    } catch(e){
        print("Special Workspace: " + text);
    }
}

// ---------------------------------------------------------------- startup ---

loadConfig();

// Re-read settings whenever KWin reconfigures. Note that pressing Apply in this
// script's own settings dialog does NOT get us here: kcm_kwin4_genericscripted
// notifies via the Effects DBus interface (reconfigureEffect), and a KWin script
// is not an effect, so nothing reaches us. KWin also keeps the parsed config
// cached, so polling readConfig would return stale values too -- reloading the
// script is the only way to pick up its own settings. This hook still earns its
// place for reconfigures triggered elsewhere, and costs nothing.
//
// The slot count is deliberately *not* re-applied here: registerShortcut can
// only add actions, never retract them, so changing how many slots exist still
// needs a real script reload.
if(typeof options !== "undefined" && options.configChanged){
    options.configChanged.connect(loadConfig);
}

// A closed window leaves entries behind in both maps. They are harmless -- ids
// are never reused -- but a long session with many short-lived windows would
// grow them without bound.
workspace.windowRemoved.connect(function(w){
    if(!w){
        return;
    }
    var id = idOf(w);
    delete stashed[id];
    for(var slot in bound){
        if(bound[slot] === id){
            delete bound[slot];
        }
    }
});

// The first string is the action name stored in kglobalshortcutsrc, the second
// is the label shown in System Settings. Renaming the first orphans every
// binding a user has made, so these stay fixed across releases.
for(var slot = 1; slot <= cfg.slotCount; slot++){
    (function(n){
        registerShortcut("Special Workspace " + n,
                         "Special Workspace: Toggle slot " + n,
                         n <= 4 ? "Meta+F" + n : "",
                         function(){ toggleSlot(n); });
    })(slot);
}

// A slot above the configured count is simply not registered. Note that this
// does NOT hand its keyboard shortcut back: Plasma keeps a binding for as long
// as the action exists, and an unregistered action is invisible in System
// Settings while still reserving its key. Clearing it from inside the script is
// not possible -- kglobalaccel's setShortcut takes a QStringList plus a list of
// key codes, which callDBus cannot marshal -- so the shortcut has to be cleared
// in System Settings *before* the slot count is lowered, while the action is
// still listed there. This is why the default slot count is low: raising it is
// free, lowering it is not.

registerShortcut("Special Workspace Identify",
                 "Special Workspace: Show focused window's class",
                 "", identifyActive);

registerShortcut("Special Workspace Unstash All",
                 "Special Workspace: Restore all hidden windows",
                 "", unstashAll);
