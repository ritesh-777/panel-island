// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Glass that blurs what GNOME is really showing behind it, also where GNOME draws a scene of its own instead of the
// desktop. Isle's glass (its GlassBackdrop, glass.js) blurs copies of the wallpaper, the windows and the top bar. Two
// times GNOME shows something else there:
//
//  - the overview: the windows' group (the wallpaper in it too) is hidden, and the overview drawn instead (its own
//    background, the workspaces and their windows, the dash, search, the app grid). Isle hides its glass there,
//    leaving its island almost clear;
//  - a workspace switch (a swipe, a shortcut): a group of its own, over the windows, holds each workspace's wallpaper
//    and copies of its windows, and slides; the real windows under it, covered, drop out of the glass's copies.
//
// Each time, a copy of that scene goes into the glass's copies, over the wallpaper and windows and under the bar, as
// big as the scene is, and comes out again as it ends: the glass blurs it as it moves.
//
// Done to Isle's own code as it runs, never to its files: its two methods, `_syncVisible` and `_windowPlaces`, are
// wrapped on a backdrop (ours) or on Isle's class (Settings → Keep Isle's glass in the overview). Each wrap is put on
// only if Isle still has both, falls back to Isle's own method should it fail, and comes off again as it was.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** What the wrap on Isle's class does for Isle's own glass (Settings): keep it over GNOME's scenes (`overview`), and
 * copy only the windows under its glass itself, not those only in the blur's margin round it (`lighter`: a window
 * just below the bar, a video playing in it, then never has it blurred again every frame). Ours does both always. */
const isleDoes = {overview: false, lighter: false};

/** Sets what the wrap on Isle's class does for Isle's glass (see `isleDoes`); its glass looked at again at once. */
export function setIsleBehaviour({overview = false, lighter = false} = {}) {
    isleDoes.overview = overview;
    isleDoes.lighter = lighter;
    for (const backdrop of known) {
        if (isOurs(backdrop))
            continue;
        try {
            backdrop._places = null;
            if (overview)
                syncScenes(backdrop, scenesFor(backdrop));
            else
                clearScenes(backdrop);
            backdrop._syncVisible?.();
            backdrop._queueSync?.();
        } catch (e) {
            console.warn(`[panel-island] Isle's glass: ${e}`);
        }
    }
}

/** Whether `backdrop` is ours (wrapped on itself, not through Isle's class). */
const isOurs = backdrop => Object.hasOwn(backdrop, '_syncVisible');

/** Where a window place's window is seen: its frame, not its actor's box, which takes in the invisible margins round it
 * (its shadow, its resize edges) that reach up under the bar from a window maximised below it. Its box without one. */
function seenBox(place) {
    try {
        const r = place.actor?.meta_window?.get_frame_rect?.();
        if (r && r.width > 0 && r.height > 0)
            return {x: r.x, y: r.y, width: r.width, height: r.height};
    } catch {}
    return place;
}

/** Whether the window place `a` and the glass's own area `b` ({stageX, stageY, width, height}, Isle's `_rect`) meet:
 * the window as it is seen (its frame), so one below the bar its shadow reaches under is not taken for one under it. */
const meets = (place, b) => {
    const a = seenBox(place);
    return a.x < b.stageX + b.width && a.x + a.width > b.stageX && a.y < b.stageY + b.height && a.y + a.height > b.stageY;
};

/** The backdrops seen with a wrap on, alive: each given the scenes as they come and go. */
const known = new Set();
/** The workspace-switch groups on the screen now. */
const switching = new Set();
let watchIds = null;
let overviewIds = [];
/** Whether the first copy of this session has been noted in the log. */
let noted = false;

/** Whether the overview is on the screen (opening, open, or closing: it draws the windows all that time). */
const inOverview = () => Main.overview.visible;

/** The glass's least time between two blurs (ms) while GNOME animates a scene under it (the overview opening or
 * closing, a workspace switch): half its usual rate (shape.js), each layer's blur costing less every frame of it. */
const SCENE_FRAME_MS = 66;
const RESTING_FRAME_MS = 33;

/** Whether the overview is opening or closing: from 'showing' or 'hiding' until 'shown' or 'hidden' (by a gesture
 * too, where GNOME sets its own animationInProgress only after saying it is showing). */
let overviewMoving = false;

/** Whether GNOME is animating a scene of its own now: a workspace switch, or the overview opening or closing. */
const animatingScene = () => switching.size > 0 || overviewMoving || Boolean(Main.overview.animationInProgress);

/** Whether `backdrop` is on the screen: hidden (our menu's glass with no menu open), it is given no scene to copy,
 * as nothing of it is seen. */
const shown = backdrop => backdrop.mapped ?? true;

/** The scenes `backdrop` is given now: those GNOME draws, while it is on and on the screen. */
const scenesFor = backdrop => (backdrop._on && shown(backdrop) ? scenes(backdrop) : []);

/** Whether `actor` is a workspace switch's group (workspaceAnimation.js MonitorGroup). */
function isSwitchGroup(actor) {
    const name = actor?.constructor?.$gtype?.name ?? '';
    return actor?.constructor?.name === 'MonitorGroup' || name.endsWith('MonitorGroup');
}

/** The scenes GNOME is drawing in place of the desktop now, bottom first. */
/** On battery (UPower's OnBattery): a workspace switch costs next to nothing. No glass is given a copy of the sliding
 * scene (carrying one along is itself work every frame, blurred or not, measured at about three times the CPU), and
 * ours keeps the blur it had as the switch began until it ends (`FROZEN_MS`), so it shows no jump. The overview, still,
 * as on mains. */
let onBattery = false;

/** Settings → Glass during workspace switches: 'always' still (the default), 'battery' still on battery only,
 * 'never' live at full resolution, 'live-efficient' live with a smaller shared blur. */
let switchGlass = 'always';
const stillDuringSwitch = () => switchGlass === 'always' || (switchGlass === 'battery' && onBattery);

/** Sets it (`mode` as above); the glass looked at again at once. */
export function setSwitchGlass(mode) {
    const next = ['always', 'battery', 'never', 'live-efficient'].includes(mode) ? mode : 'always';
    if (next === switchGlass)
        return;
    switchGlass = next;
    syncAll();
}
let upower = null;
const FROZEN_MS = 60000;

function watchPower() {
    if (upower)
        return;
    try {
        upower = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower', null);
        const sync = () => {
            const now = Boolean(upower?.get_cached_property('OnBattery')?.unpack());
            if (now === onBattery)
                return;
            onBattery = now;
            syncAll();
        };
        upower.connect('g-properties-changed', sync);
        sync();
    } catch (e) {
        console.warn(`[panel-island] Battery state not known (glass blurs as on mains): ${e.message}`);
        upower = null;
    }
}

function unwatchPower() {
    upower?.run_dispose?.();
    upower = null;
    onBattery = false;
}

/**
 * Where `source`, a scene, is on the screen and how big. A switch's group is the monitor it slides on: read from that,
 * not from the group, which is sized by a constraint only as it is first laid out. Until then it says how wide all its
 * workspaces side by side are, so a copy sized from it then drew the scene stretched that much (most at the first
 * workspace, the others all to its right: its wallpaper seen moving under the glass as a swipe there went nowhere).
 */
function sceneBox(source) {
    const m = isSwitchGroup(source) ? source._monitor : null;
    if (m && [m.x, m.y, m.width, m.height].every(Number.isFinite) && m.width > 0 && m.height > 0)
        return {x: m.x, y: m.y, width: m.width, height: m.height};
    return null;
}

/** `copy` of the scene `source` put where it is and sized as it is (see `sceneBox`); other scenes follow their size. */
function placeCopy(copy, source) {
    const box = sceneBox(source);
    if (!box) {
        if (!copy._panelIslandBound) {
            copy._panelIslandBound = true;
            copy.add_constraint(new Clutter.BindConstraint({source, coordinate: Clutter.BindCoordinate.SIZE}));
        }
        if (copy.x !== source.x || copy.y !== source.y)
            copy.set_position(source.x, source.y);
        return;
    }
    setBox(copy, box);
}

/** `actor` given `box` as its own place and size, compared with what it was given last, not with its width and height:
 * before it is laid out those read as what it asks for (a copy of a switch's group: as wide as the workspaces right of
 * where the slide starts). From the last workspace that is the monitor's width, so it was taken as sized already, never
 * given one, and followed the group's width as the slide went (its blur stretched, off the picture). */
function setBox(actor, box) {
    const had = actor._panelIslandBox;
    if (had && ['x', 'y', 'width', 'height'].every(k => had[k] === box[k]))
        return;
    actor._panelIslandBox = {x: box.x, y: box.y, width: box.width, height: box.height};
    actor.set_position(box.x, box.y);
    actor.set_size(box.width, box.height);
}

/** The scenes GNOME draws now, for `backdrop` (Isle's not given a switch's on battery). */
function scenes(backdrop = null) {
    // Ours, sharing the switch's one blur (`syncShared`): no copy of its own.
    const now = stillDuringSwitch() || sharesSwitch(backdrop) ? [] : [...switching];
    if (inOverview())
        now.push(Main.layoutManager.overviewGroup);
    return now;
}

/** The wallpaper's copy in `backdrop` shown only while the wallpaper itself is: not in the overview, where the
 * windows' group it is in is hidden (a scene over it then: by a gesture, the group is hidden only after it opens). */
function syncWallpaper(backdrop) {
    const wallpaper = backdrop._wallpaper;
    if (wallpaper && 'opacity' in wallpaper)
        wallpaper.opacity = backdrop._panelIslandScenes?.size && !global.window_group.visible ? 0 : 255;
}

/**
 * The copies in `backdrop` of each scene in `want` (none for an empty list), over the wallpaper and windows, under
 * the bar. Each sized as its scene: a copy draws its source scaled to its own size, and these groups are sized by
 * constraints (the screen's), not by what they ask for, so a copy left to its own size drew them at nothing.
 */
function syncScenes(backdrop, want, updateShared = true) {
    const layers = backdrop._layers;
    const held = backdrop._panelIslandScenes ??= new Map();
    for (const [source, copy] of held) {
        if (!want.includes(source)) {
            copy.destroy();
            held.delete(source);
        }
    }
    if (layers) {
        for (const source of want) {
            if (held.has(source)) {
                placeCopy(held.get(source), source);
                continue;
            }
            const copy = new Clutter.Clone({source, reactive: false});
            placeCopy(copy, source);
            if (backdrop._bar?.get_parent?.() === layers)
                layers.insert_child_below(copy, backdrop._bar);
            else
                layers.add_child(copy);
            held.set(source, copy);
            if (!noted) {
                noted = true;
                console.log(`[panel-island] Glass over GNOME's own scene: copying it, ${source.width}×${source.height}`);
            }
        }
    }
    // Blurred less often while the scene under it animates (our mask only: Isle's own keeps its rate).
    const mask = backdrop._mask;
    if (mask && 'frameMs' in mask) {
        // On battery a switch is not blurred at all: the blur from before it held, blurred anew once it is over.
        const frozen = stillDuringSwitch() && switching.size > 0;
        const was = mask.frameMs;
        // Live (Settings → Glass during workspace switches): every frame while GNOME animates a scene under it, the
        // blur moving with the slide; the halved rate (`SCENE_FRAME_MS`) only when held still is not chosen at all.
        const animating = (held.size || sharesSwitch(backdrop)) && animatingScene();
        mask.frameMs = frozen ? FROZEN_MS : animating ? (stillDuringSwitch() ? SCENE_FRAME_MS : 0) : RESTING_FRAME_MS;
        if (was === FROZEN_MS && !frozen) {
            mask.stopCatchUp?.();
            backdrop.queue_redraw?.();
        }
    }
    if (held.size && !backdrop._panelIslandWindowsId)
        backdrop._panelIslandWindowsId = global.window_group.connect('notify::visible', () => syncWallpaper(backdrop));
    else if (!held.size && backdrop._panelIslandWindowsId) {
        global.window_group.disconnect(backdrop._panelIslandWindowsId);
        backdrop._panelIslandWindowsId = 0;
    }
    syncWallpaper(backdrop);
    if (updateShared)
        syncShared();
}

/*
 * Live workspace switches, shared: one copy of the sliding scene's strip under all our glass (and Isle's island), blurred once a frame,
 * instead of each glass copying the whole scene and blurring its own part of it (each copy has GNOME draw every
 * workspace's wallpaper and windows again, the CPU's work, once per glass per frame). The copy is hidden: it is drawn
 * only through a clone of it in each glass, in place of that glass's own blurred frame. Its blur keeps what it drew
 * until the scene under it changes, so the first glass drawn in a frame blurs it and the others show that same blur;
 * each glass's mask (its shape, edge light, lens, tint) is still its own, on what it shows of it. Isle's island shares
 * it while Isle's glass is kept over GNOME's scenes (see `canShare`), its own mask on it. One shared copy per blur look (radius, brightness), light and dark glass apart.
 */

/** Each shared copy, by its look's key: {frame (hidden, blurred), layers (the scene's copies), copies (by scene),
 * blur, strip ({x, y, width, height} on the screen)}. */
const shared = new Map();

/** Whether a Live switch is under the glass now, outside the overview: what is shared. */
const sharing = () => !stillDuringSwitch() && switching.size > 0 && !inOverview();

/** Whether `backdrop` can show a shared copy: ours, or Isle's own island while the wrap on Isle's class keeps it over
 * GNOME's scenes (Settings → Keep Isle's glass in the overview: it would copy the slide itself otherwise), done to it
 * as it runs, never to Isle's files; with Isle's frame and blur as Isle 1.7 has them, placed. */
const canShare = backdrop => (isOurs(backdrop) || isleDoes.overview) && backdrop._frame instanceof Clutter.Actor &&
    backdrop._blur instanceof Shell.BlurEffect && typeof backdrop._frameRect === 'function' && Boolean(backdrop._rect);

/** Whether `backdrop` shows the switch through a shared copy now (not a copy of its own). */
const sharesSwitch = backdrop => Boolean(backdrop) && sharing() && backdrop._on && shown(backdrop) &&
    !backdrop._panelIslandNoShare && canShare(backdrop);

/** Reduce only the shared scene texture; a tiny blur is kept at full resolution. */
function sampleDivisor(backdrop) {
    return switchGlass === 'live-efficient' && backdrop._blur.radius >= 2 ? 2 : 1;
}
const keyOf = backdrop => `${backdrop._blur.radius}:${backdrop._blur.brightness}:${sampleDivisor(backdrop)}`;

/** `backdrop` back to its own frame (its clone of a shared copy taken out). */
function dropShared(backdrop) {
    const clone = backdrop._panelIslandShared;
    if (!clone)
        return;
    backdrop._panelIslandShared = null;
    try {
        clone.destroy();
    } catch {}
    try {
        backdrop._frame.visible = true;
    } catch {}
}

/** Every shared copy gone. */
function closeShared() {
    for (const entry of shared.values()) {
        try {
            entry.frame.destroy();
        } catch {}
    }
    shared.clear();
    holder?.destroy();
    holder = null;
}

/** Where the shared copies are kept: on the stage and shown (so each stays mapped, and its blur kept from one clone
 * of it to the next within a frame, not mapped anew for each), but never drawn itself: only its clones draw it. */
const Unpainted = GObject.registerClass({GTypeName: 'PanelIslandUnpainted'}, class Unpainted extends Clutter.Actor {
    vfunc_paint(_paintContext) {}

    vfunc_pick(_pickContext) {}
});
let holder = null;

/** A new shared copy blurred as `backdrop`'s glass is, kept unpainted. */
function openShared(backdrop) {
    if (!holder) {
        holder = new Unpainted({reactive: false});
        holder.connect('destroy', () => {
            holder = null;
        });
        Main.layoutManager.uiGroup.add_child(holder);
    }
    const frame = new St.Widget({clip_to_allocation: true, reactive: false});
    const divisor = sampleDivisor(backdrop);
    const layers = new Clutter.Actor();
    layers.set_pivot_point(0, 0);
    layers.set_scale(1 / divisor, 1 / divisor);
    frame.add_child(layers);
    const blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: Math.round(backdrop._blur.radius / divisor),
        brightness: backdrop._blur.brightness});
    frame.add_effect(blur);
    holder.add_child(frame);
    return {frame, layers, blur, divisor, copies: new Map(), strip: null};
}

/** Whether `a` and `b` ({x, y, width, height}) are the same. */
const sameRect = (a, b) => Boolean(a && b) && ['x', 'y', 'width', 'height'].every(k => a[k] === b[k]);

/** The shared copies made, sized and given to the glass that shows them, as a Live switch goes on; all taken back
 * as it ends (or as the glass shows something else). */
function syncShared() {
    const byKey = new Map();
    for (const backdrop of known) {
        if (!sharesSwitch(backdrop)) {
            dropShared(backdrop);
            continue;
        }
        const key = keyOf(backdrop);
        if (!byKey.has(key))
            byKey.set(key, []);
        byKey.get(key).push(backdrop);
    }
    for (const [key, entry] of shared) {
        if (!byKey.has(key)) {
            entry.frame.destroy();
            shared.delete(key);
        }
    }
    for (const [key, group] of byKey) {
        try {
            syncSharedGroup(key, group);
        } catch (e) {
            // Each falls back to a copy of its own, as before.
            console.warn(`[panel-island] Shared glass for workspace switches not used: ${e}`);
            for (const backdrop of group) {
                dropShared(backdrop);
                backdrop._panelIslandNoShare = true;
            }
            shared.get(key)?.frame.destroy();
            shared.delete(key);
            for (const backdrop of group)
                syncScenes(backdrop, scenesFor(backdrop));
        }
    }
    // The switch over: nothing kept.
    if (!shared.size && holder)
        closeShared();
}

/** The shared copy `key` covering all the frames of the glass in `group` (screen px), the scene's groups in it at
 * their places, each glass showing its own part of it in place of its own frame. */
function syncSharedGroup(key, group) {
    let entry = shared.get(key);
    if (!entry) {
        entry = openShared(group[0]);
        shared.set(key, entry);
        if (!notedShared) {
            notedShared = true;
            const isle = group.filter(backdrop => !isOurs(backdrop)).length;
            console.log(`[panel-island] Live workspace switch: one shared blur for ${group.length} glass ` +
                `(${isle} of them Isle's)`);
        }
    }
    const rects = group.map(backdrop => backdrop._frameRect()).filter(Boolean);
    // Align the strip to a fixed stage-space sampling grid, including on monitors at negative coordinates.
    // Clones keep the full strip size; their smaller source is enlarged before each capsule's own mask.
    const d = entry.divisor;
    const x0 = d * Math.floor(Math.min(...rects.map(r => r.x)) / d);
    const y0 = d * Math.floor(Math.min(...rects.map(r => r.y)) / d);
    const x1 = d * Math.ceil(Math.max(...rects.map(r => r.x + r.width)) / d);
    const y1 = d * Math.ceil(Math.max(...rects.map(r => r.y + r.height)) / d);
    const strip = {x: x0, y: y0, width: Math.max(d, x1 - x0), height: Math.max(d, y1 - y0)};
    if (!sameRect(entry.strip, strip)) {
        entry.strip = strip;
        entry.frame.set_size(strip.width / d, strip.height / d);
        entry.layers.set_position(-strip.x / d, -strip.y / d);
    }
    // The scene's groups, bottom first, as the screen stacks them.
    const want = [...switching];
    for (const [source, copy] of entry.copies) {
        if (!want.includes(source)) {
            copy.destroy();
            entry.copies.delete(source);
        }
    }
    for (const source of want) {
        let copy = entry.copies.get(source);
        if (!copy) {
            copy = new Clutter.Clone({source, reactive: false});
            entry.layers.add_child(copy);
            entry.copies.set(source, copy);
        }
        placeCopy(copy, source);
    }
    for (const backdrop of group) {
        let clone = backdrop._panelIslandShared;
        if (clone && clone.source !== entry.frame) {
            dropShared(backdrop);
            clone = null;
        }
        if (!clone) {
            clone = new Clutter.Clone({source: entry.frame, reactive: false});
            backdrop.insert_child_above(clone, backdrop._frame);
            backdrop._panelIslandShared = clone;
        }
        backdrop._frame.visible = false;
        const rect = backdrop._rect;
        setBox(clone, {x: strip.x - Math.round(rect.stageX), y: strip.y - Math.round(rect.stageY),
            width: strip.width, height: strip.height});
    }
}
let notedShared = false;

/** Our glass `backdrop` just placed (extension.js `Glass.place`): its part of a shared copy kept under it. */
export function followShared(backdrop) {
    if (!backdrop?._panelIslandShared)
        return;
    try {
        syncShared();
    } catch (e) {
        console.warn(`[panel-island] Shared glass: ${e}`);
    }
}

/** All of `backdrop`'s scene copies out, its wallpaper's copy shown. */
function clearScenes(backdrop) {
    try {
        syncScenes(backdrop, []);
    } catch {}
    dropShared(backdrop);
}

/** Gives every known backdrop the scenes GNOME draws now. */
function syncAll() {
    for (const backdrop of known) {
        try {
            syncScenes(backdrop, scenesFor(backdrop), false);
        } catch (e) {
            console.warn(`[panel-island] Glass over GNOME's own scene: ${e}`);
        }
    }
    try {
        syncShared();
    } catch (e) {
        console.warn(`[panel-island] Shared glass after a scene update: ${e}`);
    }
}

/** Told as a workspace switch starts or ends (see `onSwitch`). */
const switchListeners = new Set();

/** Whether a workspace switch is sliding now. */
export const isSwitching = () => switching.size > 0;

/** `callback()` called as a workspace switch starts or ends; returns how to stop that. */
export function onSwitch(callback) {
    switchListeners.add(callback);
    return () => switchListeners.delete(callback);
}

/** A switch's group came or went: the glass given the scenes again, and those following switches told. */
function switchChanged() {
    syncAll();
    for (const callback of [...switchListeners]) {
        try {
            callback();
        } catch (e) {
            console.warn(`[panel-island] After a workspace switch: ${e}`);
        }
    }
}

/** A workspace switch's group added or gone, over the windows: the scenes are looked at again. */
function watchSwitches() {
    if (watchIds)
        return;
    const uiGroup = Main.layoutManager.uiGroup;
    const added = (_group, actor) => {
        if (!isSwitchGroup(actor))
            return;
        switching.add(actor);
        actor.connectObject('destroy', () => {
            switching.delete(actor);
            switchChanged();
        }, uiGroup);
        switchChanged();
    };
    const removed = (_group, actor) => {
        if (switching.delete(actor))
            switchChanged();
    };
    watchIds = [uiGroup.connect('child-added', added), uiGroup.connect('child-removed', removed)];
    // The overview starting or ending an animation: the scenes, and how often they are blurred, looked at again.
    overviewIds = ['showing', 'shown', 'hiding', 'hidden'].map(signal => Main.overview.connect(signal, () => {
        overviewMoving = signal === 'showing' || signal === 'hiding';
        syncAll();
    }));
    uiGroup.get_children().forEach(actor => added(uiGroup, actor));
}

function unwatchSwitches() {
    if (!watchIds)
        return;
    const uiGroup = Main.layoutManager.uiGroup;
    watchIds.forEach(id => uiGroup.disconnect(id));
    watchIds = null;
    overviewIds.forEach(id => Main.overview.disconnect(id));
    overviewIds = [];
    overviewMoving = false;
    for (const actor of switching)
        actor.disconnectObject?.(uiGroup);
    switching.clear();
}

/** `backdrop` noted, to be given the scenes as they come and go; forgotten as it goes. */
function know(backdrop) {
    if (known.has(backdrop))
        return;
    known.add(backdrop);
    // Shown or hidden (our menu's glass as a menu opens or closes): given the scenes, or none, at once.
    backdrop._panelIslandMappedId ??= backdrop.connect('notify::mapped', () => {
        try {
            if (known.has(backdrop))
                syncScenes(backdrop, scenesFor(backdrop));
        } catch (e) {
            console.warn(`[panel-island] Glass over GNOME's own scene: ${e}`);
        }
    });
    backdrop._panelIslandGoneId ??= backdrop.connect('destroy', () => {
        known.delete(backdrop);
        if (backdrop._panelIslandWindowsId)
            global.window_group.disconnect(backdrop._panelIslandWindowsId);
        backdrop._panelIslandWindowsId = 0;
        backdrop._panelIslandScenes?.clear();
        backdrop._panelIslandShared = null;
    });
}

/**
 * Keeps the glass of `target` (one backdrop, or Isle's GlassBackdrop class's prototype) over what GNOME really shows:
 * in the overview and as workspaces switch. Returns how to take that off again, or null when `target` does not have
 * what this changes (Isle changed): nothing is done then.
 */
export function keepInOverview(target) {
    const sync = target?._syncVisible, places = target?._windowPlaces;
    if (typeof sync !== 'function' || typeof places !== 'function')
        return null;
    const own = name => Object.getOwnPropertyDescriptor(target, name);
    const before = {sync: own('_syncVisible'), places: own('_windowPlaces')};
    watchSwitches();
    watchPower();

    // Called by Isle's glass as it turns on or off and as the overview starts to open and once it has closed.
    target._syncVisible = function () {
        // Isle's own glass, the overview part off (Settings): as Isle has it.
        if (!isOurs(this) && !isleDoes.overview) {
            try {
                know(this);
                clearScenes(this);
            } catch {}
            return sync.call(this);
        }
        try {
            know(this);
            this.visible = Boolean(this._on);
            syncScenes(this, scenesFor(this));
            // What it copies changes as the overview opens or closes: looked at again.
            this._queueSync?.();
        } catch (e) {
            console.warn(`[panel-island] Glass in the overview, Isle's own way used: ${e}`);
            clearScenes(this);
            return sync.call(this);
        }
        return undefined;
    };
    target._windowPlaces = function () {
        // Isle's glass, placed anew (it looks at the windows again then): its part of a shared copy kept under it.
        if (!isOurs(this))
            followShared(this);
        try {
            know(this);
            const ours = isOurs(this);
            // The overview draws the windows itself (in its copy): not the windows too, or each shows twice.
            if (inOverview() && (ours || isleDoes.overview)) {
                this._overrides = [];
                return [];
            }
            const all = places.call(this);
            // Lighter: only the windows under the glass itself. One only in the blur's margin (a maximised window
            // just below the bar) is left out: what it draws, a video, never has the glass blurred again for it.
            // Ours: under its body, its corner flares left out: a flare down the screen's side follows a window's
            // corner at a gap (Match window corners), so the window under its outline is never under the glass.
            const area = this._panelIslandBody ?? this._rect;
            if ((ours || isleDoes.lighter) && area && Array.isArray(all))
                return all.filter(place => meets(place, area));
            return all;
        } catch (e) {
            console.warn(`[panel-island] Glass in the overview, Isle's own way used: ${e}`);
        }
        return places.call(this);
    };

    return () => {
        for (const [name, descriptor] of [['_syncVisible', before.sync], ['_windowPlaces', before.places]]) {
            if (descriptor)
                Object.defineProperty(target, name, descriptor);
            else
                delete target[name];
        }
        // Those it was on as Isle has them: no scene copies left in them, shown or hidden Isle's own way.
        for (const backdrop of [...known]) {
            // Ours have a wrap of their own (on them, not their class): left as they are when Isle's comes off.
            const isleOnly = target.isPrototypeOf?.(backdrop) && !Object.hasOwn(backdrop, '_syncVisible');
            if (backdrop === target || isleOnly) {
                known.delete(backdrop);
                clearScenes(backdrop);
                try {
                    backdrop._syncVisible?.();
                } catch {}
            }
        }
    };
}

/** Lets go of everything (this extension going): every scene copy out, nothing followed. */
export function releaseOverview() {
    unwatchSwitches();
    unwatchPower();
    isleDoes.overview = isleDoes.lighter = false;
    for (const backdrop of known)
        clearScenes(backdrop);
    known.clear();
    closeShared();
    switchListeners.clear();
}
