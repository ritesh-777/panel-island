// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Keep GNOME's Activities button: GNOME's own Activities button (its workspace dots) shown again when
// another extension hides it, such as O-tiling as it shows its workspace numbers in its place. Nothing of the other
// extension is changed: the button is only shown again after it is hidden. Turned off, a button this showed is hidden
// again, as the other extension left it.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Past this many times a second, another extension keeps hiding it: we stop showing it again. */
const MAX_SHOWS_PER_SECOND = 5;

const KEEPER = {};
let button = null;
/** Whether it is shown because of us (not by the shell or the extension that hid it, showing it again itself). */
let shown = false;
let showing = false;
let shows = [];
let yielded = false;
let idle = 0;

function show() {
    idle = 0;
    if (!button || button.visible || yielded)
        return GLib.SOURCE_REMOVE;
    const now = Date.now();
    shows = shows.filter(at => now - at < 1000);
    shows.push(now);
    if (shows.length > MAX_SHOWS_PER_SECOND) {
        yielded = true;
        console.warn("[panel-island] Another extension keeps hiding the Activities button: it is left hidden");
        return GLib.SOURCE_REMOVE;
    }
    showing = true;
    try {
        button.show();
    } finally {
        showing = false;
    }
    shown = true;
    return GLib.SOURCE_REMOVE;
}

/** Keeps GNOME's Activities button shown (`on`), or stops and leaves it as others want it. */
export function keepActivities(on) {
    const current = Main.panel.statusArea?.activities ?? null;
    if (on && current && current === button)
        return;
    // Off, or a new button: the old one as others left it.
    if (button) {
        button.disconnectObject(KEEPER);
        if (shown && button.visible && !on)
            button.hide();
    }
    if (idle)
        GLib.source_remove(idle);
    idle = 0;
    button = null;
    shown = false;
    shows = [];
    yielded = false;
    if (!on || !current)
        return;
    button = current;
    // Shown once the one hiding it is done (not from inside its own `hide`).
    const queue = () => {
        if (button.visible) {
            // Shown by another, not us: turned off, this leaves it shown.
            if (!showing)
                shown = false;
            return;
        }
        if (!idle)
            idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, show);
    };
    button.connectObject('notify::visible', queue, 'destroy', () => {
        if (idle)
            GLib.source_remove(idle);
        idle = 0;
        button = null;
        shown = false;
    }, KEEPER);
    queue();
}
