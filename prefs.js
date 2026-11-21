// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Panel Island: its settings window.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {migrate} from './migrate.js';

/** Whether Isle is installed, for the user or system-wide: without it, nothing here speaks of it. */
const ISLE_INSTALLED = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()].some(dir =>
    GLib.file_test(GLib.build_filenamev([dir, 'gnome-shell', 'extensions', 'isle@zickrian.github.io', 'metadata.json']),
        GLib.FileTest.EXISTS));

/** `choices` as shown: without Isle, its "Like Isle" choice gone (it then means the first one left). */
const shown = choices => ISLE_INSTALLED ? choices : choices.filter(([value]) => value !== 'isle');

const CENTRE = [
    ['auto', 'Automatic', 'Only while Isle is off: its island holds the clock otherwise'],
    ['on', 'On', 'Always, round the clock'],
    ['off', 'Off', 'Never: the clock as GNOME draws it'],
];

const TOP_BAR = [
    ['isle', 'Like Isle', 'As Isle\'s own Top bar settings colour it'],
    ['custom', 'Coloured', 'See-through to black, as the opacity below says, its text white'],
    ['theme', 'Theme\'s own', 'As the theme or another extension has it'],
];

const OPEN_ON_ALL = [
    ['isle', 'Like Isle', 'Follow Isle\'s own "open on" setting and delay'],
    ['hover', 'On hover', 'When the pointer rests on a button'],
    ['click', 'On click', 'Only when clicked, as GNOME does'],
];
const OPEN_ON = shown(OPEN_ON_ALL);

const SHAPES = [
    ['isle', 'Like Isle', 'The same shape as Isle\'s island'],
    ['pill', 'Pill', 'Floating in the bar, round all over'],
    ['notch', 'Notch', 'Joined to the top of the screen, flaring into the bar'],
];

const EDGE_LIGHTS = [
    ['even', 'Even', 'The same all round the edge, straight or curved'],
    ['directional', ISLE_INSTALLED ? 'Like Isle' : 'Directional', 'Lit from the top left: edges facing down and left hardly lit'],
];

const EDGE_BLURS = [
    ['fade', 'Fade to glass', 'The blur thins into clear glass towards the screen\'s edge'],
    ['solid', 'Solid to the edge', 'As blurred at the screen\'s edge as anywhere'],
];

const LOOKS = [
    ['isle', 'Like Isle', 'The same look as Isle\'s island'],
    ['glass', 'Glass', 'What is behind, blurred'],
    ['black', 'Black', 'Solid black'],
];

/** A choice of `choices` ([value, label, subtitle]) for the string `key`. */
function choiceRow(settings, key, title, allChoices) {
    const choices = shown(allChoices);
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(choices.map(([, label]) => label))});
    const sync = () => {
        const i = Math.max(0, choices.findIndex(([value]) => value === settings.get_string(key)));
        if (row.selected !== i)
            row.selected = i;
        row.subtitle = choices[i][2];
    };
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value && settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    settings.connect(`changed::${key}`, sync);
    sync();
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, {lower, upper, step, digits = 0}) {
    const row = new Adw.SpinRow({
        title, subtitle, digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** Settings → Glass strength: a slider from clear to dark, as Isle's Glass tint, in steps of 5. */
function strengthRow(settings) {
    const row = new Adw.ActionRow({title: 'Glass strength'});
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL, hexpand: true, width_request: 200, draw_value: false,
        adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 25}),
        valign: Gtk.Align.CENTER,
    });
    const ends = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
    ends.append(new Gtk.Label({label: 'Clear', css_classes: ['dim-label', 'caption']}));
    ends.append(scale);
    ends.append(new Gtk.Label({label: 'Dark', css_classes: ['dim-label', 'caption']}));
    row.add_suffix(ends);
    row.activatable_widget = scale;
    const describe = value => {
        row.subtitle = value <= 0 ? 'Clear glass, lightly blurred'
            : value >= 100 ? 'Dark frosted glass, blurred most' : `${value}% darker and more blurred`;
    };
    let syncing = false;
    scale.connect('value-changed', () => {
        if (syncing)
            return;
        const value = Math.round(scale.get_value() / 5) * 5;
        describe(value);
        if (settings.get_int('glass-tint') !== value)
            settings.set_int('glass-tint', value);
    });
    const sync = () => {
        const value = settings.get_int('glass-tint');
        if (Math.round(scale.get_value() / 5) * 5 !== value) {
            syncing = true;
            scale.set_value(value);
            syncing = false;
        }
        describe(value);
        row.sensitive = !ISLE_INSTALLED || !settings.get_boolean('tint-like-isle');
    };
    settings.connect('changed::glass-tint', sync);
    settings.connect('changed::tint-like-isle', sync);
    sync();
    return row;
}

/** The rows for one corner at the screen's edge, its settings starting with `prefix` ('' the bottom's, 'top-' the
 * top's), in `group`: its radius, matching the windows' corners, and their radius. Returns `sync(enabled)`, which
 * greys out what does not apply. */
function cornerRows(settings, group, prefix, top) {
    const radius = spinRow(settings, `${prefix}edge-radius`, 'Corner radius',
        top ? 'In px. Positive rounds it in, 0 leaves it square, negative flares it out up the screen\'s side'
            : 'In px. Positive rounds it in, 0 leaves it square, negative flares it out down the screen\'s side',
        {lower: -48, upper: 48, step: 1});
    const match = switchRow(settings, `${prefix}match-windows`, 'Match window corners',
        top ? 'Sized as a window\'s corner. + round as it; − flared, as the bottom\'s mirrored; 0 square'
            : 'Sized from a window\'s corner below the bar. + round as it; − flared, following it at an even gap; 0 square');
    const radiusAuto = switchRow(settings, `${prefix}window-radius-auto`, 'Window radius from Rounded Window Corners',
        'Its corner radius, or libadwaita\'s 15 px without it');
    const windowRadius = spinRow(settings, `${prefix}window-radius`, 'Window corner radius',
        'In px, the windows\' own', {lower: 0, upper: 48, step: 1});
    for (const row of [radius, match, radiusAuto, windowRadius])
        group.add(row);
    return enabled => {
        const matching = enabled && settings.get_boolean(`${prefix}match-windows`);
        // Matching, the radius still picks round (+), flared (−) or square (0); the size is the windows'.
        radius.sensitive = enabled;
        match.sensitive = enabled;
        radiusAuto.sensitive = matching;
        windowRadius.sensitive = matching && !settings.get_boolean(`${prefix}window-radius-auto`);
    };
}

export default class PanelIslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        migrate(settings);
        window.set_default_size(560, 720);

        const page = new Adw.PreferencesPage({title: 'Capsules', icon_name: 'view-continuous-symbolic'});
        window.add(page);

        const capsules = new Adw.PreferencesGroup({
            title: 'Capsules',
            description: ISLE_INSTALLED
                ? 'Glass pills round the top bar\'s items, in Isle\'s look. One turned off looks and opens as GNOME\'s.'
                : 'Glass pills round the top bar\'s items. One turned off looks and opens as GNOME\'s.',
        });
        capsules.add(choiceRow(settings, 'color-style', 'Style', [
            ['auto', 'Follow GNOME', 'Light or dark as Settings → Appearance is'],
            ['light', 'Light', 'Frosted light glass, dark text and icons'],
            ['dark', 'Dark', 'Smoked glass, light text and icons'],
        ]));
        capsules.add(choiceRow(settings, 'shape', 'Shape', SHAPES));
        capsules.add(choiceRow(settings, 'theme', 'Look', LOOKS));
        const likeIsle = switchRow(settings, 'tint-like-isle', 'Glass as strong as Isle\'s',
            'Follow Isle\'s Glass tint. Off: set it here');
        const strength = strengthRow(settings);
        const edgeLight = choiceRow(settings, 'edge-light', 'Edge light', EDGE_LIGHTS);
        const edgeBlur = choiceRow(settings, 'edge-blur', 'Edge blur', EDGE_BLURS);
        // Only for glass: black has no strength or edge light.
        const glassOnly = () => {
            const black = settings.get_string('theme') === 'black';
            strength.visible = edgeLight.visible = edgeBlur.visible = !black;
            likeIsle.visible = ISLE_INSTALLED && !black;
        };
        settings.connect('changed::theme', glassOnly);
        glassOnly();
        capsules.add(likeIsle);
        capsules.add(strength);
        capsules.add(edgeLight);
        capsules.add(edgeBlur);
        capsules.add(switchRow(settings, 'left-capsule', 'Left capsule', 'Activities, workspaces, app menu'));
        capsules.add(choiceRow(settings, 'centre-capsule', 'Middle capsule', CENTRE));
        capsules.add(switchRow(settings, 'right-capsule', 'Right capsule', 'Tray icons and quick settings'));
        capsules.add(switchRow(settings, 'keep-activities', 'Keep GNOME\'s Activities button',
            'Shown even when another extension hides it, such as O-tiling\'s workspace numbers'));
        capsules.add(switchRow(settings, 'flat-buttons', 'Flat buttons',
            'No shading on a button under the pointer or pressed'));
        page.add(capsules);

        // Settings → Glass during workspace switches (overview.js): its own group, so it is easy to find.
        const switching = new Adw.PreferencesGroup({
            title: 'Workspace switches',
            description: 'How the glass (capsules, menus, the workspace peek, Island Menu on Panel Island) behaves while a workspace slides.',
        });
        switching.add(choiceRow(settings, 'switch-glass', 'Glass during workspace switches', [
            ['always', 'Still', 'Held still as a workspace slides, blurred again once it stops: much lighter'],
            ['battery', 'Still on battery', 'Held still on battery, following the slide on mains power'],
            ['live-efficient', 'Live (efficient)', 'Follow every frame using a smaller shared blur'],
            ['never', 'Live', 'Follows the slide as it moves: smoothest, heaviest'],
        ]));
        page.add(switching);


        const isle = new Adw.PreferencesGroup({
            title: 'Isle',
            description: 'Changes to Isle itself, made as it runs. Its files are never touched; turned off, or should Isle change so they no longer apply, Isle is as it always is.',
        });
        isle.add(switchRow(settings, 'patch-isle-overview', 'Keep Isle\'s glass in the overview',
            'Isle\'s island stays blurred in the overview and as workspaces switch, blurring what is really behind it'));
        isle.add(switchRow(settings, 'patch-isle-lighter', 'Lighter blur updates',
            'A window just below the bar, a video in it, no longer has Isle\'s glass blurred again every frame'));
        isle.add(switchRow(settings, 'patch-isle-calm', 'Isle without bounce',
            'Isle\'s island grows and shrinks as quickly, without going past its size and springing back'));
        isle.add(switchRow(settings, 'patch-isle-light', 'Light Isle',
            'Isle\'s island light too when the Style above is light: its glass, text and icons'));
        isle.add(switchRow(settings, 'isle-weather', 'Weather on Isle\'s Calendar page',
            'The day\'s sky and temperature beside it; click for the day in full. For GNOME Weather\'s place'));
        isle.add(switchRow(settings, 'patch-isle-corners', 'Smooth Isle\'s notch corners',
            'The rim and glow run round a notch\'s curved top corners, not cut off where they start'));
        const isleEdge = choiceRow(settings, 'isle-edge-blur', 'Isle\'s edge blur', [
            ['fade', 'Fade to glass', 'As Isle draws it: the blur thins into clear glass towards the screen\'s edge'],
            ['solid', 'Solid to the edge', 'As blurred at the screen\'s edge as anywhere, over Isle\'s own design'],
        ]);
        // It changes Isle's glass only while the corners patch has it.
        const syncIsleEdge = () => (isleEdge.sensitive = settings.get_boolean('patch-isle-corners'));
        settings.connect('changed::patch-isle-corners', syncIsleEdge);
        syncIsleEdge();
        isle.add(isleEdge);
        isle.visible = ISLE_INSTALLED;
        page.add(isle);

        const bar = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: ISLE_INSTALLED
                ? 'While Isle is off: with Isle on, Isle colours the bar itself.'
                : 'The bar round the capsules.',
        });
        bar.add(choiceRow(settings, 'top-bar', 'Colour', TOP_BAR));
        const barOpacity = spinRow(settings, 'top-bar-opacity', 'Opacity',
            '0 is see-through, 100 black, in %', {lower: 0, upper: 100, step: 5});
        const syncBar = () => {
            const mode = settings.get_string('top-bar');
            barOpacity.sensitive = mode === 'custom' || (mode === 'isle' && !ISLE_INSTALLED);
        };
        settings.connect('changed::top-bar', syncBar);
        syncBar();
        bar.add(barOpacity);
        bar.add(switchRow(settings, 'bar-at-bottom', 'Bar at the bottom',
            ISLE_INSTALLED
                ? 'The bar, its capsules and menus at the bottom of the main display. Isle\'s island stays at the top, as on a display with no bar'
                : 'The bar, its capsules and menus at the bottom of the main display, menus opening upwards'));
        page.add(bar);

        const edges = new Adw.PreferencesGroup({
            title: 'Screen edges',
            description: 'The capsules run to the screen\'s left and right edges, and menus open joined to them.',
        });
        edges.add(switchRow(settings, 'reach-edges', 'Reach screen edges',
            'Left capsule to the left edge, right capsule to the right edge'));
        page.add(edges);

        const bottom = new Adw.PreferencesGroup({
            title: 'Bottom corner',
            description: 'Where a capsule meets the screen\'s edge, at its bottom.',
        });
        const syncBottom = cornerRows(settings, bottom, '', false);
        const same = switchRow(settings, 'top-same-as-bottom', 'Same for the top corner',
            'The top corner as set here. Off: set it on its own below');
        bottom.add(same);
        page.add(bottom);

        const topGroup = new Adw.PreferencesGroup({
            title: 'Top corner',
            description: 'Where a capsule meets the screen\'s edge, at its top.',
        });
        const syncTop = cornerRows(settings, topGroup, 'top-', true);
        page.add(topGroup);

        const syncEdges = () => {
            const on = settings.get_boolean('reach-edges');
            syncBottom(on);
            same.sensitive = on;
            topGroup.visible = !settings.get_boolean('top-same-as-bottom');
            syncTop(on);
        };
        for (const key of ['reach-edges', 'match-windows', 'window-radius-auto', 'top-same-as-bottom',
            'top-match-windows', 'top-window-radius-auto'])
            settings.connect(`changed::${key}`, syncEdges);
        syncEdges();

        const opening = new Adw.PreferencesGroup({title: 'Opening menus'});
        const openOn = new Adw.ComboRow({
            title: 'Open menus',
            model: Gtk.StringList.new(OPEN_ON.map(([, label]) => label)),
        });
        const syncOpenOn = () => {
            const i = Math.max(0, OPEN_ON.findIndex(([value]) => value === settings.get_string('open-on')));
            if (openOn.selected !== i)
                openOn.selected = i;
            openOn.subtitle = OPEN_ON[i][2];
            hoverDelay.sensitive = OPEN_ON[i][0] === 'hover';
            closeDelay.sensitive = OPEN_ON[i][0] !== 'click';
        };
        openOn.connect('notify::selected', () => {
            const value = OPEN_ON[openOn.selected]?.[0];
            if (value && settings.get_string('open-on') !== value)
                settings.set_string('open-on', value);
        });
        const hoverDelay = spinRow(settings, 'hover-delay', 'Hover delay',
            'How long the pointer rests before a menu opens, in milliseconds', {lower: 60, upper: 1000, step: 10});
        const closeDelay = spinRow(settings, 'close-delay', 'Close delay',
            'How long after the pointer leaves a menu opened on hover it closes, in milliseconds',
            {lower: 100, upper: 2000, step: 50});
        settings.connect('changed::open-on', syncOpenOn);
        opening.add(openOn);
        opening.add(hoverDelay);
        opening.add(closeDelay);
        opening.add(choiceRow(settings, 'island-panel-from', 'Island Menu opens from', [
            ['left', 'Left capsule', 'Island Menu\'s launcher grows out of the left capsule'],
            ['centre', 'Middle capsule', 'The launcher grows out of the middle capsule, centred; the left one while the middle one is not shown'],
        ]));
        page.add(opening);
        syncOpenOn();

        const motion = new Adw.PreferencesGroup({title: 'Motion'});
        motion.add(spinRow(settings, 'animation-speed', 'Animation speed',
            '1 is normal, 2 twice as fast, 0.5 half as fast', {lower: 0.5, upper: 2, step: 0.1, digits: 1}));
        motion.add(switchRow(settings, 'bounce', 'Bounce', 'A little overshoot as a menu opens'));
        motion.add(switchRow(settings, 'centre-menus', 'Centre menus',
            'Move a menu to the middle of its glass instead of under its button'));
        page.add(motion);

        this._clockPage(window, settings);
        this._weatherPage(window, settings);
    }

    /** Settings → Weather: its own page. */
    _weatherPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Weather', icon_name: 'weather-few-clouds-symbolic'});
        window.add(page);
        const group = new Adw.PreferencesGroup({
            title: 'Weather',
            description: 'GNOME\'s own weather, for the place set in GNOME Weather.',
        });
        group.add(switchRow(settings, 'weather-enabled', 'Weather in a capsule', 'Its icon and temperature'));
        const where = choiceRow(settings, 'weather-capsule', 'Capsule', [
            ['left', 'Left capsule', 'At the end of the left capsule'],
            ['centre', 'Middle capsule', 'At the end of the middle capsule, after the clock if it is there'],
        ]);
        const glass = switchRow(settings, 'weather-glass', 'Weather on the glass',
            'Rain drops, frost, a warm glare or mist on the capsule, as the sky is. Still, redrawn only as it changes');
        const words = switchRow(settings, 'weather-words', 'Conditions in words', 'Such as "Partly cloudy", after the temperature');
        const rain = switchRow(settings, 'weather-rain-chip', 'Rain coming', 'When rain is due, up to three hours ahead');
        [where, glass, words, rain].forEach(row => group.add(row));
        page.add(group);
        const sync = () => [where, glass, words, rain].forEach(row => (row.sensitive = settings.get_boolean('weather-enabled')));
        settings.connect('changed::weather-enabled', sync);
        sync();
    }

    /** Settings → Clock: its own page. */
    _clockPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Clock', icon_name: 'preferences-system-time-symbolic'});
        window.add(page);

        const clock = new Adw.PreferencesGroup({
            title: 'Clock',
            description: 'A clock of its own in a capsule, shown whatever hides GNOME\'s clock.' +
                (ISLE_INSTALLED ? ' With the bar at the top, Isle\'s island sits in the middle: the left capsule suits it better there.' : ''),
        });
        clock.add(switchRow(settings, 'clock-enabled', 'Clock in a capsule', 'Off: GNOME\'s clock as it is'));
        const hideGnome = switchRow(settings, 'clock-hide-gnome', 'Hide GNOME\'s clock',
            'So the time shows once. Off: GNOME\'s clock left as it is (shown, or hidden by Top Bar Organizer)');
        const where = choiceRow(settings, 'clock-capsule', 'Capsule', [
            ['left', 'Left capsule', 'After the workspaces, at the end of the left capsule'],
            ['centre', 'Middle capsule', 'First in the middle of the bar'],
        ]);
        const style = choiceRow(settings, 'clock-style', 'Style', [
            ['flip', 'Flip digits', 'Small tiles, a changed digit flipping over'],
            ['sun', 'Sun arc', 'A sun or moon on an arc across the day, the time beside it'],
        ]);
        const meridiem = choiceRow(settings, 'clock-flip-meridiem', 'AM and PM', [
            ['stacked', 'Stacked', 'AM over PM, the one it is lit'],
            ['tile', 'Its own tile', 'A flip tile of its own, flipping at noon and midnight'],
        ]);
        const sunLabel = switchRow(settings, 'clock-sun-label', 'AM or PM label',
            'A small AM or PM after the time; off, the arc alone tells (morning left, evening right)');
        const date = switchRow(settings, 'clock-show-date', 'Date', 'The day and date after the time');
        [hideGnome, where, style, meridiem, sunLabel, date].forEach(row => clock.add(row));
        page.add(clock);

        const extras = new Adw.PreferencesGroup({title: 'More'});
        const scroll = switchRow(settings, 'clock-scroll', 'Scroll to switch',
            'Scroll over it for the date and week, then your first world clock, for a few seconds');
        const colours = switchRow(settings, 'clock-sun-colours', 'Sun colours',
            'Golden before sunset, blue at dusk and dawn, a moon at night: from your weather place\'s sunrise and sunset');
        const dnd = switchRow(settings, 'clock-dnd', 'Do Not Disturb moon', 'A small moon while notifications are silenced');
        const copy = switchRow(settings, 'clock-copy', 'Right click copies',
            'Right click copies the date and time, instead of opening the calendar');
        const eventChip = switchRow(settings, 'clock-event-chip', 'Next event',
            'Before an event in your calendar, its name and how soon beside the clock');
        const eventLead = spinRow(settings, 'clock-event-lead', 'Next event shows',
            'How many minutes before it starts', {lower: 1, upper: 120, step: 5});
        settings.connect('changed::clock-event-chip', () => (eventLead.sensitive = settings.get_boolean('clock-event-chip')));
        eventLead.sensitive = settings.get_boolean('clock-event-chip');
        const notifyBadge = choiceRow(settings, 'clock-notify-badge', 'Notifications', [
            ['dot', 'A dot', 'A small dot right of the time while notifications wait'],
            ['count', 'How many', 'Their number right of the time'],
            ['off', 'Nothing', 'None on the clock; still in its panel'],
        ]);
        [notifyBadge, eventChip, eventLead, scroll, colours, dnd, copy].forEach(row => extras.add(row));
        page.add(extras);


        // Only what goes with the style in use, and nothing while the clock is off.
        const sync = () => {
            const on = settings.get_boolean('clock-enabled');
            const sun = settings.get_string('clock-style') === 'sun';
            [hideGnome, where, style, date, extras].forEach(row => (row.sensitive = on));
            meridiem.visible = !sun;
            sunLabel.visible = sun;
            colours.visible = sun;
            meridiem.sensitive = sunLabel.sensitive = on;
        };
        ['clock-enabled', 'clock-style'].forEach(key => settings.connect(`changed::${key}`, sync));
        sync();
    }
}
