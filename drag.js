// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Drag to workspaces: a window moved by its title bar, or an app icon dragged from the dock or a menu, held
// over the left capsule opens the workspace peek (peek.js). Let go on a workspace's preview or on its number
// (numbers.js), a window moves to that workspace; an app opens a new window there.
//
// A window moved by its title bar is the compositor's own move, which tiling extensions (O-tiling, Ubuntu's Tiling
// Assistant) follow too, showing where it would tile. Once the pointer is inside the open peek, the peek takes the drag
// over: the compositor's move is cancelled as Esc cancels it (the window goes back where it was, and the tiling
// extensions see their drag end there, untiled), and the window is carried on as a small copy under the pointer, the
// pointer held by the peek alone until it is let go. An app icon's drag is the shell's own: the previews and numbers
// take its drop themselves; this opens the peek under it and keeps what is dragged drawn above the peek.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {moveToWorkspace} from './numbers.js';

/** How often the pointer is looked at while a window is moved, in ms. */
const POLL_MS = 40;
/** An app icon's drag counts as going on this long after its last motion, in ms. */
const DRAG_GONE_MS = 600;
/** The copy carried under the pointer: its longest side, in CSS px. */
const CARRY_SIZE = 160;
/** How long the compositor's move is given to end after Esc, in ms, before the take-over is given up. */
const CANCEL_WAIT_MS = 400;

const scale = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

export class DragToWorkspaces {
    /**
     * `host`: `overPill(x, y)` (on the left capsule), `overPeek(x, y)` (on the open peek's previews), `targetAt(x, y)`
     * (the workspace index at a point: a number or a preview, or null), `setHot(index)` (mark it), `openPeek()`,
     * `closePeek()`, `peekShown()`, `delay()` (ms), `dropWindow(window, x, y)` (a carried window let go there).
     */
    constructor(host) {
        this._host = host;
        this._enabled = false;
        this._window = null;
        this._from = null;
        this._poll = 0;
        this._restingSince = 0;
        this._lastMotion = 0;
        this._taking = null;
        this._takeTimer = 0;
        this._carry = null;
        this._monitor = {dragMotion: event => this._dragMotion(event)};
        this._keyboard = null;
        this._cornerHeld = false;
        this._dndTimer = 0;
    }

    /** GNOME's hot corner (top left, beside the left capsule) kept from opening the overview while something is
     * dragged up to the capsule: its pressure trigger fires even during a window's move. Held only while a drag lasts,
     * so a click on Activities still opens the overview. Asked as the overview asks itself (an own property over its
     * method, taken off again). */
    _syncCorner() {
        const want = this._enabled && this.active;
        if (want === this._cornerHeld)
            return;
        this._cornerHeld = want;
        const overview = Main.overview;
        if (want)
            overview.shouldToggleByCornerOrButton = () => false;
        else if (Object.hasOwn(overview, 'shouldToggleByCornerOrButton'))
            delete overview.shouldToggleByCornerOrButton;
    }

    /** Whether a window or an app icon is being dragged now (the peek then stays open under it). */
    get active() {
        return Boolean(this._window || this._taking || this._carry) || Date.now() - this._lastMotion < DRAG_GONE_MS;
    }

    set enabled(on) {
        if (on === this._enabled)
            return;
        this._enabled = on;
        if (on) {
            global.display.connectObject('grab-op-begin', (_display, window, op) => this._begin(window, op),
                'grab-op-end', (_display, window) => this._end(window), this);
            DND.addDragMonitor(this._monitor);
        } else {
            global.display.disconnectObject(this);
            DND.removeDragMonitor(this._monitor);
            this._stop();
            this._dropCarry(false);
            if (this._dndTimer)
                GLib.source_remove(this._dndTimer);
            this._dndTimer = 0;
            this._lastMotion = 0;
        }
        this._syncCorner();
    }

    /** A window's move by the pointer begins: the pointer followed. */
    _begin(window, op) {
        if (!window || (op !== Meta.GrabOp.MOVING && op !== Meta.GrabOp.MOVING_UNCONSTRAINED) || this._carry)
            return;
        this._stop();
        this._window = window;
        const rect = window.get_frame_rect();
        this._from = {x: rect.x, y: rect.y};
        this._restingSince = 0;
        this._poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            const [x, y] = global.get_pointer();
            this._follow(x, y);
            return GLib.SOURCE_CONTINUE;
        });
        this._syncCorner();
    }

    /** Over the left capsule long enough, the peek opens; inside it, it takes the drag over. */
    _follow(x, y) {
        if (this._taking)
            return;
        if (this._host.peekShown() && this._host.overPeek(x, y)) {
            this._takeOver(this._window);
            return;
        }
        if (this._host.overPill(x, y) && !this._host.peekShown()) {
            this._restingSince ||= Date.now();
            if (Date.now() - this._restingSince >= this._host.delay())
                this._host.openPeek();
        } else {
            this._restingSince = 0;
        }
        this._host.setHot(this._host.targetAt(x, y));
    }

    /** The compositor's move cancelled (as Esc does), to be carried on by the peek as it ends (`_end`). */
    _takeOver(window) {
        this._taking = window;
        try {
            this._keyboard ??= global.stage.context.get_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const time = GLib.get_monotonic_time();
            this._keyboard.notify_keyval(time, Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
            this._keyboard.notify_keyval(time + 1000, Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        } catch (e) {
            console.warn(`[panel-island] The window's move could not be taken over: ${e}`);
            this._taking = null;
            return;
        }
        // Not ended: the move goes on as the compositor's, let go as it is.
        this._takeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CANCEL_WAIT_MS, () => {
            this._takeTimer = 0;
            this._taking = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    /** The compositor's move ends: taken over, the peek carries it on; let go on a workspace, it goes there. */
    _end(window) {
        if (!this._window || window !== this._window)
            return;
        const taken = this._taking === window;
        const [x, y] = global.get_pointer();
        const index = taken ? null : this._host.targetAt(x, y);
        const from = this._from;
        this._stop();
        if (taken) {
            this._carryOn(window);
            return;
        }
        if (index === null)
            return;
        // Let go on a number in the bar: once the compositor is done with the move, back where it was on the screen.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (window.get_compositor_private()) {
                window.move_frame(true, from.x, from.y);
                moveToWorkspace(window, index);
            }
            this._host.closePeek('a window was dropped on a number');
            return GLib.SOURCE_REMOVE;
        });
    }

    _stop() {
        if (this._poll)
            GLib.source_remove(this._poll);
        this._poll = 0;
        if (this._takeTimer)
            GLib.source_remove(this._takeTimer);
        this._takeTimer = 0;
        this._taking = null;
        this._window = null;
        this._from = null;
        this._restingSince = 0;
        this._host.setHot(null);
        this._syncCorner();
    }

    /** The window carried on as a small copy under the pointer, the pointer the peek's alone until let go. */
    _carryOn(window) {
        const actor = window.get_compositor_private();
        if (!actor)
            return;
        const rect = window.get_frame_rect();
        const k = Math.min(1, CARRY_SIZE * scale() / Math.max(rect.width, rect.height, 1));
        const clone = new Clutter.Clone({source: actor, reactive: true, opacity: 230, scale_x: k, scale_y: k});
        // Held by its middle, a little below the pointer.
        const offset = {x: actor.width * k / 2, y: 12 * scale()};
        const place = (x, y) => clone.set_position(Math.round(x - offset.x), Math.round(y - offset.y));
        Main.uiGroup.add_child(clone);
        Main.uiGroup.set_child_above_sibling(clone, null);
        place(...global.get_pointer());
        const grab = Main.pushModal(clone, {actionMode: 0});
        this._carry = {window, clone, grab};
        this._syncCorner();
        clone.connect('motion-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            place(x, y);
            this._host.setHot(this._host.targetAt(x, y));
            return Clutter.EVENT_STOP;
        });
        clone.connect('button-release-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            this._dropCarry(true, x, y);
            return Clutter.EVENT_STOP;
        });
        clone.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape)
                this._dropCarry(false);
            return Clutter.EVENT_STOP;
        });
        // The button already up (let go as the move was cancelled): dropped where it is.
        const [, , mods] = global.get_pointer();
        if (!(mods & Clutter.ModifierType.BUTTON1_MASK))
            this._dropCarry(true, ...global.get_pointer());
    }

    /** Lets the carried window go: where it is let go (`apply`, at `x`, `y`: on a preview, onto that workspace there;
     * on a number, onto that workspace), or nowhere. */
    _dropCarry(apply, x = 0, y = 0) {
        const carry = this._carry;
        if (!carry)
            return;
        this._carry = null;
        this._host.setHot(null);
        Main.popModal(carry.grab);
        carry.clone.destroy();
        if (apply && carry.window.get_compositor_private())
            this._host.dropWindow(carry.window, x, y);
        this._syncCorner();
    }

    /** An app icon (or a window from the peek) dragged by the shell: the peek opens under it over the left capsule,
     * and what is dragged is kept drawn above the peek. */
    _dragMotion(event) {
        if (!this._enabled)
            return DND.DragMotionResult.CONTINUE;
        this._lastMotion = Date.now();
        // Held while it lasts: let go once it has been still this long (a drag that ends).
        this._syncCorner();
        if (this._dndTimer)
            GLib.source_remove(this._dndTimer);
        this._dndTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAG_GONE_MS + 50, () => {
            this._dndTimer = 0;
            this._syncCorner();
            return GLib.SOURCE_REMOVE;
        });
        const dragged = event.dragActor;
        if (dragged?.get_parent() === Main.uiGroup)
            Main.uiGroup.set_child_above_sibling(dragged, null);
        if (this._host.overPill(event.x, event.y) && !this._host.peekShown()) {
            this._restingSince ||= Date.now();
            if (Date.now() - this._restingSince >= this._host.delay())
                this._host.openPeek();
        } else if (!this._window) {
            this._restingSince = 0;
        }
        return DND.DragMotionResult.CONTINUE;
    }

    destroy() {
        this.enabled = false;
        this._keyboard?.run_dispose();
        this._keyboard = null;
    }
}
