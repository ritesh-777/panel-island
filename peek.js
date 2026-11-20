// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Workspace peek: the pointer resting on the left capsule's workspace buttons (GNOME's Activities button,
// another extension's workspace numbers) grows the capsule down into glass holding a live preview of each workspace,
// as a menu opens out of it. A click on one goes there; a window dragged from one preview to another moves there.
// It closes as the pointer leaves it (not while something is dragged over it), as a workspace is picked, or as the
// overview or a menu opens. A window moved by its title bar or an app icon held over the capsule opens it too
// (drag.js).
//
// The previews are GNOME's own, the overview's workspace thumbnails (ui/workspaceThumbnail.js), each over the
// wallpaper; made as it opens and destroyed as it closes, so nothing of it runs while it is closed.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
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
     * ({ms, ease}), `delay()` and `closeDelay()` (ms), `urgent()` (the indexes of workspaces wanting attention),
     * `dragging()` (a window or an app icon being dragged: it stays open).
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
        this._refresh = 0;
        this._pickedAt = 0;
        this._dragEndedAt = 0;
        this._rebuildTimer = 0;
    }

    set enabled(on) {
        this._enabled = on;
        if (on) {
            const dragEnded = () => {
                this._dragging = false;
                this._dragEndedAt = Date.now();
            };
            Main.overview.connectObject('showing', () => this.close(true, 'the overview opened'),
                'window-drag-begin', () => (this._dragging = true),
                'window-drag-end', dragEnded, 'window-drag-cancelled', dragEnded, this);
            // Gone to another workspace: by a click on its preview, the peek has done its job; during a drag (a window
            // put somewhere, an app opened), it stays as long as the pointer does, its previews made anew.
            // Gone to another workspace by a click on its preview: the peek has done its job. Any other way (a drag,
            // dynamic workspaces moving the active one), it stays as long as the pointer does, its previews made anew.
            global.workspace_manager.connectObject('active-workspace-changed', () => {
                if (Date.now() - this._pickedAt < 1000)
                    this.close(false, 'a workspace was picked');
                else
                    this._queueRefresh();
            }, 'notify::n-workspaces', () => this._rebuild(), this);
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
        const rest = this._host.restRect();
        const box = rest ? this._build(rest) : null;
        if (!box)
            return;
        this._open = true;
        const {ms, ease} = this._host.opening();
        // From where its glass is (still closing), else from the capsule.
        const glass = this._host.glass;
        glass.animate(glass.shown && glass.rect ? glass.rect : rest, this._host.openShape(box), {ms, ease});
        this._host.hold(true);
        this._content.ease({opacity: 255, duration: Math.round(ms * 0.55), delay: Math.round(ms * 0.3),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._startLeaveWatch();
    }

    /** Workspaces added or taken away while it is open (GNOME's dynamic workspaces, as a workspace empties or the
     * last one fills): its previews laid out anew in place, its glass moved to fit, without closing. */
    _rebuild() {
        if (!this._open)
            return;
        // Not under a drag still going on (its dragged copy goes back into a preview as it ends): once it is over.
        if (this._busyDragging()) {
            this._rebuildTimer ||= GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this._rebuildTimer = 0;
                this._rebuild();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        const rest = this._host.restRect();
        const old = this._content, items = this._items;
        this._content = null;
        this._items = [];
        this._dropContent(old, items);
        const box = rest ? this._build(rest) : null;
        if (!box) {
            this.close(true, 'it could not be laid out anew');
            return;
        }
        this._content.opacity = 255;
        this._host.glass.retarget(this._host.openShape(box));
    }

    _dropContent(content, items) {
        if (this._refresh)
            GLib.source_remove(this._refresh);
        this._refresh = 0;
        items.forEach(({workspace, background}) => {
            workspace.disconnectObject(content);
            background.destroy();
        });
        Main.layoutManager.removeChrome(content);
        content.destroy();
    }

    /** The previews made under the capsule at `rest`; returns the box they fill (for the glass round them). */
    _build(rest) {
        const monitor = Main.layoutManager.findMonitorForActor(Main.panel) ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return null;
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
                track_hover: true, pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
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
            const entry = {item, wallpaper, background, workspace, monitorIndex: monitor.index, k, workArea,
                width: Math.round(width), height: Math.round(height), thumbnail: null, frame: null};
            this._thumbnail(entry);
            const frame = new St.Widget({
                style_class: 'panel-island-peek-frame', width: Math.round(width), height: Math.round(height),
            });
            if (workspace.active)
                frame.add_style_class_name('panel-island-peek-current');
            if (urgent.has(i))
                frame.add_style_class_name('panel-island-peek-urgent');
            item.add_child(frame);
            // A window dragged over a preview moves to that workspace, as onto the overview's.
            // A window dragged from a preview goes where it is let go on this one: onto this workspace (its own too,
            // moved there); an app opens a new window here, as onto the overview's.
            item._delegate = {
                handleDragOver: (source, actor, _x, _y, time) => source?.metaWindow
                    ? DND.DragMotionResult.MOVE_DROP
                    : entry.thumbnail.handleDragOverInternal(source, actor, time),
                acceptDrop: (source, actor, _x, _y, time) => source?.metaWindow
                    ? this.dropWindow(source.metaWindow, ...global.get_pointer())
                    : entry.thumbnail.acceptDropInternal(source, actor, time),
            };
            // Lifted a little under the pointer.
            item.connect('notify::hover', () => item.ease({
                scale_x: item.hover ? 1.04 : 1, scale_y: item.hover ? 1.04 : 1,
                duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }));
            // A click goes there (and the peek has done its job), but not the click that ends a drag onto it.
            const click = new Clutter.ClickGesture();
            click.connect('recognize', () => {
                if (this._dragging || this._host.dragging?.() || Date.now() - this._dragEndedAt < 400)
                    return;
                if (workspace.active) {
                    this.close(false, 'the shown workspace was clicked');
                } else {
                    this._pickedAt = Date.now();
                    workspace.activate(global.get_current_time());
                }
            });
            item.add_action(click);
            this._content.add_child(item);
            entry.frame = frame;
            this._items.push(entry);
            // A window coming or going (moved here or away, opened, closed): its preview made anew.
            workspace.connectObject('window-added', () => this._queueRefresh(),
                'window-removed', () => this._queueRefresh(), this._content);
        }
        Main.layoutManager.addTopChrome(this._content);
        return {x, y, width: contentWidth, height: contentHeight, radius: RADIUS * s};
    }

    /** Marks the workspaces wanting attention (`urgent`, a set of indexes) while it is open. */
    setUrgent(urgent) {
        this._items.forEach(({frame}, i) => urgent.has(i)
            ? frame.add_style_class_name('panel-island-peek-urgent')
            : frame.remove_style_class_name('panel-island-peek-urgent'));
    }

    /** `entry`'s live preview of its workspace's windows (GNOME's own), over its wallpaper, under its frame. */
    _thumbnail(entry) {
        entry.thumbnail?.destroy();
        const thumbnail = new WorkspaceThumbnail(entry.workspace, entry.monitorIndex);
        thumbnail.setScale(entry.k, entry.k);
        thumbnail.set_size(entry.width, entry.height);
        entry.item.insert_child_above(thumbnail, entry.wallpaper);
        entry.thumbnail = thumbnail;
    }

    /** Every preview made anew, once its windows have settled. */
    _queueRefresh() {
        if (this._refresh || !this._open)
            return;
        this._refresh = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            if (!this._open) {
                this._refresh = 0;
                return GLib.SOURCE_REMOVE;
            }
            // Once a drag going on is over (see `_rebuild`).
            if (this._busyDragging())
                return GLib.SOURCE_CONTINUE;
            this._refresh = 0;
            this._items.forEach(entry => {
                this._thumbnail(entry);
                entry.workspace.active
                    ? entry.frame.add_style_class_name('panel-island-peek-current')
                    : entry.frame.remove_style_class_name('panel-island-peek-current');
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    /** `window` let go at the stage point `x`, `y`: on a preview, it goes to that workspace (if not on it already),
     * centred on the place in it the point stands for. Returns whether it was on one. */
    dropWindow(window, x, y) {
        const i = this.indexAt(x, y);
        if (i === null)
            return false;
        const entry = this._items[i];
        const [ok, lx, ly] = entry.item.transform_stage_point(x, y);
        if (ok) {
            const area = entry.workArea;
            const rect = window.get_frame_rect();
            const cx = area.x + lx / entry.k, cy = area.y + ly / entry.k;
            const nx = Math.round(Math.max(area.x, Math.min(cx - rect.width / 2, area.x + area.width - rect.width)));
            const ny = Math.round(Math.max(area.y, Math.min(cy - rect.height / 2, area.y + area.height - rect.height)));
            // Maximized, it would not move: made a normal window first (GNOME 51: no flags).
            if (window.is_maximized?.())
                window.unmaximize();
            window.move_frame(true, nx, ny);
        }
        if (window.get_workspace()?.index() !== i)
            Main.moveWindowToMonitorAndWorkspace(window, entry.monitorIndex, i);
        this._queueRefresh();
        return true;
    }

    /** Whether something is being dragged now, or was let go a moment ago (its copy going back). */
    _busyDragging() {
        return this._dragging || Boolean(this._host.dragging?.()) || Date.now() - this._dragEndedAt < 350;
    }

    /** Whether the stage point `x`, `y` is on its previews. */
    contains(x, y) {
        return this._open && within(this._content, x, y);
    }

    /** The workspace whose preview is at the stage point `x`, `y`, or null. */
    indexAt(x, y) {
        const i = this._items.findIndex(({item}) => within(item, x, y));
        return i < 0 ? null : i;
    }

    /** Marks the preview a dragged window would go to (`index`), or none. */
    setHot(index) {
        this._items.forEach(({frame}, i) => i === index
            ? frame.add_style_class_name('panel-island-peek-hot')
            : frame.remove_style_class_name('panel-island-peek-hot'));
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
            const dragging = this._dragging || this._host.dragging?.();
            if (onGlass || onButton || dragging || within(this._content, px, py, slack)) {
                this._away = 0;
            } else {
                this._away += LEAVE_CHECK_MS;
                if (this._away >= this._host.closeDelay()) {
                    this._leaveTimer = 0;
                    this.close(false, 'the pointer left');
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
    /** `_why`: what closed it (said where it is called, for whoever reads the code). */
    close(now = false, _why = '') {
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
        this._pickedAt = 0;
        if (this._rebuildTimer)
            GLib.source_remove(this._rebuildTimer);
        this._rebuildTimer = 0;
        const destroy = () => this._dropContent(content, items);
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
