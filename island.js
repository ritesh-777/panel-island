// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Panel Island's glass for another extension's own panel (Island Menu's launcher): `global.panel_island`. Handed an
// actor, the left capsule grows down round it into one piece of glass, as a menu of the bar opens out of it, follows
// it as it moves or resizes, and shrinks back into the capsule as it closes. The other extension keeps its panel as
// its own (what it shows, its keys, its clicks); this only draws the glass under it.
//
//   global.panel_island?.leftRect()   the left capsule's shape {x, y, width, height}, or null (none shown)
//   global.panel_island?.panelRect?.() the shape of the capsule a panel opens from (Settings: the left or the middle
//                                     one), with `centre` true for the middle one (then centre the panel under it)
//   global.panel_island?.setFrom?.(side) the capsule the next panel opens from, as the other extension's own setting
//                                     says: 'left' or 'centre' (the middle one, while it is shown; else the left);
//                                     null: as Panel Island's own setting (Island Menu opens from)
//   global.panel_island?.open(actor, {light})  the glass grown round `actor`, light or dark as asked (else as the
//                                     capsules are); false if it cannot be (then draw your own)
//   global.panel_island?.isLight()    whether the capsules are light now
//   global.panel_island?.close()      shrunk back into the capsule
//   global.panel_island?.atBottom?.() whether the bar is at the bottom (Settings → Bar at the bottom): a panel then
//                                     opens above the capsule, its glass growing up round it

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {atBottom} from './barPosition.js';

const RADIUS = 18;

const scale = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

export class IslandService {
    /**
     * `host`: `glass` (a menu's glass, `Morph`, for this alone), `restRect()` (the left capsule's shape, or null),
     * `openShape(rect)` (the shape grown down round `rect`), `hold(on)` (the capsule's own glass hidden while this is
     * drawn), `opening()` and `closing()` ({ms, ease}), `closePeek()`.
     */
    constructor(host) {
        this._host = host;
        this._actor = null;
        this._later = 0;
        this.api = {
            version: 1,
            leftRect: () => {
                const rect = this._host.leftRect?.() ?? this._host.restRect();
                return rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null;
            },
            panelRect: () => {
                const rect = this._host.restRect();
                const capsule = this._host.capsule?.();
                return rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                    centre: Boolean(capsule && capsule.box === Main.panel._centerBox)} : null;
            },
            setFrom: side => this._host.setFrom?.(side),
            open: (actor, options = {}) => this.open(actor, options),
            isLight: () => Boolean(this._host.isLight?.()),
            close: () => this.close(),
            isOpen: () => Boolean(this._actor),
            atBottom: () => atBottom(),
        };
        global.panel_island = this.api;
    }

    get shown() {
        return Boolean(this._actor);
    }

    /** The shape round `actor` where it is now, or null (not on screen). */
    _target(actor) {
        if (!actor?.mapped)
            return null;
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        if (width <= 0 || height <= 0)
            return null;
        return this._host.openShape({x, y, width, height, radius: RADIUS * scale()});
    }

    open(actor, {light = null} = {}) {
        if (!(actor instanceof Clutter.Actor))
            return false;
        this._host.setLight?.(light);
        if (this._actor === actor)
            return true;
        const rest = this._host.restRect();
        if (!rest)
            return false;
        this._host.closePeek();
        this._unwatch();
        this._actor = actor;
        const glass = this._host.glass;
        const {ms, ease} = this._host.opening();
        glass.animate(glass.shown && glass.rect ? glass.rect : rest, this._target(actor) ?? rest,
            {ms, ease, target: () => this._actor === actor ? this._target(actor) : null, reveal: actor});
        this._host.hold(true);
        // Its size and place followed (results filling in, a scroll, its own opening motion).
        const follow = () => this._queueFollow();
        actor.connectObject('notify::allocation', follow, 'notify::translation-y', follow, 'notify::scale-y', follow,
            'notify::visible', () => !actor.visible && this.close(), 'destroy', () => this.close(true), this);
        return true;
    }

    _queueFollow() {
        if (this._later || !this._actor)
            return;
        this._later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._later = 0;
            const to = this._target(this._actor);
            if (to)
                this._host.glass.retarget(to);
            return false;
        });
    }

    _unwatch() {
        this._actor?.disconnectObject(this);
        if (this._later)
            global.compositor.get_laters().remove(this._later);
        this._later = 0;
    }

    /** Shrinks the glass back into the capsule, or (`now`) takes it away at once. */
    close(now = false) {
        if (!this._actor)
            return;
        this._unwatch();
        this._actor = null;
        const glass = this._host.glass;
        const rest = this._host.restRect();
        const done = () => {
            if (this._actor)
                return;
            this._host.hold(false);
            glass.hide();
            // The left capsule as the capsules are again.
            this._host.setLight?.(null);
        };
        if (now || !rest || !glass.rect) {
            done();
            return;
        }
        const {ms, ease} = this._host.closing();
        glass.animate(glass.rect, rest, {ms, ease, target: () => this._host.restRect(), onDone: done});
    }

    destroy() {
        this.close(true);
        if (global.panel_island === this.api)
            delete global.panel_island;
    }
}
