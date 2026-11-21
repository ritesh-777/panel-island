// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// The left capsule's workspace glass, lent to Island Menu, whose workspace features (its peek, numbers, drag to
// workspaces and attention glow) grow out of it: `global.panel_island.workspaces`. Panel Island draws the glass and
// the glow; Island Menu says what goes in it and when. Either can start first: Panel Island tells Island Menu it is
// there (`global.island_menu_workspaces.panelIslandReady()`) and gone (`panelIslandGone()`), and Island Menu looks for it as it
// starts.
//
//   glass                 a glass of its own: animate(from, to, {ms, ease, target, onDone}), retarget(rect), hide(),
//                         rect, shown
//   restRect()            the left capsule's shape, or null (none shown)
//   openShape(rect)       the shape grown down round `rect`
//   hold(on)              the capsule's own glass hidden while the glass is drawn
//   busy()                whether a menu or another panel has the capsule now
//   opening(), closing()  {ms, ease}, as Panel Island's menus open and close
//   closeDelay()          Panel Island's Close delay, in ms
//   setAttention(glow)    the capsule's edge lit ({width, pulse}) or put out (null)
//   strength()            the glass's strength now, 0 clear to 100 strong (Island Menu told as it changes:
//                         `global.island_menu_workspaces.lookChanged()`)
//   setLight(light)       the glass, and the left capsule's text while it is open, light (true) or dark (false), as
//                         Island Menu's own Style says; null: as Panel Island's capsules are
//   attach(client)        the one whose peek it is: {shown, close(now, why), watchTriggers()}; detach(client)

export class WorkspaceGlass {
    /** `host`: what Panel Island lends (see above), `setAttention` taking the glow without its colour. */
    constructor(host) {
        this._host = host;
        this._client = null;
        const glass = host.glass;
        this.api = {
            version: 1,
            glass: {
                animate: (...args) => glass.animate(...args),
                retarget: rect => glass.retarget(rect),
                hide: () => glass.hide(),
                get rect() {
                    return glass.rect;
                },
                get shown() {
                    return glass.shown;
                },
            },
            restRect: () => host.restRect(),
            openShape: rect => host.openShape(rect),
            hold: on => host.hold(on),
            busy: () => host.busy(),
            opening: () => host.opening(),
            closing: () => host.closing(),
            closeDelay: () => host.closeDelay(),
            setAttention: glow => host.setAttention(glow),
            setLight: light => host.setLight(light),
            // The glass's strength now (0 clear to 100 strong), for what Island Menu draws on it (its numbers' shade).
            strength: () => host.strength?.() ?? 50,
            attach: client => {
                this._client = client;
            },
            detach: client => {
                if (this._client === client)
                    this._client = null;
            },
        };
    }

    /** Whether the peek is open on it. */
    get shown() {
        return Boolean(this._client?.shown);
    }

    /** The peek closed (a menu or another panel takes the capsule). */
    close(now = false, why = '') {
        try {
            this._client?.close(now, why);
        } catch (e) {
            console.warn(`[panel-island] Island Menu's workspace peek did not close: ${e}`);
        }
    }

    /** The bar's buttons changed: the peek looks for its triggers again. */
    watchTriggers() {
        try {
            this._client?.watchTriggers?.();
        } catch (e) {
            console.warn(`[panel-island] Island Menu's workspace peek did not follow the bar: ${e}`);
        }
    }

    /** Island Menu told it is there. */
    announce() {
        try {
            global.island_menu_workspaces?.panelIslandReady?.();
        } catch (e) {
            console.warn(`[panel-island] Island Menu not told: ${e}`);
        }
    }

    destroy() {
        try {
            global.island_menu_workspaces?.panelIslandGone?.();
        } catch (e) {
            console.warn(`[panel-island] Island Menu not told: ${e}`);
        }
        this._client = null;
        this._host.setAttention(null);
    }
}
