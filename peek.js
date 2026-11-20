// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Workspace peek: the pointer resting on the left capsule's workspace buttons (GNOME's Activities button,
// another extension's workspace numbers) grows the capsule down into glass holding a live preview of each workspace,
// as a menu opens out of it. A click on one goes there; a window dragged from one preview to another moves there.
// It closes as the pointer leaves it, as a workspace is picked, or as the overview or a menu opens.
//
// The previews are GNOME's own, the overview's workspace thumbnails (ui/workspaceThumbnail.js), each over the
// wallpaper; made as it opens and destroyed as it closes, so nothing of it runs while it is closed.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceThumbnail} from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

/** A preview's width, its padding round them all and the room between them, in CSS px. */
const THUMB_WIDTH = 168;
const PAD = 12;
const SPACING = 10;
/** Room kept between the previews and the screen's sides, in CSS px. */
const MARGIN = 12;
/** The glass's corners round the previews, in CSS px. */
const RADIUS = 18;
/** How often the pointer is looked for while it is open, in ms, and how near the glass still counts as on it. */
const LEAVE_CHECK_MS = 60;
const LEAVE_SLACK = 6;

const scale = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

/** Whether the stage point `x`, `y` is within `actor` grown by `slack` on each side. */
function within(actor, x, y, slack = 0) {
    if (!actor?.mapped)
        return false;
    const [ax, ay] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return x >= ax - slack && x <= ax + w + slack && y >= ay - slack && y <= ay + h + slack;
}

export class Peek {
    /**
     * `host` gives what the extension has: `glass` (a menu's glass, `Morph`, for the peek alone), `restRect()` (the
     * left capsule's shape), `openShape(rect)` (the shape grown down round `rect`), `hold(on)` (the capsule's own glass
     * hidden while this is drawn), `busy()` (a menu of the bar open on glass), `opening()` ({ms, ease}), `closing()`
     * ({ms, ease}), `delay()` and `closeDelay()` (ms), `urgent()` (the indexes of workspaces wanting attention).
     */
    constructor(host) {
        this._host = host;
        this._triggers = new Set();
        this._content = null;
        this._items = [];
        this._open = false;
        this._dragging = false;
        this._enabled = false;
        this._openTimer = 0;
        this._leaveTimer = 0;
        this._away = 0;
    }

    set enabled(on) {
        this._enabled = on;
        if (on) {
            Main.overview.connectObject('showing', () => this.close(true),
                'window-drag-begin', () => (this._dragging = true),
                'window-drag-end', () => (this._dragging = false),
                'window-drag-cancelled', () => (this._dragging = false), this);
            global.workspace_manager.connectObject('active-workspace-changed', () => this.close(),
                'notify::n-workspaces', () => this.close(true), this);
            this.watchTriggers();
        } else {
            this.close(true);
            this._unwatchTriggers();
            Main.overview.disconnectObject(this);
            global.workspace_manager.disconnectObject(this);
        }
    }

    /** The left box's workspace buttons followed: GNOME's Activities button, and any other whose name says workspace. */
    watchTriggers() {
        if (!this._enabled)
            return;
        const left = Main.panel._leftBox;
        const found = new Set();
        for (const [name, button] of Object.entries(Main.panel.statusArea)) {
            if (!button?.container || button.container.get_parent() !== left)
                continue;
            if (name === 'activities' || /workspace|ws/i.test(name))
                found.add(button);
        }
        for (const button of this._triggers) {
            if (!found.has(button))
                button.disconnectObject(this);
        }
        for (const button of found) {
            if (!this._triggers.has(button)) {
                button.connectObject('notify::hover', () => this._hovered(button),
                    'destroy', () => this._triggers.delete(button), this);
            }
        }
        this._triggers = found;
    }

    _unwatchTriggers() {
        this._triggers.forEach(button => button.disconnectObject(this));
        this._triggers.clear();
        this._cancelOpen();
    }

    _hovered(button) {
        if (!button.hover) {
            this._cancelOpen();
            return;
        }
        if (this._open || this._openTimer || this._host.busy() || Main.overview.visible)
            return;
        this._openTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._host.delay(), () => {
            this._openTimer = 0;
            if (button.hover && !this._host.busy() && !Main.overview.visible)
                this.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelOpen() {
        if (this._openTimer)
            GLib.source_remove(this._openTimer);
        this._openTimer = 0;
    }

    get shown() {
        return this._open;
    }

    /** Builds the previews under the left capsule and grows its glass down round them. */
    open() {
        if (this._open || !this._enabled)
            return;
        const monitor = Main.layoutManager.findMonitorForActor(Main.panel) ?? Main.layoutManager.primaryMonitor;
        const rest = this._host.restRect();
        if (!monitor || !rest)
            return;
        const s = scale();
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const manager = global.workspace_manager;
        const n = manager.n_workspaces;
        const pad = PAD * s, spacing = SPACING * s, margin = MARGIN * s;
        // As wide as it fits on the screen: smaller previews with many workspaces.
        const room = monitor.width - 2 * margin - 2 * pad - (n - 1) * spacing;
        const width = Math.max(48 * s, Math.min(THUMB_WIDTH * s, room / n));
        const k = width / workArea.width;
        const height = workArea.height * k;
        const contentWidth = 2 * pad + n * width + (n - 1) * spacing;
        const contentHeight = 2 * pad + height;
        const x = Math.round(Math.max(monitor.x + margin, Math.min(rest.x, monitor.x + monitor.width - margin - contentWidth)));
        const y = Math.round(rest.y + rest.height + 4 * s);

        this._content = new Clutter.Actor({x, y, width: contentWidth, height: contentHeight, opacity: 0, reactive: true});
        const urgent = this._host.urgent();
        for (let i = 0; i < n; i++) {
            const workspace = manager.get_workspace_by_index(i);
            const item = new St.Widget({
                style_class: 'panel-island-peek-workspace', reactive: true, clip_to_allocation: true,
                x: Math.round(pad + i * (width + spacing)), y: Math.round(pad),
                width: Math.round(width), height: Math.round(height),
            });
            // The wallpaper, as the screen shows it under this workspace's windows.
            const wallpaper = new Clutter.Actor({
                scale_x: k, scale_y: k,
                x: -(workArea.x - monitor.x) * k, y: -(workArea.y - monitor.y) * k,
            });
            item.add_child(wallpaper);
            const background = new Background.BackgroundManager({
                container: wallpaper, monitorIndex: monitor.index, controlPosition: false, vignette: false,
            });
            const thumbnail = new WorkspaceThumbnail(workspace, monitor.index);
            thumbnail.setScale(k, k);
            thumbnail.set_size(Math.round(width), Math.round(height));
            item.add_child(thumbnail);
            const frame = new St.Widget({
                style_class: 'panel-island-peek-frame', width: Math.round(width), height: Math.round(height),
            });
            if (workspace.active)
                frame.add_style_class_name('panel-island-peek-current');
            if (urgent.has(i))
                frame.add_style_class_name('panel-island-peek-urgent');
            item.add_child(frame);
            // A window dragged over a preview moves to that workspace, as onto the overview's.
            item._delegate = {
                handleDragOver: (source, actor, _x, _y, time) => thumbnail.handleDragOverInternal(source, actor, time),
                acceptDrop: (source, actor, _x, _y, time) => thumbnail.acceptDropInternal(source, actor, time),
            };
            const click = new Clutter.ClickGesture();
            click.connect('recognize', () => {
                if (workspace.active)
                    this.close();
                else
                    workspace.activate(global.get_current_time());
            });
            item.add_action(click);
            this._content.add_child(item);
            this._items.push({item, background, thumbnail, frame});
        }
        Main.layoutManager.addTopChrome(this._content);
        this._open = true;

        const box = {x, y, width: contentWidth, height: contentHeight, radius: RADIUS * s};
        const {ms, ease} = this._host.opening();
        // From where its glass is (still closing), else from the capsule.
        const glass = this._host.glass;
        glass.animate(glass.shown && glass.rect ? glass.rect : rest, this._host.openShape(box), {ms, ease});
        this._host.hold(true);
        this._content.ease({opacity: 255, duration: Math.round(ms * 0.55), delay: Math.round(ms * 0.3),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._startLeaveWatch();
    }

    /** Marks the workspaces wanting attention (`urgent`, a set of indexes) while it is open. */
    setUrgent(urgent) {
        this._items.forEach(({frame}, i) => urgent.has(i)
            ? frame.add_style_class_name('panel-island-peek-urgent')
            : frame.remove_style_class_name('panel-island-peek-urgent'));
    }

    _startLeaveWatch() {
        this._stopLeaveWatch();
        this._away = 0;
        this._leaveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_CHECK_MS, () => {
            const [px, py] = global.get_pointer();
            const slack = LEAVE_SLACK * scale();
            const rect = this._host.glass.rect;
            const onGlass = rect && px >= rect.x - slack && px <= rect.x + rect.width + slack &&
                py >= rect.y - slack && py <= rect.y + rect.height + slack;
            const onButton = [...this._triggers].some(button => within(button, px, py, slack));
            if (onGlass || onButton || this._dragging || within(this._content, px, py, slack)) {
                this._away = 0;
            } else {
                this._away += LEAVE_CHECK_MS;
                if (this._away >= this._host.closeDelay()) {
                    this._leaveTimer = 0;
                    this.close();
                    return GLib.SOURCE_REMOVE;
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopLeaveWatch() {
        if (this._leaveTimer)
            GLib.source_remove(this._leaveTimer);
        this._leaveTimer = 0;
    }

    /** Closes it, shrinking its glass back into the capsule, or at once (`now`). */
    close(now = false) {
        this._cancelOpen();
        if (!this._open)
            return;
        this._open = false;
        this._dragging = false;
        this._stopLeaveWatch();
        const content = this._content;
        const items = this._items;
        this._content = null;
        this._items = [];
        const destroy = () => {
            items.forEach(({background}) => background.destroy());
            Main.layoutManager.removeChrome(content);
            content.destroy();
        };
        const glass = this._host.glass;
        const rest = this._host.restRect();
        const done = () => {
            if (this._open)
                return;
            this._host.hold(false);
            glass.hide();
        };
        if (now || !rest || !glass.rect) {
            destroy();
            done();
            return;
        }
        content.reactive = false;
        const {ms, ease} = this._host.closing();
        content.ease({opacity: 0, duration: Math.round(ms * 0.4), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: destroy});
        glass.animate(glass.rect, rest, {ms, ease, target: () => this._host.restRect(), onDone: done});
    }

    destroy() {
        this.enabled = false;
    }
}
