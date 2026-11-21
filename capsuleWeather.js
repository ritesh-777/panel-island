// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Weather: the weather in the left capsule or the middle one, from GNOME's own (its calendar's, for GNOME
// Weather's place: nothing more is asked of anyone). A bar button of its own: its icon and temperature, and, before
// the sky changes, when rain comes ("Rain ~4 PM", from the hourly forecast). Clicking it opens nothing. The capsule's
// glass takes on the sky
// (`onSky`: drops of rain, frost, a warm glare, mist; drawn once as the sky changes, never moving). GNOME asks for
// the weather only as its calendar opens: asked here every half hour.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather?version=4.0';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {known, shellClient, skyOf, skyWords} from './weather.js';

/** How often the weather is asked for again (s). */
const REFRESH_S = 30 * 60;
/** Rain this far ahead (h) shows on the button. */
const RAIN_AHEAD_H = 3;
/** At or below this (°C), the glass frosts. */
const FROST_C = 2;

const ROLES = {left: 'panel-island-weather', centre: 'panel-island-weather-centre'};

const RAINY = icon => /storm|showers|rain/.test(icon ?? '');

function label(props) {
    const actor = new St.Label(props);
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return actor;
}

const tempOf = (info, unit = GWeather.TemperatureUnit.DEFAULT) => {
    const [ok, value] = info.get_value_temp(unit);
    return ok ? Math.round(value) : null;
};
const timeOf = info => info.get_value_update()[1];

/** The sky for the capsule's glass: rain, storm, snow, frost, fog, sun, night or cloud. */
export function glassSky(info) {
    const icon = info.get_symbolic_icon_name() ?? '';
    const sky = skyOf(icon);
    const celsius = tempOf(info, GWeather.TemperatureUnit.CENTIGRADE);
    if (sky !== 'snow' && sky !== 'rain' && sky !== 'storm' && celsius !== null && celsius <= FROST_C)
        return 'frost';
    return sky;
}

export class CapsuleWeather {
    /** `settings`: Panel Island's; `onSky(box, sky)`: the capsule round `box` takes on `sky` (null: none);
     * `onMoved()`: the button came, went or moved. */
    constructor(settings, {onSky = () => {}, onMoved = () => {}} = {}) {
        this._settings = settings;
        this._onSky = onSky;
        this._onMoved = onMoved;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._button = null;
        this._place = null;
        this._refreshId = 0;
        this._token = {};
        this._settings.connectObject('changed', (_s, key) => key.startsWith('weather-') && this._apply(), this._token);
        this._apply();
    }

    get _client() {
        return shellClient();
    }

    _apply() {
        if (!this._settings.get_boolean('weather-enabled') || !this._client) {
            this._teardown();
            return;
        }
        try {
            const place = this._settings.get_string('weather-capsule') === 'left' ? 'left' : 'centre';
            if (this._button && place !== this._place)
                this._teardown();
            if (!this._button)
                this._build(place);
            this._sync();
        } catch (e) {
            console.error(`[panel-island] The capsule weather failed and was taken away: ${e}\n${e.stack}`);
            try {
                this._teardown();
            } catch {}
        }
    }

    _build(place) {
        this._place = place;
        // A button with no menu: clicking it opens nothing.
        const button = this._button = new PanelMenu.Button(0.5, 'Weather', true);
        button.add_style_class_name('pi-weather-button');
        button.accessible_name = 'Weather';
        const face = new St.BoxLayout({style_class: 'pi-weather', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'pi-weather-icon', y_align: Clutter.ActorAlign.CENTER});
        this._temp = label({style_class: 'pi-weather-temp', y_align: Clutter.ActorAlign.CENTER});
        this._words = label({style_class: 'pi-weather-words', y_align: Clutter.ActorAlign.CENTER, opacity: 165});
        this._chip = new St.BoxLayout({style_class: 'pi-weather-chip', y_align: Clutter.ActorAlign.CENTER});
        this._chip.add_child(new St.Icon({style_class: 'pi-weather-chip-icon', icon_name: 'weather-showers-symbolic'}));
        this._chipText = label({style_class: 'pi-weather-chip-text', y_align: Clutter.ActorAlign.CENTER});
        this._chip.add_child(this._chipText);
        [this._icon, this._temp, this._words, this._chip].forEach(actor => face.add_child(actor));
        button.add_child(face);

        const box = place === 'centre' ? 'center' : 'left';
        const parent = place === 'centre' ? Main.panel._centerBox : Main.panel._leftBox;
        Main.panel.addToStatusArea(ROLES[place], button, parent.get_n_children(), box);

        this._client.connectObject('changed', () => this._sync(), this._token);
        this._interface.connectObject('changed::clock-format', () => this._sync(), this._token);
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REFRESH_S, () => {
            this._client?.update();
            return GLib.SOURCE_CONTINUE;
        });
        this._client.update();
        this._onMoved();
    }

    _teardown() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        if (!this._button)
            return;
        try {
            this._client?.disconnectObject(this._token);
        } catch {}
        this._interface.disconnectObject(this._token);
        const button = this._button, place = this._place;
        this._button = this._place = null;
        this._onSky(place, null);
        try {
            button.destroy();
        } catch (e) {
            console.warn(`[panel-island] The capsule weather was not taken away cleanly: ${e}`);
        }
        this._onMoved();
    }

    destroy() {
        this._settings.disconnectObject(this._token);
        this._teardown();
    }

    /** The weather now, or null while there is none (no place set in GNOME Weather, nothing fetched yet). */
    get _info() {
        const client = this._client;
        const info = client?.available && client.hasLocation ? client.info : null;
        return info && tempOf(info) !== null ? info : null;
    }

    _hour(unix) {
        const time = GLib.DateTime.new_from_unix_local(unix);
        return this._interface.get_string('clock-format') === '12h'
            ? time.format('%l %p').trim() : time.format('%H:%M');
    }

    /** The sky in words: GWeather's, when it has any (some providers give only an icon, and "Unknown" for words), else
     * the icon's. */
    _words_(info) {
        return [info.get_conditions(), info.get_sky()].find(known) ?? skyWords(info.get_symbolic_icon_name() ?? '');
    }

    /** The coming hours, from now on. */
    _hours(info, count) {
        const now = Date.now() / 1000;
        return info.get_forecast_list().filter(f => tempOf(f) !== null && timeOf(f) > now).slice(0, count);
    }

    /** The button as the weather is now, and the capsule's sky. */
    _sync() {
        if (!this._button)
            return;
        const info = this._info;
        // Nothing to show yet: hidden, rather than an empty or made-up reading.
        (this._button.container ?? this._button).visible = Boolean(info);
        if (!info) {
            this._onSky(this._place, null);
            return;
        }
        const icon = info.get_symbolic_icon_name();
        this._icon.icon_name = icon || 'weather-overcast-symbolic';
        this._temp.text = `${tempOf(info)}°`;
        const words = this._words_(info);
        this._words.text = words;
        this._words.visible = this._settings.get_boolean('weather-words') && Boolean(words);
        // Rain coming (not here yet): when, from the hourly forecast.
        let rain = null;
        if (this._settings.get_boolean('weather-rain-chip') && !RAINY(icon)) {
            const until = Date.now() / 1000 + RAIN_AHEAD_H * 3600;
            const next = this._hours(info, RAIN_AHEAD_H + 1).find(f => timeOf(f) <= until && RAINY(f.get_symbolic_icon_name()));
            if (next)
                rain = `Rain ~${this._hour(timeOf(next))}`;
        }
        this._chip.visible = Boolean(rain);
        this._chipText.text = rain ?? '';
        this._onSky(this._place, this._settings.get_boolean('weather-glass') ? glassSky(info) : null);
    }
}
