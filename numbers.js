// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Workspace numbers: Panel Island's own workspace buttons in the left capsule, one per workspace, needing no
// other extension. The one shown is filled in the accent colour, ones holding windows brighter than empty ones, one
// wanting attention ringed in the accent colour. A click goes there. Each is a drop target: a window (from the peek, or
// moved by its title bar onto it, drag.js) moves to that workspace, an app icon opens a new window there.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

/** Its name in the bar's status area; "workspace" in it makes it a trigger of the workspace peek too (peek.js). */
export const NUMBERS_NAME = 'panel-island-workspaces';

/** Whether `workspace` holds a window one would see in the overview. */
const occupied = workspace => workspace.list_windows().some(window => !window.skip_taskbar && !window.is_on_all_workspaces());

/** Whether the stage point `x`, `y` is within `actor`. */
function within(actor, x, y) {
    if (!actor?.mapped)
        return false;
    const [ax, ay] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return x >= ax && x <= ax + w && y >= ay && y <= ay + h;
}

/** Moves `window` to the workspace at `index` on the monitor it is on, as the overview's drop does. */
export function moveToWorkspace(window, index) {
    if (window.get_workspace()?.index() === index)
        return false;
    Main.moveWindowToMonitorAndWorkspace(window, window.get_monitor(), index);
    return true;
}

/** What a drag's `source` does dropped on the workspace at `index`: a window moves there, an app opens there. */
export function dropOn(source, index, apply) {
    const window = source?.metaWindow;
    if (window) {
        if (window.get_workspace()?.index() === index)
            return apply ? false : DND.DragMotionResult.NO_DROP;
        return apply ? moveToWorkspace(window, index) : DND.DragMotionResult.MOVE_DROP;
    }
    const app = source?.app;
    if (app?.can_open_new_window?.()) {
        if (apply)
            app.open_new_window(index);
        return apply ? true : DND.DragMotionResult.COPY_DROP;
    }
    return apply ? false : DND.DragMotionResult.CONTINUE;
}

export class WorkspaceNumbers {
    /** `urgent()`: the indexes of the workspaces wanting attention. */
    constructor(urgent) {
        this._urgent = urgent;
        this._button = null;
        this._box = null;
        this._numbers = [];
        this._hot = null;
        this._watched = [];
    }

    get shown() {
        return Boolean(this._button);
    }

    set enabled(on) {
        if (on === this.shown)
            return;
        if (!on) {
            this._unwatch();
            global.workspace_manager.disconnectObject(this);
            this._button.destroy();
            this._button = this._box = null;
            this._numbers = [];
            return;
        }
        this._button = new PanelMenu.Button(0.0, 'Workspaces', true);
        this._button.add_style_class_name('panel-island-ws-button');
        this._box = new St.BoxLayout({style_class: 'panel-island-ws', y_align: Clutter.ActorAlign.CENTER});
        this._button.add_child(this._box);
        // Just after GNOME's Activities button, at the start of the left side.
        Main.panel.addToStatusArea(NUMBERS_NAME, this._button, 1, 'left');
        global.workspace_manager.connectObject('notify::n-workspaces', () => this._build(),
            'active-workspace-changed', () => this._sync(), 'workspaces-reordered', () => this._build(), this);
        this._button.connect('destroy', () => {
            this._unwatch();
            global.workspace_manager.disconnectObject(this);
            this._button = this._box = null;
            this._numbers = [];
        });
        this._build();
    }

    _unwatch() {
        this._watched.forEach(workspace => workspace.disconnectObject(this));
        this._watched = [];
    }

    /** One button per workspace, made anew as workspaces come and go. */
    _build() {
        if (!this._box)
            return;
        this._unwatch();
        this._box.destroy_all_children();
        this._numbers = [];
        const manager = global.workspace_manager;
        for (let i = 0; i < manager.n_workspaces; i++) {
            const workspace = manager.get_workspace_by_index(i);
            const number = new St.Button({
                style_class: 'panel-island-ws-number', label: `${i + 1}`,
                y_align: Clutter.ActorAlign.CENTER, can_focus: true,
            });
            number.connect('clicked', () => workspace.activate(global.get_current_time()));
            number._delegate = {
                handleDragOver: source => dropOn(source, i, false),
                acceptDrop: source => dropOn(source, i, true),
            };
            this._box.add_child(number);
            this._numbers.push(number);
            workspace.connectObject('window-added', () => this._sync(), 'window-removed', () => this._sync(), this);
            this._watched.push(workspace);
        }
        this._sync();
    }

    /** Each button's look: shown, holding windows, wanting attention, under a window being dragged. */
    _sync() {
        const manager = global.workspace_manager;
        const urgent = this._urgent();
        this._numbers.forEach((number, i) => {
            const workspace = manager.get_workspace_by_index(i);
            if (!workspace)
                return;
            const set = (name, on) => on ? number.add_style_class_name(name) : number.remove_style_class_name(name);
            set('panel-island-ws-current', workspace.active);
            set('panel-island-ws-occupied', occupied(workspace));
            set('panel-island-ws-urgent', urgent.has(i));
            set('panel-island-ws-hot', this._hot === i);
        });
    }

    /** The workspaces wanting attention changed. */
    setUrgent() {
        this._sync();
    }

    /** The workspace whose button is at the stage point `x`, `y`, or null. */
    indexAt(x, y) {
        const i = this._numbers.findIndex(number => within(number, x, y));
        return i < 0 ? null : i;
    }

    /** Marks the button a dragged window would go to (`index`), or none. */
    setHot(index) {
        if (this._hot === index)
            return;
        this._hot = index;
        this._sync();
    }

    destroy() {
        this.enabled = false;
    }
}
