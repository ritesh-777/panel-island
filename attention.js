// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Attention glow: which workspaces hold a window asking for attention (a chat's new message, a finished
// task), other than the one shown: its window's "demands attention" or "urgent" set. A workspace is let go as its
// windows stop asking (focused, or closed) or as it is gone to.

export class Attention {
    /** `onChange(urgent)`: called with the set of those workspaces' indexes each time it changes. */
    constructor(onChange) {
        this._onChange = onChange;
        this._windows = new Set();
        this._urgent = new Set();
        this._enabled = false;
    }

    /** The indexes of the workspaces wanting attention now. */
    get urgent() {
        return this._urgent;
    }

    set enabled(on) {
        if (on === this._enabled)
            return;
        this._enabled = on;
        if (on) {
            global.display.connectObject('window-demands-attention', (_display, window) => this._add(window),
                'window-marked-urgent', (_display, window) => this._add(window), this);
            global.workspace_manager.connectObject('active-workspace-changed', () => this._sync(), this);
            for (const actor of global.get_window_actors()) {
                const window = actor.meta_window;
                if (window?.demands_attention || window?.urgent)
                    this._add(window);
            }
        } else {
            global.display.disconnectObject(this);
            global.workspace_manager.disconnectObject(this);
            this._windows.forEach(window => window.disconnectObject(this));
            this._windows.clear();
        }
        this._sync();
    }

    _add(window) {
        if (!this._enabled || !window || this._windows.has(window))
            return;
        this._windows.add(window);
        const sync = () => this._sync();
        window.connectObject('notify::demands-attention', sync, 'notify::urgent', sync, 'workspace-changed', sync,
            'unmanaged', () => this._remove(window), this);
        this._sync();
    }

    _remove(window) {
        window.disconnectObject(this);
        this._windows.delete(window);
        this._sync();
    }

    _sync() {
        const active = global.workspace_manager.get_active_workspace();
        const urgent = new Set();
        for (const window of [...this._windows]) {
            const workspace = window.get_workspace();
            if (!(window.demands_attention || window.urgent) || !workspace || workspace === active ||
                window.is_on_all_workspaces()) {
                // Asking no more, or there already: let go.
                window.disconnectObject(this);
                this._windows.delete(window);
                continue;
            }
            urgent.add(workspace.index());
        }
        const changed = urgent.size !== this._urgent.size || [...urgent].some(i => !this._urgent.has(i));
        this._urgent = urgent;
        if (changed)
            this._onChange(urgent);
    }

    destroy() {
        this.enabled = false;
    }
}
