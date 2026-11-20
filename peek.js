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
import Meta from 'gi://Meta';
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
/** How far the previews part either side of a gap a window is dragged into, for its plus, in CSS px; and the plus's
 * size. */
const PART = 16;
/** How long the pointer rests on a preview before its windows spread apart, in ms. */
const SPREAD_DWELL_MS = 300;
const PLUS = 28;
/** The glass's corners round the previews, in CSS px. */
const RADIUS = 18;
/** How often the pointer is looked for while it is open, in ms, and how near the glass still counts as on it. */
const LEAVE_CHECK_MS = 60;
const LEAVE_SLACK = 6;

const scale = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;
const animating = () => St.Settings.get().enable_animations;
/** The pointer's stage position, [x, y] alone (`global.get_pointer` also gives the buttons held). */
const pointer = () => global.get_pointer().slice(0, 2);

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
        // Where each workspace's preview was, to move from.
        const was = new Map(items.map(({workspace, item}) => [workspace, old.x + item.x]));
        this._content = null;
        this._items = [];
        const box = rest ? this._build(rest) : null;
        if (!box) {
            this._dropContent(old, items);
            this.close(true, 'it could not be laid out anew');
            return;
        }
        this._content.opacity = 255;
        const glass = this._host.glass;
        const to = this._host.openShape(box);
        if (!animating()) {
            this._dropContent(old, items);
            glass.retarget(to);
            return;
        }
        // Alive, not rebuilt: the glass grows or shrinks to fit; each preview still there slides from where it was;
        // a new workspace's grows in; one gone fades and shrinks away where it was.
        glass.animate(glass.rect ?? to, to, {ms: 340, ease: t => 1 - (1 - t) ** 3});
        const slide = {duration: 340, mode: Clutter.AnimationMode.EASE_OUT_CUBIC};
        const kept = new Set();
        for (const {workspace, item} of this._items) {
            if (was.has(workspace)) {
                kept.add(workspace);
                item.translation_x = was.get(workspace) - (this._content.x + item.x);
                item.ease({translation_x: 0, ...slide});
            } else {
                item.set({opacity: 0, scale_x: 0.6, scale_y: 0.6});
                item.ease({opacity: 255, scale_x: 1, scale_y: 1, delay: 120, duration: 320,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK});
            }
        }
        // The old previews: those kept hidden at once (their new ones slide), those gone fading out.
        old.reactive = false;
        for (const {workspace, item} of items) {
            if (kept.has(workspace))
                item.opacity = 0;
            else
                item.ease({opacity: 0, scale_x: 0.6, scale_y: 0.6, duration: 240, mode: Clutter.AnimationMode.EASE_IN_QUAD});
        }
        old.get_children().forEach(child => {
            if (!items.some(({item}) => item === child))
                child.opacity = 0;
        });
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 280, () => {
            this._dropContent(old, items, false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _dropContent(content, items, current = true) {
        if (current && this._refresh) {
            GLib.source_remove(this._refresh);
            this._refresh = 0;
        }
        items.forEach(entry => {
            entry.workspace.disconnectObject(content);
            entry.background.destroy();
            if (entry.dwell)
                GLib.source_remove(entry.dwell);
            entry.dwell = 0;
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
        const pad = PAD * s, spacing = SPACING * s, margin = MARGIN * s, part = PART * s;
        // Room at the sides for the previews to part into (a plus before the first one).
        const padX = pad + part;
        // As wide as it fits on the screen: smaller previews with many workspaces.
        const room = monitor.width - 2 * margin - 2 * padX - (n - 1) * spacing;
        const width = Math.max(48 * s, Math.min(THUMB_WIDTH * s, room / n));
        const k = width / workArea.width;
        const height = workArea.height * k;
        const contentWidth = 2 * padX + n * width + (n - 1) * spacing;
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
                x: Math.round(padX + i * (width + spacing)), y: Math.round(pad),
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
                handleDragOver: (source, actor, _x, _y, time) => this._gapUnderPointer() !== null
                    ? this._gapDragOver(source)
                    : source?.metaWindow
                        ? DND.DragMotionResult.MOVE_DROP
                        : entry.thumbnail.handleDragOverInternal(source, actor, time),
                acceptDrop: (source, actor, _x, _y, time) => this._gapUnderPointer() !== null
                    ? this._dropInGap(source, this._gapUnderPointer(), actor)
                    : source?.metaWindow
                        ? this.dropWindow(source.metaWindow, ...pointer(), actor)
                        : entry.thumbnail.acceptDropInternal(source, actor, time),
            };
            // Lifted a little under the pointer; resting there a moment, its windows spread apart (`_spread`).
            item.connect('notify::hover', () => {
                item.ease({
                    scale_x: item.hover ? 1.04 : 1, scale_y: item.hover ? 1.04 : 1,
                    duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                if (entry.dwell)
                    GLib.source_remove(entry.dwell);
                entry.dwell = 0;
                if (!item.hover) {
                    this._spread(entry, false);
                    return;
                }
                entry.dwell = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPREAD_DWELL_MS, () => {
                    entry.dwell = 0;
                    if (item.hover && !this._busyDragging())
                        this._spread(entry, true);
                    return GLib.SOURCE_REMOVE;
                });
            });
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
            workspace.connectObject('window-added', () => this._queueRefresh(workspace),
                'window-removed', () => this._queueRefresh(workspace), this._content);
        }
        // The gaps a dragged window or app can be let go in, for a new workspace there: before the first preview and
        // between each two (after the last, GNOME's dynamic workspaces keep an empty one already). Each gets a plus
        // that grows as something is dragged into it, the previews parting round it.
        this._gaps = [];
        if (Meta.prefs_get_dynamic_workspaces()) {
            for (let g = 0; g < n; g++) {
                const centre = padX + g * (width + spacing) - spacing / 2;
                const plus = new St.Widget({
                    style_class: 'panel-island-peek-plus', width: Math.round(PLUS * s), height: Math.round(PLUS * s),
                    x: Math.round(centre - PLUS * s / 2), y: Math.round(pad + height / 2 - PLUS * s / 2),
                    opacity: 0, scale_x: 0.3, scale_y: 0.3, pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
                    layout_manager: new Clutter.BinLayout(),
                });
                plus.add_child(new St.Icon({icon_name: 'list-add-symbolic', style_class: 'panel-island-peek-plus-icon',
                    x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
                this._content.add_child(plus);
                // Where it counts as in the gap: its middle, reaching a little into the previews either side.
                this._gaps.push({index: g, plus, from: centre - spacing / 2 - part, to: centre + spacing / 2 + part,
                    top: pad, bottom: pad + height});
            }
        }
        this._hotGap = null;
        // A drop on the glass between previews (not on one): into the gap there, if any.
        this._content._delegate = {
            handleDragOver: source => this._gapUnderPointer() !== null
                ? this._gapDragOver(source) : DND.DragMotionResult.CONTINUE,
            acceptDrop: (source, actor) => this._gapUnderPointer() !== null &&
                this._dropInGap(source, this._gapUnderPointer(), actor),
        };
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
    _thumbnail(entry, fade = false) {
        const old = entry.thumbnail;
        const thumbnail = new WorkspaceThumbnail(entry.workspace, entry.monitorIndex);
        thumbnail.setScale(entry.k, entry.k);
        thumbnail.set_size(entry.width, entry.height);
        entry.item.insert_child_above(thumbnail, old ?? entry.wallpaper);
        entry.thumbnail = thumbnail;
        // A window dragged out of it and let go on a preview is not flown back where it came from (GNOME's own
        // drag puts it back, then it vanishes): it settles into its new place instead (`_settle`).
        // A click on a window in it goes to that window itself (not only its workspace).
        const unrestored = actor => {
            if (actor?._draggable)
                actor._draggable._restoreOnSuccess = false;
            if (actor?.metaWindow && !actor._panelIslandPick) {
                actor._panelIslandPick = true;
                actor.connect('selected', () => {
                    this._pickedAt = Date.now();
                    Main.activateWindow(actor.metaWindow);
                    this.close(false, 'a window was picked');
                });
            }
        };
        thumbnail._contents?.get_children().forEach(unrestored);
        thumbnail._contents?.connect('child-added', (_contents, actor) => {
            unrestored(actor);
            if (entry.spread)
                this._spread(entry, true, false);
        });
        if (entry.spread)
            this._spread(entry, true, false);
        if (!old)
            return;
        // Made anew: the new one fades in over the old, which then goes.
        if (!fade || !animating()) {
            old.destroy();
            return;
        }
        thumbnail.opacity = 0;
        thumbnail.ease({opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => old.destroy()});
    }

    /** `entry`'s windows spread apart in its preview (`on`), so one hidden behind another can be taken too: laid out
     * in a grid, each as big as its cell lets it be, in the order they stand from left to right; or put back where they
     * really are. Only their copies move: the windows themselves stay. */
    _spread(entry, on, animate = true) {
        entry.spread = on;
        const clones = (entry.thumbnail?._windows ?? []).filter(clone => !clone.inDrag && clone.get_parent());
        const ease = (clone, to) => {
            clone.set_pivot_point(0, 0);
            if (animate && animating())
                clone.ease({...to, duration: 240, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                clone.set(to);
        };
        if (!on || clones.length < 2) {
            clones.forEach(clone => ease(clone, {translation_x: 0, translation_y: 0, scale_x: 1, scale_y: 1}));
            return;
        }
        const area = entry.workArea;
        const n = clones.length;
        const cols = Math.ceil(Math.sqrt(n * area.width / area.height / 1.6));
        const rows = Math.ceil(n / cols);
        const m = area.width * 0.04;
        const cellW = (area.width - m * (cols + 1)) / cols, cellH = (area.height - m * (rows + 1)) / rows;
        [...clones].sort((a, b) => (a.x + a.width / 2) - (b.x + b.width / 2)).forEach((clone, i) => {
            const col = i % cols, row = Math.floor(i / cols);
            const k = Math.min(1, cellW / Math.max(1, clone.width), cellH / Math.max(1, clone.height));
            const x = area.x + m + col * (cellW + m) + (cellW - clone.width * k) / 2;
            const y = area.y + m + row * (cellH + m) + (cellH - clone.height * k) / 2;
            ease(clone, {translation_x: x - clone.x, translation_y: y - clone.y, scale_x: k, scale_y: k});
        });
    }

    /** A copy of `window` from where `from` (what was dragged) is, gliding into place: to the stage point and scale
     * `to` ({x, y, scale}), or, with none, shrinking away where it is. */
    _settle(window, from, to) {
        const source = window?.get_compositor_private();
        if (!source || !(from instanceof Clutter.Actor) || !this._content || !animating())
            return;
        const [fx, fy] = from.get_transformed_position();
        const [fw] = from.get_transformed_size();
        const clone = new Clutter.Clone({source, reactive: false});
        const k0 = fw / Math.max(1, source.width);
        const [cx, cy] = this._content.get_transformed_position();
        clone.set_position(fx - cx, fy - cy);
        clone.set_scale(k0, k0);
        this._content.add_child(clone);
        const done = () => clone.destroy();
        if (to) {
            clone.ease({x: to.x - cx, y: to.y - cy, scale_x: to.scale, scale_y: to.scale, duration: 280,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: () => clone.ease({opacity: 0, duration: 160,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: done})});
        } else {
            clone.set_pivot_point(0.5, 0.5);
            clone.ease({opacity: 0, scale_x: k0 * 0.3, scale_y: k0 * 0.3, duration: 240,
                mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: done});
        }
    }

    /** Every preview made anew, once its windows have settled. */
    /** The previews of `workspace` (or with none, only which one is shown) made anew, once its windows have settled:
     * only those whose windows changed, not all of them. */
    _queueRefresh(workspace = null) {
        if (!this._open)
            return;
        this._stale ??= new Set();
        if (workspace)
            this._stale.add(workspace);
        if (this._refresh)
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
            const stale = this._stale;
            this._stale = new Set();
            this._items.forEach(entry => {
                if (stale.has(entry.workspace))
                    this._thumbnail(entry, true);
                entry.workspace.active
                    ? entry.frame.add_style_class_name('panel-island-peek-current')
                    : entry.frame.remove_style_class_name('panel-island-peek-current');
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    /** `window` let go at the stage point `x`, `y`: on a preview, it goes to that workspace (if not on it already),
     * centred on the place in it the point stands for. Returns whether it was on one. */
    dropWindow(window, x, y, dragged = null) {
        const gap = this.gapAt(x, y);
        if (gap !== null)
            return this._dropInGap({metaWindow: window}, gap, dragged);
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
            // What was dragged glides to where the window now is in this preview: only a look, so never in the way
            // of the move itself.
            try {
                const actor = window.get_compositor_private();
                if (actor && dragged) {
                    const ax = nx + (actor.x - rect.x), ay = ny + (actor.y - rect.y);
                    const point = entry.item.apply_transform_to_point(
                        new Graphene.Point3D({x: (ax - area.x) * entry.k, y: (ay - area.y) * entry.k, z: 0}));
                    this._settle(window, dragged, {x: point.x, y: point.y, scale: entry.k * entry.item.scale_x});
                }
            } catch (e) {
                console.warn(`[panel-island] A dropped window did not glide into place: ${e}`);
            }
        }
        // Its own workspace's preview made anew too (the copy dragged out of it is gone, even if the window stayed).
        const from = window.get_workspace();
        if (from?.index() !== i)
            Main.moveWindowToMonitorAndWorkspace(window, entry.monitorIndex, i);
        if (from)
            this._queueRefresh(from);
        this._queueRefresh(entry.workspace);
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

    /** The workspace whose preview is at the stage point `x`, `y` (not in a gap between them), or null. */
    indexAt(x, y) {
        if (this.gapAt(x, y) !== null)
            return null;
        const i = this._items.findIndex(({item}) => within(item, x, y));
        return i < 0 ? null : i;
    }

    /** The gap (the index a new workspace would have) at the stage point `x`, `y`, or null. */
    gapAt(x, y) {
        if (!this._open || !this._content || !this._gaps?.length)
            return null;
        const [ok, lx, ly] = this._content.transform_stage_point(x, y);
        if (!ok)
            return null;
        const gap = this._gaps.find(g => lx >= g.from && lx <= g.to && ly >= g.top && ly <= g.bottom);
        return gap ? gap.index : null;
    }

    _gapUnderPointer() {
        return this.gapAt(...pointer());
    }

    /** What a drag's `source` would do let go in a gap: a window or an app that can open one go to a new workspace. */
    _gapDragOver(source) {
        if (source?.metaWindow)
            return DND.DragMotionResult.MOVE_DROP;
        if (source?.app?.can_open_new_window?.())
            return DND.DragMotionResult.COPY_DROP;
        return DND.DragMotionResult.CONTINUE;
    }

    /** A drag's `source` let go in the gap `index`: a new workspace made there (GNOME's own, as the overview makes
     * one), the window moved to it or the app opened on it. Returns whether it was taken. */
    _dropInGap(source, index, dragged = null) {
        const window = source?.metaWindow;
        const app = window ? null : source?.app;
        if (!window && !app?.can_open_new_window?.())
            return false;
        // What was dragged shrinks into the plus; the new workspace grows in as the previews are laid out anew.
        try {
            if (window)
                this._settle(window, dragged, null);
        } catch (e) {
            console.warn(`[panel-island] A dropped window did not shrink away: ${e}`);
        }
        this.setHotGap(null);
        Main.wm.insertWorkspace(index);
        if (window)
            Main.moveWindowToMonitorAndWorkspace(window, this._items[0]?.monitorIndex ?? window.get_monitor(), index);
        else
            app.open_new_window(index);
        return true;
    }

    /** The gap a dragged window or app is in (`index`): its plus grown, the previews parted round it; or none. */
    setHotGap(index) {
        if (this._hotGap === index || !this._content)
            return;
        this._hotGap = index;
        const part = PART * scale();
        const ease = {duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
        this._items.forEach(({item}, i) => item.ease({
            ...ease, translation_x: index === null ? 0 : i >= index ? part : -part,
        }));
        this._gaps.forEach(({index: g, plus}) => plus.ease(g === index
            ? {opacity: 255, scale_x: 1, scale_y: 1, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_BACK}
            : {opacity: 0, scale_x: 0.3, scale_y: 0.3, ...ease}));
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
            // Something dragged into a gap: its plus shown (any drag: a preview's window, an app, a carried one).
            this.setHotGap(dragging ? this.gapAt(px, py) : null);
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
