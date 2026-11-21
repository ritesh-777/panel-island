// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Lighter blur updates, for the rest of Isle: two of Isle's own repeating jobs made cheaper, done to Isle as
// it runs and never to its files, each put on only if Isle still has what it changes, and taken off as it was.
//
//  - Its music bars (widgets.js `Bars`), moved by a timer 60 times a second while something plays, each move a redraw
//    of the island: on battery, moved at most 30 times a second. Their motion follows the time gone by, not the ticks,
//    so it keeps its speed, a little less smooth.
//  - Its lyrics (pages/lyrics.js `LyricsPane._scrollTo`), which ease the page to the line sung: not eased when the
//    place to go to is not a number (the island not laid out yet), which Isle would otherwise ease to for every frame
//    of half a second, each frame a warning in the log.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** On battery, the bars moved no more often than this (µs). */
const BATTERY_BARS_US = 33000;

const finite = (...values) => values.every(Number.isFinite);

/**
 * Puts both on (`Bars`: Isle's bars class, `LyricsPane`: its lyrics page; either may be missing). Returns how to take
 * them off, or null if neither could be put on.
 */
export function tuneIsle({Bars, LyricsPane} = {}) {
    const undo = [];

    // On battery or not (UPower), read as it changes; until known, as on mains.
    let onBattery = false;
    let upower = null;
    const cancellable = new Gio.Cancellable();
    Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
        'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower', cancellable,
        (_source, result) => {
            try {
                upower = Gio.DBusProxy.new_for_bus_finish(result);
            } catch {
                return;
            }
            const sync = () => (onBattery = Boolean(upower?.get_cached_property('OnBattery')?.unpack()));
            upower.connect('g-properties-changed', sync);
            sync();
        });
    undo.push(() => {
        cancellable.cancel();
        upower?.run_dispose?.();
        upower = null;
    });

    const bars = Bars?.prototype;
    if (typeof bars?._step === 'function') {
        const saved = Object.getOwnPropertyDescriptor(bars, '_step');
        const step = saved.value;
        bars._step = function (now = GLib.get_monotonic_time()) {
            if (onBattery && now - (this._panelIslandStepAt ?? 0) < BATTERY_BARS_US)
                return undefined;
            this._panelIslandStepAt = now;
            return step.call(this, now);
        };
        undo.push(() => Object.defineProperty(bars, '_step', saved));
    }

    const lyrics = LyricsPane?.prototype;
    if (typeof lyrics?._scrollTo === 'function') {
        const saved = Object.getOwnPropertyDescriptor(lyrics, '_scrollTo');
        const scrollTo = saved.value;
        lyrics._scrollTo = function (index, ...rest) {
            try {
                const target = this._rows?.[Math.max(index, 0)];
                const scroll = this._scroll;
                // Laid out: checked as Isle reads it. Not yet: Isle waits for it itself.
                if (target?.has_allocation?.() && scroll?.has_allocation?.()) {
                    const box = target.get_allocation_box();
                    const parent = target.get_parent()?.get_allocation_box();
                    const adjustment = scroll.vadjustment;
                    if (!parent || !adjustment || !finite(box.y1, box.y2, parent.y1, target.height,
                        adjustment.lower, adjustment.upper, adjustment.page_size))
                        return undefined;
                }
            } catch {
                // Whatever Isle has now: its own way.
            }
            return scrollTo.call(this, index, ...rest);
        };
        undo.push(() => Object.defineProperty(lyrics, '_scrollTo', saved));
    }

    if (undo.length === 1) {
        undo[0]();
        return null;
    }
    return () => undo.reverse().forEach(fn => {
        try {
            fn();
        } catch {}
    });
}
