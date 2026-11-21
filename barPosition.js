// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Bar at the bottom: GNOME's top bar moved to the bottom of the main display. GNOME puts it back at the top
// whenever the displays change (layout.js `_updateBoxes`), so that is followed by moving it down again; its height
// changing (Isle's compact bar coming and going) moves it too. The rest GNOME does itself: the space windows keep
// free (its strut) goes to the bottom edge from where the bar is, and the bar's menus open upwards (they are told to
// at once, not after a first frame placed below). The pointer stop at the bar's right end is moved down with it.
// Isle sees the bar leave the top and hangs its island from the screen's top on its own, as on a display with no
// bar. Changed only on GNOME's own layout manager and the bar's menus, as the shell runs; all put back when off.

import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

let state = null;

/** Whether the bar is at the bottom (the setting on, and it could be done). */
export function atBottom() {
    return state !== null;
}

/** The bar moved to the bottom, or back to the top. Returns whether it is where asked. */
export function setBarAtBottom(on) {
    if (on === atBottom())
        return true;
    if (!on) {
        undo();
        return true;
    }
    const layout = Main.layoutManager;
    const menus = Main.panel?.menuManager;
    if (!layout?.panelBox || typeof layout._updateBoxes !== 'function' ||
        typeof layout._updatePanelBarrier !== 'function' || typeof menus?.addMenu !== 'function') {
        console.warn('[panel-island] GNOME\'s layout has changed: the bar stays at the top');
        return false;
    }
    try {
        apply(layout, menus);
        return true;
    } catch (e) {
        console.warn(`[panel-island] The bar could not be moved to the bottom, left at the top: ${e}`);
        undo();
        return false;
    }
}

function apply(layout, menus) {
    const box = layout.panelBox;
    state = {
        layout, menus,
        saved: Object.fromEntries(['_updateBoxes', '_updatePanelBarrier'].map(name =>
            [name, Object.getOwnPropertyDescriptor(layout, name) ?? null])),
        savedAdd: Object.getOwnPropertyDescriptor(menus, 'addMenu') ?? null,
        flipped: new Set(),
        token: {},
    };
    const updateBoxes = layout._updateBoxes, updateBarrier = layout._updatePanelBarrier, addMenu = menus.addMenu;

    layout._updateBoxes = function (...args) {
        const result = updateBoxes.apply(this, args);
        place();
        return result;
    };
    layout._updatePanelBarrier = function (...args) {
        const result = updateBarrier.apply(this, args);
        moveBarrier();
        return result;
    };
    menus.addMenu = function (menu, ...args) {
        const result = addMenu.call(this, menu, ...args);
        openUpwards(menu);
        return result;
    };
    // Only when its height really changes, not on each relayout: moving it reallocates it.
    box.connectObject('notify::height', () => place(), state.token);

    for (const menu of menus._menus ?? [])
        openUpwards(menu);
    place();
    layout._updatePanelBarrier();
}

/** The bar's top so its bottom is the main display's. */
function place() {
    if (!state)
        return;
    const {layout} = state;
    const monitor = layout.primaryMonitor, box = layout.panelBox;
    if (!monitor || !box)
        return;
    const y = monitor.y + monitor.height - box.height;
    if (box.y !== y)
        box.y = y;
}

/** GNOME's stop for the pointer at the bar's right end, made for the top: at the bar's height from the bottom. */
function moveBarrier() {
    if (!state)
        return;
    const {layout} = state;
    const barrier = layout._rightPanelBarrier;
    const monitor = layout.primaryMonitor, height = layout.panelBox?.height ?? 0;
    if (!(barrier instanceof Meta.Barrier) || !monitor || height <= 0)
        return;
    const bottom = monitor.y + monitor.height;
    if (barrier.y1 === bottom - height && barrier.y2 === bottom)
        return;
    try {
        const moved = new Meta.Barrier({
            backend: global.backend,
            x1: barrier.x1, y1: bottom - height, x2: barrier.x2, y2: bottom,
            directions: barrier.directions,
        });
        barrier.destroy();
        layout._rightPanelBarrier = moved;
    } catch (e) {
        // A pointer stop at the top-right corner is all that is lost.
        console.warn(`[panel-island] The bar's pointer stop left at the top: ${e}`);
    }
}

/** A bar menu made to open below the bar opens above it instead. */
function openUpwards(menu) {
    const pointer = menu?._boxPointer;
    if (!state || typeof pointer?.updateArrowSide !== 'function' || pointer._userArrowSide !== St.Side.TOP)
        return;
    pointer.updateArrowSide(St.Side.BOTTOM);
    state.flipped.add(menu);
}

function restore(object, name, descriptor) {
    if (descriptor)
        Object.defineProperty(object, name, descriptor);
    else
        delete object[name];
}

function undo() {
    if (!state)
        return;
    const {layout, menus, saved, savedAdd, flipped, token} = state;
    state = null;
    try {
        layout.panelBox?.disconnectObject(token);
    } catch {}
    for (const [name, descriptor] of Object.entries(saved))
        restore(layout, name, descriptor);
    restore(menus, 'addMenu', savedAdd);
    for (const menu of flipped) {
        try {
            if (menu._boxPointer?._userArrowSide === St.Side.BOTTOM)
                menu._boxPointer.updateArrowSide(St.Side.TOP);
        } catch {}
    }
    flipped.clear();
    // Back where GNOME puts it, its pointer stop with it.
    try {
        layout._updateBoxes();
        layout._updatePanelBarrier();
    } catch (e) {
        console.warn(`[panel-island] The bar could not be put back at the top until the displays change: ${e}`);
    }
}
