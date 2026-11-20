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
        capsules.add(switchRow(settings, 'flat-buttons', 'Flat buttons',
            'No shading on a button under the pointer or pressed'));
        page.add(capsules);

        const isle = new Adw.PreferencesGroup({
            title: 'Isle',
            description: 'Changes to Isle itself, made as it runs. Its files are never touched; turned off, or should Isle change so they no longer apply, Isle is as it always is.',
        });
        isle.add(switchRow(settings, 'patch-isle-overview', 'Keep Isle\'s glass in the overview',
            'Isle\'s island stays blurred in the overview and as workspaces switch, blurring what is really behind it'));
        isle.add(switchRow(settings, 'patch-isle-lighter', 'Lighter blur updates',
            'A window just below the bar, a video in it, no longer has Isle\'s glass blurred again every frame'));
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
        page.add(opening);
        syncOpenOn();

        const motion = new Adw.PreferencesGroup({title: 'Motion'});
        motion.add(spinRow(settings, 'animation-speed', 'Animation speed',
            '1 is normal, 2 twice as fast, 0.5 half as fast', {lower: 0.5, upper: 2, step: 0.1, digits: 1}));
        motion.add(switchRow(settings, 'bounce', 'Bounce', 'A little overshoot as a menu opens'));
        motion.add(switchRow(settings, 'centre-menus', 'Centre menus',
            'Move a menu to the middle of its glass instead of under its button'));
        page.add(motion);
    }
}
