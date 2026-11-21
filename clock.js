// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Clock: a clock of Panel Island's own in the bar, in the left capsule or the middle one: flip digits, or a
// small sun (or moon) on an arc across the day with the time beside it. A bar button of its own, as any indicator, so
// whatever hides or takes GNOME's clock (Top Bar Organizer's hide list, Isle's island holding the time) leaves it be.
// Clicking it opens nothing: it is a clock to read, with the next event and a dot for notifications waiting.
// GNOME's own clock is hidden while it shows
// (Settings), unless something else already hides it. It changes once a minute (GNOME's wall clock), a changed digit
// flipping over; its width stays as it is in between, so its capsule never shifts with the time. Scrolling over it
// shows the date and another place's time for a moment; right click copies the date and time; a moon tells Do Not
// Disturb is on. All taken away when off.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GWeather from 'gi://GWeather?version=4.0';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {shellClient} from './weather.js';

/** How long the date or another place's time shows after a scroll before the time comes back. */
const VIEW_MS = 5000;
/** A digit's flip: down to its edge, then open again with the new one. */
const FLIP_DOWN_MS = 110;
const FLIP_UP_MS = 170;
/** How long "Copied" shows. */
const COPIED_MS = 1400;
/** Golden hour: this long before sunset and after sunrise; blue hour: this long after sunset and before sunrise. */
const GOLDEN_MIN = 45;
const BLUE_MIN = 30;
/** The sun's day without a weather location. */
const DEFAULT_SUNRISE_H = 6, DEFAULT_SUNSET_H = 18;

const SUN_COLOURS = {
    day: {body: [0.98, 0.78, 0.46], arc: null},
    golden: {body: [0.85, 0.35, 0.19], arc: [0.94, 0.62, 0.15]},
    blue: {body: [0.22, 0.54, 0.87], arc: [0.52, 0.72, 0.92]},
    night: {body: [0.71, 0.83, 0.96], arc: [0.71, 0.83, 0.96]},
};

const VIEWS = ['time', 'date', 'zone'];
/** An event's name in the chip, at most this long. */
const EVENT_CHARS = 22;
const DAY_MS = 86400000;

/** Whether `event` lasts whole days (GNOME's calendar marks none as such: from a midnight, a day or more). */
const allDay = event => event.date.getHours() === 0 && event.date.getMinutes() === 0 &&
    event.end - event.date >= DAY_MS - 60000;

/** Its name among the bar's items, one per place: an extension that orders the bar (Top Bar Organizer) keeps each
 * where it was put, rather than moving one placed in the middle back to where the left one was. */
const ROLES = {left: 'panel-island-clock', centre: 'panel-island-clock-centre'};

const animating = () => St.Settings.get().enable_animations;

/** A label never cut short with "…": the bar may give the clock less than it asks for, as GNOME's own clock knows. */
function label(props) {
    const actor = new St.Label(props);
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return actor;
}

export class CapsuleClock {
    /** `settings`: Panel Island's; `onMoved()`: told when the clock comes, goes or moves (the capsules measure again). */
    constructor(settings, onMoved = () => {}) {
        this._settings = settings;
        this._onMoved = onMoved;
        this._dateMenu = Main.panel.statusArea.dateMenu ?? null;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._button = null;
        this._face = null;
        this._place = null;
        this._view = 'time';
        this._viewTimer = 0;
        this._copiedTimer = 0;
        this._copied = false;
        this._hidGnome = false;
        this._token = {};
        this._settings.connectObject('changed', (_s, key) => key.startsWith('clock-') && this._apply(), this._token);
        this._apply();
    }

    _apply() {
        if (!this._settings.get_boolean('clock-enabled')) {
            this._teardown();
            return;
        }
        try {
            const place = this._settings.get_string('clock-capsule') === 'centre' ? 'centre' : 'left';
            if (this._button && place !== this._place)
                this._teardown();
            if (!this._button)
                this._build(place);
            this._syncGnomeClock();
            this._rebuildFace();
            this._render(false);
        } catch (e) {
            // Never a bar left with no clock: GNOME's as it was.
            console.error(`[panel-island] The capsule clock failed, GNOME's clock left as it is: ${e}\n${e.stack}`);
            try {
                this._teardown();
            } catch {}
        }
    }

    // Building and taking down

    _build(place) {
        this._place = place;
        // A button with no menu: clicking it opens nothing; scrolling and right click still do their part.
        const button = this._button = new PanelMenu.Button(0.5, 'Clock', true);
        button.add_style_class_name('pi-clock-button');
        button.accessible_name = 'Clock';
        this._face = new St.BoxLayout({style_class: 'pi-clock', y_align: Clutter.ActorAlign.CENTER, reactive: false});
        button.add_child(this._face);
        button.connectObject('scroll-event', (_a, event) => this._onScroll(event),
            'button-press-event', (_a, event) => this._onPress(event), this._token);
        const box = place === 'centre' ? 'center' : 'left';
        const index = place === 'centre' ? 0 : Main.panel._leftBox.get_n_children();
        Main.panel.addToStatusArea(ROLES[place], button, index, box);

        this._wall = new GnomeDesktop.WallClock({time_only: true});
        this._wall.connectObject('notify::clock', () => {
            try {
                this._render(true);
            } catch (e) {
                console.error(`[panel-island] The capsule clock failed, GNOME's clock left as it is: ${e}`);
                this._teardown();
            }
        }, this._token);
        this._interface.connectObject('changed::clock-format', () => this._rebuildFace(true), this._token);
        this._notifications.connectObject('changed::show-banners', () => {
            this._syncDnd();
            this._notificationsChanged();
        }, this._token);
        // The weather's place gives the sun its day; a change to it redraws the arc.
        try {
            shellClient()?.connectObject('changed', () => this._sun?.queue_repaint(), this._token);
        } catch {}
        this._loadZone();
        this._zoneSettings?.connectObject('changed::locations', () => this._loadZone(), this._token);
        this._watchNotifications();
        // GNOME's calendar's events (the same it shows): the next one in its chip.
        try {
            this._dateMenu?._eventSource?.connectObject('changed', () => this._syncEvent(), this._token);
        } catch {}
        this._onMoved();
    }

    _teardown() {
        if (!this._button)
            return;
        this._stopTimers();
        this._wall?.disconnectObject(this._token);
        this._wall = null;
        this._interface.disconnectObject(this._token);
        this._notifications.disconnectObject(this._token);
        this._zoneSettings?.disconnectObject(this._token);
        this._zoneSettings = null;
        this._zone = null;
        for (const object of [shellClient(), this._dateMenu?._eventSource]) {
            try {
                object?.disconnectObject(this._token);
            } catch {}
        }
        this._unwatchNotifications();
        this._showGnomeClock();
        const button = this._button;
        this._button = this._face = null;
        this._tiles = this._sun = this._time = this._meridiem = this._aside = this._moon = this._dots = null;
        this._event = this._eventText = this._badge = this._badgeText = null;
        this._place = null;
        this._view = 'time';
        try {
            button.disconnectObject(this._token);
            button.destroy();
        } catch (e) {
            console.warn(`[panel-island] The capsule clock was not taken away cleanly: ${e}`);
        }
        this._onMoved();
    }

    destroy() {
        this._settings.disconnectObject(this._token);
        this._teardown();
    }

    _stopTimers() {
        for (const id of [this._viewTimer, this._copiedTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._viewTimer = this._copiedTimer = 0;
        this._copied = false;
    }

    // GNOME's own clock

    /** Hidden while this one shows (Settings), unless something else hides it already; shown again only if hidden
     * here. */
    _syncGnomeClock() {
        const container = this._dateMenu?.container;
        if (!container)
            return;
        const hide = this._settings.get_boolean('clock-hide-gnome');
        if (hide && !this._hidGnome && container.visible) {
            container.hide();
            this._hidGnome = true;
        } else if (!hide) {
            this._showGnomeClock();
        }
    }

    _showGnomeClock() {
        if (!this._hidGnome)
            return;
        this._hidGnome = false;
        try {
            this._dateMenu?.container?.show();
        } catch {}
    }

    _onPress(event) {
        if (!this._face || event.get_button() !== Clutter.BUTTON_SECONDARY || !this._settings.get_boolean('clock-copy'))
            return Clutter.EVENT_PROPAGATE;
        const now = GLib.DateTime.new_now_local();
        const text = `${now.format('%a %e %b %Y').replace(/\s+/g, ' ')}, ${this._timeText(now.get_hour(), now.get_minute())}`;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._copied = true;
        if (this._copiedTimer)
            GLib.source_remove(this._copiedTimer);
        this._copiedTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPIED_MS, () => {
            this._copiedTimer = 0;
            this._copied = false;
            this._rebuildFace(true);
            return GLib.SOURCE_REMOVE;
        });
        this._rebuildFace(true);
        return Clutter.EVENT_STOP;
    }

    // Scroll: the time, the date, another place's time

    _onScroll(event) {
        if (!this._face || !this._settings.get_boolean('clock-scroll'))
            return Clutter.EVENT_PROPAGATE;
        const direction = event.get_scroll_direction();
        let step = 0;
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT) {
            step = -1;
        } else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT) {
            step = 1;
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            // A touchpad: its movement added up, a step for each whole unit of it.
            const [dx, dy] = event.get_scroll_delta();
            this._scrolled = (this._scrolled ?? 0) + (Math.abs(dy) >= Math.abs(dx) ? dy : dx);
            if (Math.abs(this._scrolled) < 1)
                return Clutter.EVENT_STOP;
            step = Math.sign(this._scrolled);
            this._scrolled = 0;
        }
        if (!step)
            return Clutter.EVENT_STOP;
        const views = VIEWS.filter(view => view !== 'zone' || this._zone);
        const at = Math.max(0, views.indexOf(this._view));
        this._setView(views[(at + step + views.length) % views.length]);
        return Clutter.EVENT_STOP;
    }

    _setView(view) {
        if (this._viewTimer)
            GLib.source_remove(this._viewTimer);
        this._viewTimer = 0;
        this._view = view;
        if (view !== 'time') {
            this._viewTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VIEW_MS, () => {
                this._viewTimer = 0;
                this._view = 'time';
                this._rebuildFace(true);
                return GLib.SOURCE_REMOVE;
            });
        }
        this._rebuildFace(true);
    }

    /** The first of GNOME's world clocks (its calendar's, GNOME Clocks' too), or none. */
    _loadZone() {
        this._zone = null;
        try {
            this._zoneSettings ??= new Gio.Settings({schema_id: 'org.gnome.shell.world-clocks'});
            const world = GWeather.Location.get_world();
            for (const serialized of this._zoneSettings.get_value('locations').deepUnpack()) {
                const location = world?.deserialize(serialized);
                const tz = location?.get_timezone();
                if (tz) {
                    this._zone = {name: location.get_city_name() || location.get_name(), tz};
                    break;
                }
            }
        } catch (e) {
            this._zone = null;
        }
    }

    // What it shows

    get _twelve() {
        return this._interface.get_string('clock-format') === '12h';
    }

    _timeText(h, m) {
        const mm = String(m).padStart(2, '0');
        if (!this._twelve)
            return `${String(h).padStart(2, '0')}:${mm}`;
        return `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
    }

    /** What the face shows now: `digits` (for tiles or the time label), `meridiem` ('AM', 'PM' or null), `aside`. */
    _model() {
        const now = GLib.DateTime.new_now_local();
        const date = now.format('%a %e').replace(/\s+/g, ' ');
        if (this._copied)
            return {digits: null, meridiem: null, aside: 'Copied', icon: 'object-select-symbolic'};
        if (this._view === 'date') {
            const week = now.format('%V').replace(/^0/, '');
            return {digits: String(now.get_day_of_month()), meridiem: null, aside: `${now.format('%b')} · wk ${week}`};
        }
        let time = now, aside = this._settings.get_boolean('clock-show-date') ? date : '';
        if (this._view === 'zone' && this._zone) {
            time = now.to_timezone(this._zone.tz);
            aside = this._zone.name;
        }
        const h = time.get_hour(), m = time.get_minute();
        const mm = String(m).padStart(2, '0');
        if (!this._twelve)
            return {digits: `${String(h).padStart(2, '0')}:${mm}`, meridiem: null, aside, zone: this._view === 'zone'};
        return {digits: `${h % 12 || 12}:${mm}`, meridiem: h < 12 ? 'AM' : 'PM', aside, zone: this._view === 'zone'};
    }

    /** Lays the face out anew for its style and view (its parts; their text comes in `_render`). */
    _rebuildFace(render = false) {
        if (!this._face)
            return;
        this._face.destroy_all_children();
        this._tiles = this._sun = this._time = this._meridiem = this._aside = this._moon = this._dots = null;
        this._event = this._eventText = this._badge = this._badgeText = null;
        this._icon = null;
        const flip = this._settings.get_string('clock-style') !== 'sun';
        const model = this._model();
        this._face.style_class = `pi-clock ${flip ? 'pi-clock-flipping' : 'pi-clock-sunny'}`;

        if (!flip && this._view === 'time' && !this._copied) {
            this._sun = new St.DrawingArea({style_class: 'pi-clock-sun', y_align: Clutter.ActorAlign.CENTER});
            this._sun.connect('repaint', area => this._paintSun(area));
            this._face.add_child(this._sun);
        }
        if (this._copied) {
            this._icon = new St.Icon({style_class: 'pi-clock-icon', icon_name: model.icon});
            this._face.add_child(this._icon);
        }
        if (model.digits !== null) {
            if (flip) {
                this._tiles = new St.BoxLayout({style_class: 'pi-clock-tiles', y_align: Clutter.ActorAlign.CENTER});
                this._tileFor = [];
                for (const char of model.digits) {
                    if (char === ':') {
                        this._tiles.add_child(label({style_class: 'pi-clock-colon', text: ':',
                            y_align: Clutter.ActorAlign.CENTER}));
                        this._tileFor.push(null);
                        continue;
                    }
                    const tile = this._tile(char);
                    this._tiles.add_child(tile);
                    this._tileFor.push(tile);
                }
                this._face.add_child(this._tiles);
            } else {
                this._time = label({style_class: 'pi-clock-time', y_align: Clutter.ActorAlign.CENTER});
                this._face.add_child(this._time);
            }
        }
        if (model.meridiem) {
            const style = flip ? this._settings.get_string('clock-flip-meridiem') : 'label';
            if (style === 'tile') {
                this._meridiem = this._tile(model.meridiem, 'pi-clock-tile pi-clock-tile-wide');
                this._tiles?.add_child(this._meridiem);
            } else if (style === 'stacked') {
                this._meridiem = new St.BoxLayout({style_class: 'pi-clock-stack',
                    orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
                this._meridiem._am = label({style_class: 'pi-clock-stack-label', text: 'AM'});
                this._meridiem._pm = label({style_class: 'pi-clock-stack-label', text: 'PM'});
                this._meridiem.add_child(this._meridiem._am);
                this._meridiem.add_child(this._meridiem._pm);
                this._face.add_child(this._meridiem);
            } else if (this._settings.get_boolean('clock-sun-label')) {
                this._meridiem = label({style_class: 'pi-clock-meridiem', y_align: Clutter.ActorAlign.CENTER,
                    opacity: 190});
                this._face.add_child(this._meridiem);
            }
            if (this._meridiem)
                this._meridiem._style = style;
        }
        // Softer than the time (St's style has no opacity of its own).
        this._aside = label({style_class: 'pi-clock-aside', y_align: Clutter.ActorAlign.CENTER,
            opacity: this._copied ? 255 : 165});
        this._face.add_child(this._aside);
        // The next event, soon (Settings): "Standup · 12 min".
        this._event = new St.BoxLayout({style_class: 'pi-clock-event', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._event.add_child(new St.Widget({style_class: 'pi-clock-event-dot', y_align: Clutter.ActorAlign.CENTER}));
        this._eventText = label({style_class: 'pi-clock-event-text', y_align: Clutter.ActorAlign.CENTER});
        this._event.add_child(this._eventText);
        this._face.add_child(this._event);
        this._moon = new St.Icon({style_class: 'pi-clock-dnd', icon_name: 'weather-clear-night-symbolic'});
        this._face.add_child(this._moon);
        // Notifications waiting (Settings → Notifications): a dot, or how many, right of the time.
        this._badge = new St.Bin({style_class: 'pi-clock-badge', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._badgeText = label({style_class: 'pi-clock-badge-text', y_align: Clutter.ActorAlign.CENTER});
        this._badge.set_child(this._badgeText);
        this._face.add_child(this._badge);
        // Which view: shown only away from the time.
        if (this._view !== 'time' && !this._copied) {
            this._dots = new St.BoxLayout({style_class: 'pi-clock-dots', y_align: Clutter.ActorAlign.CENTER});
            for (const view of VIEWS.filter(v => v !== 'zone' || this._zone))
                this._dots.add_child(new St.Widget({style_class: `pi-clock-dot${view === this._view ? ' pi-clock-dot-on' : ''}`}));
            this._face.add_child(this._dots);
        }
        this._lastDigits = null;
        if (render)
            this._render(false);
    }

    /** A flip tile showing `char`. */
    _tile(char, style = 'pi-clock-tile') {
        const digit = label({style_class: 'pi-clock-tile-label', text: char,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        digit.set_pivot_point(0.5, 0.5);
        const tile = new St.Bin({style_class: style, child: digit, y_align: Clutter.ActorAlign.CENTER});
        tile._label = digit;
        return tile;
    }

    /** Shows the time as it is now; `flip`: changed digits flip over (a new minute), else they are set at once. */
    _render(flip) {
        if (!this._face)
            return;
        const model = this._model();
        // A different shape of digits (9:59 to 10:00, a view): laid out anew, then shown.
        if (this._tiles && model.digits !== null && model.digits.length !== this._tileFor.length) {
            this._rebuildFace(false);
            flip = false;
        }
        if (this._tiles && model.digits !== null) {
            [...model.digits].forEach((char, i) => {
                const tile = this._tileFor[i];
                if (tile && tile._label.text !== char)
                    this._flipTo(tile, char, flip);
            });
        }
        if (this._time && model.digits !== null)
            this._time.text = model.digits;
        if (this._meridiem && model.meridiem) {
            if (this._meridiem._style === 'tile') {
                if (this._meridiem._label.text !== model.meridiem)
                    this._flipTo(this._meridiem, model.meridiem, flip);
            } else if (this._meridiem._style === 'stacked') {
                const pm = model.meridiem === 'PM';
                const set = (label, on) => {
                    const opacity = on ? 255 : 80;
                    if (label.opacity === opacity)
                        return;
                    if (flip && animating() && label.mapped)
                        label.ease({opacity, duration: 400, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                    else
                        label.opacity = opacity;
                };
                set(this._meridiem._am, !pm);
                set(this._meridiem._pm, pm);
            } else {
                this._meridiem.text = model.meridiem;
            }
        }
        if (this._aside) {
            this._aside.text = model.aside ?? '';
            this._aside.visible = Boolean(model.aside);
        }
        this._sun?.queue_repaint();
        this._syncDnd();
        this._syncEvent();
        this._syncBadge();
    }

    // The next event

    /** Today's events with a time of day (not whole days), from GNOME's calendar, in order. */
    _todaysEvents() {
        const source = this._dateMenu?._eventSource;
        if (typeof source?.getEvents !== 'function')
            return [];
        const now = new Date();
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return source.getEvents(day, new Date(day.getTime() + DAY_MS)).filter(event => !allDay(event))
            .sort((a, b) => a.date - b.date);
    }

    /** The next event starting within the lead time Settings say (or started in the last minute), or null. */
    _nextEvent() {
        const now = Date.now(), lead = this._settings.get_int('clock-event-lead') * 60000;
        return this._todaysEvents().find(event => event.date.getTime() > now - 60000 &&
            event.date.getTime() - now <= lead) ?? null;
    }

    _syncEvent() {
        if (!this._event)
            return;
        let next = null;
        try {
            if (this._view === 'time' && !this._copied && this._settings.get_boolean('clock-event-chip'))
                next = this._nextEvent();
        } catch (e) {
            next = null;
        }
        this._event.visible = Boolean(next);
        if (!next)
            return;
        const minutes = Math.ceil((next.date.getTime() - Date.now()) / 60000);
        const name = (next.summary ?? '').trim() || 'Event';
        const short = name.length > EVENT_CHARS ? `${name.slice(0, EVENT_CHARS - 1).trimEnd()}…` : name;
        this._eventText.text = `${short} · ${minutes <= 0 ? 'now' : `${minutes} min`}`;
        if (minutes <= 0)
            this._event.add_style_class_name('pi-clock-event-now');
        else
            this._event.remove_style_class_name('pi-clock-event-now');
    }

    /** `tile` to `char`: folded flat and opened again with it, or set at once. */
    _flipTo(tile, char, flip) {
        const label = tile._label;
        label.remove_all_transitions();
        if (!flip || !animating() || !label.mapped) {
            label.scale_y = 1;
            label.text = char;
            return;
        }
        label.ease({
            scale_y: 0, duration: FLIP_DOWN_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: finished => {
                label.text = char;
                if (!finished) {
                    label.scale_y = 1;
                    return;
                }
                label.ease({scale_y: 1, duration: FLIP_UP_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            },
        });
    }

    // Notifications waiting

    /** How many notifications are unseen, as GNOME's own dot counts them (less those still to show as banners). */
    _unseen() {
        try {
            let count = 0;
            Main.messageTray.getSources().forEach(source => (count += source.unseenCount ?? 0));
            return Math.max(0, count - (Main.messageTray.queueCount ?? 0));
        } catch {
            return 0;
        }
    }

    /** Follows notifications coming and going, as GNOME's dot does: each source's count, the tray's queue. */
    _watchNotifications() {
        this._noteSources = new Set();
        const watch = source => {
            if (!source || this._noteSources.has(source))
                return;
            this._noteSources.add(source);
            source.connectObject('notify::count', () => this._notificationsChanged(), this._token);
        };
        Main.messageTray.getSources().forEach(watch);
        Main.messageTray.connectObject(
            'source-added', (_tray, source) => {
                watch(source);
                this._notificationsChanged();
            },
            'source-removed', (_tray, source) => {
                this._noteSources.delete(source);
                try {
                    source.disconnectObject(this._token);
                } catch {}
                this._notificationsChanged();
            },
            'queue-changed', () => this._notificationsChanged(), this._token);
    }

    _unwatchNotifications() {
        try {
            Main.messageTray.disconnectObject(this._token);
        } catch {}
        for (const source of this._noteSources ?? []) {
            try {
                source.disconnectObject(this._token);
            } catch {}
        }
        this._noteSources = null;
    }

    _notificationsChanged() {
        this._syncBadge();
    }

    /** The dot or count: while some are waiting and notifications show (not with Do Not Disturb, as GNOME's). */
    _syncBadge() {
        if (!this._badge)
            return;
        const mode = this._settings.get_string('clock-notify-badge');
        const count = this._unseen();
        const show = mode !== 'off' && count > 0 && !this._copied && this._notifications.get_boolean('show-banners');
        this._badge.visible = show;
        if (!show)
            return;
        const dot = mode === 'dot';
        this._badgeText.text = dot ? '' : count > 99 ? '99+' : String(count);
        this._badgeText.visible = !dot;
        if (dot)
            this._badge.add_style_class_name('pi-clock-badge-dot');
        else
            this._badge.remove_style_class_name('pi-clock-badge-dot');
    }

    _syncDnd() {
        if (!this._moon)
            return;
        this._moon.visible = this._settings.get_boolean('clock-dnd') && !this._notifications.get_boolean('show-banners') &&
            !this._copied;
    }

    // The sun's arc

    /** Today's sunrise and sunset (unix seconds): the weather's place's, else 6 and 18 o'clock. */
    _sunTimes(now) {
        try {
            const client = shellClient();
            const info = client?.available && client.hasLocation ? client.info : null;
            const [hasRise, rise] = info?.get_value_sunrise?.() ?? [false, 0];
            const [hasSet, set] = info?.get_value_sunset?.() ?? [false, 0];
            if (hasRise && hasSet && set > rise) {
                // GWeather's are for the day it last fetched: moved to today, keeping their time of day.
                const day = 86400;
                const shift = Math.floor((now - rise) / day) * day;
                return {rise: rise + shift, set: set + shift};
            }
        } catch {}
        const today = GLib.DateTime.new_now_local();
        const at = h => GLib.DateTime.new_local(today.get_year(), today.get_month(), today.get_day_of_month(), h, 0, 0)
            .to_unix();
        return {rise: at(DEFAULT_SUNRISE_H), set: at(DEFAULT_SUNSET_H)};
    }

    /** Where the sun is: `phase` (day, golden, blue, night), and `t` 0..1 along the arc (the day's, or the night's). */
    _sunState() {
        const now = GLib.DateTime.new_now_local().to_unix();
        const {rise, set} = this._sunTimes(now);
        const min = 60;
        if (now >= rise && now <= set) {
            const golden = now >= set - GOLDEN_MIN * min || now <= rise + GOLDEN_MIN * min;
            return {phase: golden ? 'golden' : 'day', t: (now - rise) / (set - rise), up: true};
        }
        // The night: from sunset to the next sunrise.
        const from = now > set ? set : set - 86400;
        const to = now > set ? rise + 86400 : rise;
        const blue = now <= from + BLUE_MIN * min || now >= to - BLUE_MIN * min;
        return {phase: blue ? 'blue' : 'night', t: (now - from) / Math.max(1, to - from), up: false};
    }

    _paintSun(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const fg = area.get_theme_node().get_foreground_color();
        const ink = [fg.red / 255, fg.green / 255, fg.blue / 255];
        const s = Math.max(1, w / 30);
        const {phase, t, up} = this._sunState();
        const colours = this._settings.get_boolean('clock-sun-colours') ? SUN_COLOURS[phase] : {body: ink, arc: null};
        const cx = w / 2, cy = h - 3 * s, r = Math.min(w / 2 - 3 * s, h - 6 * s);
        // The horizon, and the arc dashed above it.
        cr.setLineWidth(Math.max(1, 0.8 * s));
        cr.setSourceRGBA(...(colours.arc ?? ink), colours.arc ? 0.55 : 0.3);
        cr.moveTo(1 * s, cy);
        cr.lineTo(w - 1 * s, cy);
        cr.stroke();
        cr.setDash([2 * s, 2 * s], 0);
        cr.setSourceRGBA(...(colours.arc ?? ink), colours.arc ? 0.8 : 0.35);
        cr.arc(cx, cy, r, Math.PI, 2 * Math.PI);
        cr.stroke();
        cr.setDash([], 0);
        const angle = Math.PI * (1 - Math.max(0, Math.min(1, t)));
        const x = cx + r * Math.cos(angle), y = cy - r * Math.sin(angle);
        const body = 2.6 * s;
        cr.setSourceRGBA(...colours.body, 1);
        if (up || phase === 'blue') {
            cr.arc(x, y, body, 0, 2 * Math.PI);
            cr.fill();
        } else {
            // A crescent: the disc less one a little to its side.
            cr.setFillRule(Cairo.FillRule.EVEN_ODD);
            cr.arc(x, y, body, 0, 2 * Math.PI);
            cr.newSubPath();
            cr.arc(x + body * 0.7, y - body * 0.35, body * 0.85, 0, 2 * Math.PI);
            cr.clip();
            cr.arc(x, y, body, 0, 2 * Math.PI);
            cr.fill();
            cr.resetClip();
        }
        cr.$dispose();
    }
}
