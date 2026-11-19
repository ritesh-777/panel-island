// SPDX-License-Identifier: GPL-3.0-or-later
//
// The weather on Isle's Calendar page, as Isle's own feature/calendar-weather branch made it: a chip beside the day
// (its sky and temperature), and, clicked, the day's weather in full in place of the events (a sky that moves, how
// it feels, its hours). For GNOME Weather's place, from GNOME Shell's own weather client (weather.js).
//
// Done to Isle's own code as it runs, never to its files. Each place the branch changed Isle's CalendarPage is a wrap
// of that one method here, doing what the branch added around Isle's own: the chip and the view are added to a page
// as it is first drawn, kept in `_panelIslandWeather` (nothing of Isle's own changed). Put on only if Isle's page still
// has every method and part this reaches; a page missing any is left as Isle has it, and any failure takes the
// weather off that page. Taken off, every page is as Isle draws it again.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Weather from './weather.js';

/** GNOME's weather is asked for again at most this often (ms): each ask downloads it anew. */
const WEATHER_REFRESH_MS = 10 * 60 * 1000;

/** The methods wrapped (each must be Isle's page's own), and the parts of a page the weather is put beside. */
const METHODS = ['_setShowingWorld', '_syncWorld', '_syncListShown', '_setPicking', '_renderDayHeader', 'onActivate',
    'onDeactivate'];
/** Isle's page height, standard (expanded.js PAGE_HEIGHT): taller is Isle's Large (Settings → Size). */
const STANDARD_HEIGHT = 150;
/** Hours shown: fewer and larger on a large page, filling its room (in place of an empty band below). */
const HOURS = 7;
const LARGE_HOURS = 6;
const PARTS = ['_dayName', '_worldScroll', '_entry', '_worldStrip', '_noEvents', '_scroll', '_selected'];

/** The pages given the weather, alive; and those it failed on (left out until it is turned off and on). */
const pages = new Set();
const failedPages = new Set();
/** Isle's helpers ({label, VERTICAL, Format}), as given to `addIsleWeather`. */
let isle = null;

const label = (text, styleClass, params = {}) => isle.label(text, styleClass, params);

/** The weather's part of `page`, made as it is first drawn with all its parts; null before that (tried again as it
 * is next drawn), and for a page it failed on (left as Isle has it, `_panelIslandWeatherFailed`). */
function weatherOf(page) {
    if (page._panelIslandWeather)
        return page._panelIslandWeather;
    if (page._panelIslandWeatherFailed)
        return null;
    // Not built yet (Isle drawing it as it makes it): later.
    if (!PARTS.every(name => page[name]) || !page._dayName.get_parent?.() || !page._worldScroll.get_parent?.())
        return null;
    try {
        const w = build(page);
        page._panelIslandWeather = w;
        pages.add(page);
        page.connectObject?.('destroy', () => {
            pages.delete(page);
            w.client?.disconnectObject?.(page);
        }, page);
        return w;
    } catch (e) {
        console.warn(`[panel-island] Weather on Isle's Calendar page left out: ${e}`);
        page._panelIslandWeatherFailed = true;
        failedPages.add(page);
        return null;
    }
}

/** The chip in the day's header beside its name, and the full view among the lists (as the branch builds them). */
function build(page) {
    const VERTICAL = isle.VERTICAL;
    const w = {showing: false, asked: 0, last: null, shown: null, syncing: false};
    w.client = Weather.shellClient();
    // The day's sky and temperature (now, for today); a click shows the day's weather in full.
    w.button = new St.Button({style_class: 'isle-cal-weather', can_focus: true, toggle_mode: true, visible: false,
        y_align: Clutter.ActorAlign.CENTER});
    const box = new St.BoxLayout({style_class: 'isle-cal-weather-box'});
    w.icon = new St.Icon({style_class: 'isle-cal-weather-icon', y_align: Clutter.ActorAlign.CENTER});
    w.temp = label('', 'isle-cal-weather-temp', {y_align: Clutter.ActorAlign.CENTER});
    box.add_child(w.icon);
    box.add_child(w.temp);
    w.button.set_child(box);
    w.button.connect('clicked', () => guard(page, () => setShowing(page, !w.showing)));
    page._dayName.get_parent().insert_child_above(w.button, page._dayName);

    // The day's weather in full: its sky and temperature, how it feels, and its hours.
    w.view = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-weather-view', x_expand: true, y_expand: true,
        visible: false});
    const top = new St.BoxLayout({style_class: 'isle-cal-weather-top'});
    w.sky = new Weather.Sky();
    top.add_child(w.sky);
    const now = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    w.big = label('', 'isle-cal-weather-big');
    w.summary = label('', 'isle-cal-weather-summary');
    w.summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    now.add_child(w.big);
    now.add_child(w.summary);
    top.add_child(now);
    w.details = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-weather-details', y_align: Clutter.ActorAlign.CENTER});
    top.add_child(w.details);
    w.view.add_child(top);
    w.hours = new St.BoxLayout({style_class: 'isle-cal-weather-hours', x_expand: true});
    w.view.add_child(w.hours);
    page._worldScroll.get_parent().add_child(w.view);

    w.client?.connectObject?.('changed', () => guard(page, () => sync(page)), page);
    return w;
}

/** Whether `page` is Isle's Large size (taller than standard). */
const largeOf = page => (page.pageHeight ?? STANDARD_HEIGHT) > STANDARD_HEIGHT;

/** The view laid out for the page's height: larger, its hours filling the room, on Isle's Large. */
function syncSize(page) {
    const w = page._panelIslandWeather;
    if (!w)
        return;
    const large = largeOf(page);
    if (large === w.large)
        return;
    w.large = large;
    for (const actor of [w.view, w.button])
        large ? actor.add_style_class_name?.('panel-island-weather-large') : actor.remove_style_class_name?.('panel-island-weather-large');
    // Large: the row of hours takes the room left below, its cards as tall.
    w.hours.y_expand = large;
    w.shown = null;
}

/** Runs `step` for `page`'s weather; failing, takes the weather off that page (Isle's own goes on as it is). */
function guard(page, step) {
    try {
        return step();
    } catch (e) {
        console.warn(`[panel-island] Weather taken off Isle's Calendar page: ${e}`);
        remove(page);
        page._panelIslandWeatherFailed = true;
        failedPages.add(page);
        return undefined;
    }
}

/** Swaps the events for the day's weather, or back; the chip follows (the branch's `_setShowingWeather`). */
function setShowing(page, showing) {
    const w = page._panelIslandWeather;
    if (!w || showing === w.showing)
        return;
    if (showing) {
        page._setPicking(false);
        page._setShowingWorld(false);
        page._stopAdding?.();
    }
    w.showing = showing;
    w.button.checked = showing;
    page._entry.visible = !showing;
    w.view.visible = showing;
    page._worldStrip.visible = !showing && (page._cities?.length ?? 0) > 0;
    sync(page);
    page._syncListShown();
}

/** Asks GNOME Shell's client for the weather again, unless lately; its answer comes as `changed`. */
function refresh(page) {
    const w = page._panelIslandWeather;
    if (!w || Date.now() - w.asked < WEATHER_REFRESH_MS)
        return;
    w.asked = Date.now();
    w.client?.update?.();
}

/** The chip and, while shown, the full view for the picked day (the branch's `_syncWeather`): hidden without its
 * weather (GNOME Weather missing or without a place, still loading, a day past or beyond the forecast), or while
 * picking a calendar. */
function sync(page) {
    const w = page._panelIslandWeather;
    if (!w || w.syncing)
        return;
    w.syncing = true;
    try {
        const client = w.client;
        const known = client?.available && client.hasLocation;
        const selected = page._selected.getTime();
        // Mid-refresh: the same day's weather as last known, until the new one comes.
        syncSize(page);
        const hourCount = w.large ? LARGE_HOURS : HOURS;
        const day = !known ? null : Weather.ready(client.info)
            ? Weather.dayWeather(client.info, page._selected, new Date(), hourCount)
            : w.last?.selected === selected ? w.last.day : null;
        w.last = day && {selected, day};
        w.button.visible = !!day && !page._picking;
        if (!day) {
            if (w.showing)
                setShowing(page, false);
            return;
        }
        w.icon.icon_name = day.icon;
        w.temp.text = `${day.temp}°`;
        w.button.accessible_name = `Weather: ${day.summary}, ${day.temp}°`;
        if (!w.showing) {
            w.sky.stop();
            return;
        }
        // Drawn again only when it changed: the calendars answer often with the same.
        const Format = isle.Format;
        const shown = JSON.stringify([day, Format.uses12Hour?.(), w.large]);
        if (shown !== w.shown) {
            w.shown = shown;
            w.sky.iconName = day.icon;
            w.big.text = `${day.temp}°`;
            // Where, its sky, and the day's high and low: "New Delhi  ·  Clear  ·  ↑27° ↓18°".
            w.summary.text = [day.place, day.summary, `↑${day.high}° ↓${day.low}°`].filter(Boolean).join('  ·  ');
            w.details.destroy_all_children();
            for (const text of day.details)
                w.details.add_child(label(text, 'isle-cal-weather-detail'));
            w.hours.destroy_all_children();
            for (const hour of day.hours) {
                const cell = new St.BoxLayout({...isle.VERTICAL, style_class: 'isle-cal-weather-hour', x_expand: true,
                    y_expand: w.large});
                // Its hour, sky and temperature (and, on a large page, its wind), together in the card's middle: a
                // card taller than they are leaves its room even above and below, not all of it under them.
                const content = new St.BoxLayout({...isle.VERTICAL, style_class: 'isle-cal-weather-hour-content',
                    x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
                content.add_child(label(Format.timeOfDay(GLib.DateTime.new_from_unix_local(hour.time / 1000)),
                    'isle-cal-weather-hour-time', {x_align: Clutter.ActorAlign.CENTER}));
                content.add_child(new St.Icon({icon_name: hour.icon, style_class: 'isle-cal-weather-hour-icon',
                    x_align: Clutter.ActorAlign.CENTER}));
                content.add_child(label(`${hour.temp}°`, 'isle-cal-weather-hour-temp', {x_align: Clutter.ActorAlign.CENTER}));
                if (w.large && hour.wind)
                    content.add_child(label(hour.wind, 'isle-cal-weather-hour-wind', {x_align: Clutter.ActorAlign.CENTER}));
                cell.add_child(content);
                w.hours.add_child(cell);
            }
        }
        // Started once: a reload of the same weather must not restart it.
        if (!page.active)
            w.sky.stop();
        else if (!w.sky.playing)
            w.sky.play();
    } finally {
        w.syncing = false;
    }
}

/** The weather off `page`: its chip and view gone, the page as Isle draws it. */
function remove(page) {
    const w = page._panelIslandWeather;
    page._panelIslandWeather = null;
    pages.delete(page);
    if (!w)
        return;
    try {
        w.client?.disconnectObject?.(page);
        w.sky?.stop?.();
        w.button?.destroy();
        w.view?.destroy();
    } catch {}
    try {
        // What the weather hid, back as Isle has it.
        page._entry.visible = !page._picking && !page._showingWorld;
        page._worldStrip.visible = !page._picking && !page._showingWorld && (page._cities?.length ?? 0) > 0;
        page._syncListShown();
    } catch {}
}

/**
 * Adds the weather to Isle's Calendar page: `CalendarPage` (Isle's class, its pages/calendar.js), `helpers` Isle's
 * own {label (widgets.js), VERTICAL (compat.js), Format (format.js)}. Returns how to take it off again, or null when
 * Isle's page has not every method this wraps (nothing done then).
 */
export function addIsleWeather(CalendarPage, helpers) {
    const proto = CalendarPage?.prototype;
    if (!proto || !METHODS.every(name => typeof proto[name] === 'function'))
        return null;
    if (typeof helpers?.label !== 'function' || !helpers.VERTICAL || typeof helpers.Format?.timeOfDay !== 'function')
        return null;
    if (typeof Weather.shellClient !== 'function')
        return null;
    isle = helpers;
    /** The methods wrapped this time (METHODS, and onPageHeight where Isle has it): each given back as it was. */
    const wrapped = [...METHODS];
    const own = Object.fromEntries(METHODS.map(name => [name, Object.getOwnPropertyDescriptor(proto, name)]));
    const isles = Object.fromEntries(METHODS.map(name => [name, proto[name]]));
    // Each Isle's own first or last, as the branch put its lines, then the weather's, guarded.
    const wrap = (name, {before = null, after = null}) => {
        proto[name] = function (...args) {
            if (before)
                guard(this, () => weatherOf(this) && before(this, ...args));
            const result = isles[name].apply(this, args);
            if (after)
                guard(this, () => weatherOf(this) && after(this, ...args));
            return result;
        };
    };
    // The weather and the world clocks share the place of the events: one at a time.
    wrap('_setShowingWorld', {
        before: (page, showing) => showing && setShowing(page, false),
        after: page => {
            if (page._panelIslandWeather?.showing) {
                page._entry.visible = false;
                page._worldStrip.visible = false;
            }
        },
    });
    wrap('_syncWorld', {after: page => page._panelIslandWeather?.showing && (page._worldStrip.visible = false)});
    wrap('_syncListShown', {
        after: page => {
            if (page._panelIslandWeather?.showing) {
                page._noEvents.visible = false;
                page._scroll.visible = false;
            }
        },
    });
    wrap('_setPicking', {before: (page, picking) => picking && setShowing(page, false), after: page => sync(page)});
    wrap('_renderDayHeader', {after: page => sync(page)});
    wrap('onActivate', {after: page => {
        refresh(page);
        sync(page);
    }});
    wrap('onDeactivate', {before: page => page._panelIslandWeather?.sky?.stop?.()});
    // Isle's Size changed (Standard, Large): the weather laid out again for the page's height. Isle 1.7's pages have
    // it; an Isle without it keeps the standard layout.
    if (typeof proto.onPageHeight === 'function') {
        wrapped.push('onPageHeight');
        own.onPageHeight = Object.getOwnPropertyDescriptor(proto, 'onPageHeight');
        isles.onPageHeight = proto.onPageHeight;
        wrap('onPageHeight', {after: page => sync(page)});
    }

    return () => {
        for (const name of wrapped) {
            if (own[name])
                Object.defineProperty(proto, name, own[name]);
            else
                delete proto[name];
        }
        for (const page of [...pages])
            remove(page);
        pages.clear();
        isle = null;
        // Turned on again, a page may be given it anew.
        for (const page of [...failedPages])
            page._panelIslandWeatherFailed = false;
        failedPages.clear();
    };
}
