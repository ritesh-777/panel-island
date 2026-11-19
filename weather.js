// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Written for Isle (its feature/calendar-weather branch) and carried here as it is, for the weather added to Isle's
// Calendar page as it runs (isleWeather.js): only its one import of Isle's (px) made its own, and its sky's GObject
// type named apart, so nothing of it can meet anything of Isle's.

// Weather: GNOME Shell's own (its calendar menu's, for GNOME Weather's place), a day of it as the Calendar
// page shows it, and a small sky that moves with it.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GWeather from 'gi://GWeather?version=4.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** `n` CSS pixels in stage pixels (Isle's compat.js px). */
const px = n => n * St.ThemeContext.get_for_stage(global.stage).scale_factor;

/** Times a day's row of hours shows at most, spread over it. */
const MAX_HOURS = 7;
/** Another day reads as it is at this hour. */
const MIDDAY_HOUR = 13;

/** GNOME Shell's weather client, or null; shared, so nothing more is fetched or watched. */
export function shellClient() {
    return Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient ?? null;
}

const temp = info => Math.round(info.get_value_temp(GWeather.TemperatureUnit.DEFAULT)[1]);
const hasTemp = info => info.get_value_temp(GWeather.TemperatureUnit.DEFAULT)[0];
const timeOf = info => new Date(info.get_value_update()[1] * 1000);
/** Whether GWeather's `text` says something: its empty answers are '-' and "Unknown" (translated). */
const UNKNOWN = new Set(['-', 'unknown', GLib.dgettext('libgweather-4.0', 'Unknown').toLowerCase()]);
const known = text => Boolean(text) && !UNKNOWN.has(String(text).trim().toLowerCase());

/** What a GWeather icon name shows, in words: for a sky GWeather has no words for (its conditions and sky both
 * unknown, as some providers' are). */
function skyWords(iconName = '') {
    for (const [part, words] of [['storm', 'Storm'], ['snow', 'Snow'], ['showers', 'Showers'], ['rain', 'Rain'],
        ['fog', 'Fog'], ['overcast', 'Cloudy'], ['few-clouds', 'Partly cloudy'], ['clear', 'Clear']]) {
        if (iconName.includes(part))
            return words;
    }
    return '';
}

/** The speed of GWeather's wind text ("Northwest / 4.9 mph"), or null when it has none. */
const windOf = info => {
    const speed = info.get_wind().split(' / ').pop();
    return known(speed) ? speed : null;
};

/** Whether `info` holds the weather: a refresh empties it (no temperature, read as 0°) until its answer. */
export function ready(info) {
    return !!info?.is_valid() && hasTemp(info);
}

/** The weather of `day` from `info`: now for today, its middle for another; null without a forecast for it.
 * `{place, icon, temp, summary, high, low, details: [text], hours: [{time, icon, temp, wind}]}`; high and low of
 * today are of what is left of it, and its hours the next few, past midnight too, so late in the evening
 * it still has some. */
export function dayWeather(info, day, now = new Date(), maxHours = MAX_HOURS) {
    if (!ready(info))
        return null;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const today = now >= start && now < end;
    const all = info.get_forecast_list().filter(hasTemp);
    const forecasts = all.filter(f => timeOf(f) >= start && timeOf(f) < end && (!today || timeOf(f) > now));
    const hours = today ? all.filter(f => timeOf(f) > now).slice(0, maxHours) : forecasts;
    if (!today && !forecasts.length)
        return null;
    const midday = start.getTime() + MIDDAY_HOUR * 3600e3;
    const main = today ? info : forecasts.reduce((a, b) => Math.abs(timeOf(a) - midday) <= Math.abs(timeOf(b) - midday) ? a : b);
    const temps = [main, ...forecasts].map(temp);
    const [hasApparent, apparent] = main.get_value_apparent(GWeather.TemperatureUnit.DEFAULT);
    const wind = windOf(main);
    const icon = main.get_symbolic_icon_name();
    const step = Math.ceil(hours.length / maxHours);
    return {
        // The place it is for (GNOME Weather's), and its sky in words: GWeather's, or the icon's.
        place: [info.get_location_name?.(), info.get_location?.()?.get_city_name?.()].find(known) ?? '',
        icon,
        temp: temp(main),
        summary: [main.get_conditions(), main.get_sky()].find(known) ?? skyWords(icon),
        high: Math.max(...temps),
        low: Math.min(...temps),
        details: [hasApparent && `Feels ${Math.round(apparent)}°`, wind && `Wind ${wind}`,
            known(main.get_humidity()) && `Humidity ${main.get_humidity()}`].filter(Boolean),
        hours: hours.filter((_f, i) => i % step === 0).map(f => ({time: timeOf(f), icon: f.get_symbolic_icon_name(),
            temp: temp(f), wind: windOf(f)})),
    };
}

/** What moves in the sky for a GWeather icon name. */
export function skyOf(iconName) {
    for (const [part, sky] of [['storm', 'storm'], ['snow', 'snow'], ['showers', 'rain'], ['rain', 'rain'],
        ['fog', 'fog'], ['night', 'night'], ['clear', 'sun']]) {
        if (iconName.includes(part))
            return sky;
    }
    return 'cloud';
}

/** Where stars sit, as fractions of the sky. */
const STARS = [[0.14, 0.18], [0.82, 0.12], [0.76, 0.7]];
/** Particles per sky: how many, their style, how long one falls or twinkles (ms), and how far it falls (px). */
const PARTICLES = {
    rain: {count: 6, style: 'isle-sky-drop', ms: 650, fall: 24},
    storm: {count: 6, style: 'isle-sky-drop', ms: 520, fall: 24},
    snow: {count: 5, style: 'isle-sky-flake', ms: 2200, fall: 22},
    night: {count: STARS.length, style: 'isle-sky-star', ms: 1400, fall: 0},
};

/** The day's sky, its icon large: the sun turns, clouds drift, rain and snow fall, a storm flashes, stars twinkle.
 * Moves only between `play` and `stop`, and not at all with GNOME's animations off. */
export const Sky = GObject.registerClass({GTypeName: 'PanelIslandWeatherSky'},
class Sky extends St.Widget {
    _init() {
        super._init({style_class: 'isle-sky', layout_manager: new Clutter.BinLayout(), clip_to_allocation: true});
        this._icon = new St.Icon({style_class: 'isle-sky-icon', x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER});
        this._icon.set_pivot_point(0.5, 0.5);
        this._flash = new St.Widget({style_class: 'isle-sky-flash', x_expand: true, y_expand: true, opacity: 0});
        this._particles = new St.Widget({x_expand: true, y_expand: true});
        // Rain and snow come from under the cloud, stars sit behind the moon.
        this.add_child(this._flash);
        this.add_child(this._particles);
        this.add_child(this._icon);
        this._sky = '';
        this._playing = false;
    }

    set iconName(name) {
        if (this._icon.icon_name === name)
            return;
        this._icon.icon_name = name;
        this._sky = skyOf(name);
        if (this._playing)
            this.play();
    }

    get playing() {
        return this._playing;
    }

    play() {
        this.stop();
        this._playing = true;
        if (!St.Settings.get().enable_animations)
            return;
        const icon = this._icon;
        const loop = {repeatCount: -1, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE};
        if (this._sky === 'sun') {
            icon.ease({rotation_angle_z: 360, duration: 14000, repeatCount: -1, mode: Clutter.AnimationMode.LINEAR});
        } else if (this._sky === 'cloud' || this._sky === 'fog') {
            icon.translation_x = -px(3);
            icon.ease({translation_x: px(3), duration: 3200, autoReverse: true, ...loop});
            if (this._sky === 'fog')
                icon.ease({opacity: 150, duration: 2400, autoReverse: true, ...loop});
        } else {
            // Floats a little while what is under it moves.
            icon.ease({translation_y: -px(1.5), duration: 1800, autoReverse: true, ...loop});
        }
        if (this._sky === 'storm')
            this._flashes();
        const particles = PARTICLES[this._sky];
        if (!particles)
            return;
        const [width, height] = [this.width || px(52), this.height || px(52)];
        for (let i = 0; i < particles.count; i++) {
            const dot = new St.Widget({style_class: particles.style});
            this._particles.add_child(dot);
            const delay = Math.round(particles.ms * i / particles.count);
            if (!particles.fall) {
                dot.set_position(STARS[i][0] * width, STARS[i][1] * height);
                dot.opacity = 60;
                dot.ease({opacity: 255, duration: particles.ms, delay, autoReverse: true, ...loop});
                continue;
            }
            // Spread across under the cloud, falling from its middle out at the bottom.
            dot.set_position(width * (0.2 + 0.6 * ((i * 3) % particles.count) / (particles.count - 1)), height * 0.55);
            dot.opacity = 0;
            dot.ease({translation_y: px(particles.fall), duration: particles.ms, delay, repeatCount: -1,
                mode: Clutter.AnimationMode.EASE_IN_QUAD});
            // In, then out before the bottom.
            const fade = new Clutter.KeyframeTransition({property_name: 'opacity', duration: particles.ms,
                delay, repeat_count: -1});
            fade.set_from(0);
            fade.set_to(0);
            fade.set_key_frames([0.2, 0.75]);
            fade.set_values([255, 200]);
            dot.add_transition('fade', fade);
        }
    }

    /** Two quick flashes now and then. */
    _flashes() {
        const flash = new Clutter.KeyframeTransition({property_name: 'opacity', duration: 5000, repeat_count: -1});
        flash.set_from(0);
        flash.set_to(0);
        flash.set_key_frames([0.84, 0.86, 0.89, 0.91, 0.95]);
        flash.set_values([0, 170, 0, 110, 0]);
        this._flash.add_transition('flash', flash);
    }

    stop() {
        this._playing = false;
        this._icon.remove_all_transitions();
        this._flash.remove_all_transitions();
        this._icon.set({rotation_angle_z: 0, translation_x: 0, translation_y: 0, opacity: 255});
        this._flash.opacity = 0;
        this._particles.destroy_all_children();
    }
});
