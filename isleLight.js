// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Light Isle: Isle's island in light mode too, as Panel Island's Style says, done to Isle as it runs and
// never to its files. Isle is drawn dark throughout; this changes three things, and only while it is on:
//
//  - its glass: the island's backdrop toned as Panel Island's light glass (Island.refreshTheme wrapped);
//  - its fill and rim: a thin white frost and a faint dark hairline (Island._syncShape wrapped);
//  - its text and icons: a light stylesheet made from Isle's own as it is now (so it follows Isle's updates): every rule
//    of the island's (naming it, or of Isle's own classes, taken as inside it), with its white text made GNOME's dark
//    text, its white overlays dark ones and its black fills light, accent and signal colours kept, applied while the
//    island has the class `panel-island-isle-light`. Isle's few colours set in its code stay as they are;
//  - its own white icons (outlines and fills Isle draws white in their files, not symbolic ones the stylesheet
//    colours): dark copies of them in our cache, put on its icons in their place, and Isle's back when it is off.
//
// What Isle paints in code (rings, its bot's face) stays as Isle draws it. Taken off, the island is as Isle draws it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LIGHT_EDGE, lightBlur, lightFill} from './light.js';

const LIGHT_CLASS = 'panel-island-isle-light';

/** A CSS colour as [r, g, b, a] in 0..1, or null (not a plain colour). */
function parseColour(text) {
    const t = text.trim().toLowerCase();
    let m = t.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4)
            h = [...h].map(c => c + c).join('');
        const v = i => parseInt(h.slice(i, i + 2), 16) / 255;
        return [v(0), v(2), v(4), h.length === 8 ? v(6) : 1];
    }
    m = t.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (m)
        return [m[1] / 255, m[2] / 255, m[3] / 255, m[4] === undefined ? 1 : Number(m[4])];
    if (t === 'white')
        return [1, 1, 1, 1];
    if (t === 'black')
        return [0, 0, 0, 1];
    return null;
}

const css = ([r, g, b, a]) =>
    `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Number(a.toFixed(3))})`;

/** How a colour reads on light glass, for `property`: white and near white (text, overlays) dark; black and near black
 * (fills) light; anything with colour (the accent, red, green) as it is. Null: unchanged. */
function lightColour(text, property) {
    const c = parseColour(text);
    if (!c)
        return null;
    const [r, g, b, a] = c;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min > 0.18)
        return null;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma > 0.6) {
        // White text: GNOME's light text (black at 80%) as strong as it was; a white overlay a dark one.
        return property === 'color' ? css([0, 0, 0, 0.8 * a]) : css([0, 0, 0, Math.min(1, a * 0.75)]);
    }
    if (luma < 0.25 && property !== 'color') {
        // A dark fill (a button's, a card's): a light frosted one.
        return css([1, 1, 1, Math.min(0.85, 0.35 + a * 0.35)]);
    }
    return null;
}

const COLOUR_PROPERTIES = new Set(['color', 'background-color', 'border-color', 'border-top-color',
    'border-bottom-color', 'border-left-color', 'border-right-color']);

/** Isle's stylesheet made light (see above): only the island's rules, only what changes. */
export function makeLightStylesheet(source) {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    for (const [, selectorText, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        // The island's rules: those naming it, and those of Isle's own classes (inside it); not the bar's.
        const selectors = selectorText.split(',').map(s => s.trim()).filter(s => s &&
            (s.includes('#isleIsland') || /^\.isle-/.test(s)));
        if (!selectors.length)
            continue;
        const decls = [];
        for (const decl of body.split(';')) {
            const i = decl.indexOf(':');
            if (i < 0)
                continue;
            const property = decl.slice(0, i).trim().toLowerCase();
            let value = decl.slice(i + 1).trim();
            const important = /!important\s*$/.test(value);
            value = value.replace(/!important\s*$/, '').trim();
            let changed = null;
            if (COLOUR_PROPERTIES.has(property)) {
                changed = lightColour(value, property);
            } else if (property === 'border' || property === 'box-shadow' || property.startsWith('border-') &&
                !property.endsWith('radius') && !property.endsWith('width')) {
                // The colour inside a shorthand or a shadow.
                let any = false;
                const replaced = value.replace(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b|\bwhite\b|\bblack\b/g, match => {
                    const light = lightColour(match, property);
                    if (light) {
                        any = true;
                        return light;
                    }
                    return match;
                });
                changed = any ? replaced : null;
            }
            if (changed)
                decls.push(`    ${property}: ${changed}${important ? ' !important' : ''};`);
        }
        if (!decls.length)
            continue;
        // Made stronger than Isle's own: the island's id with the class, before a class of Isle's (in the island).
        const lit = selectors.map(s => s.includes('#isleIsland')
            ? s.replace(/#isleIsland(?![\w-])/g, `#isleIsland.${LIGHT_CLASS}`)
            : `#isleIsland.${LIGHT_CLASS} ${s}`);
        out.push(`${lit.join(',\n')} {\n${decls.join('\n')}\n}`);
    }
    return `/* Made by Panel Island from Isle's stylesheet: its island in light mode (isleLight.js). */\n\n${out.join('\n\n')}\n`;
}

/** GNOME's dark text on light (black at 80%), as a solid colour an icon file can hold. */
const DARK_INK = '#333333';

/** An icon file of Isle's drawn for light glass: white made dark, black details on white made white; a mask (its
 * cut-outs) left as it is. Null: an icon with colours of its own (a brand's, the green of a call), left as it is. */
function lightIcon(svg) {
    const colours = (svg.replace(/<mask[\s\S]*?<\/mask>/g, '').match(/#[0-9a-f]{3,8}\b|\b(white|black)\b/gi) ?? [])
        .map(c => c.toLowerCase());
    const white = c => ['#fff', '#ffffff', 'white'].includes(c), black = c => ['#000', '#000000', 'black'].includes(c);
    if (!colours.length || !colours.every(c => white(c) || black(c)) || !colours.some(white))
        return null;
    return svg.split(/(<mask[\s\S]*?<\/mask>)/).map(part => part.startsWith('<mask') ? part
        : part.replace(/(["':\s])(#[0-9a-f]{3,8}|white|black)\b/gi, (m, pre, c) =>
            white(c.toLowerCase()) ? pre + DARK_INK : black(c.toLowerCase()) ? `${pre}#ffffff` : m)).join('');
}

/** Isle's white icons and their light copies (made in our cache), both ways: `{light, dark}`, path → `Gio.FileIcon`. */
function lightIcons(iconDir) {
    const light = new Map(), dark = new Map();
    if (!iconDir?.query_exists(null))
        return {light, dark};
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'panel-island', 'isle-icons-light']);
    GLib.mkdir_with_parents(dir, 0o700);
    const files = iconDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = files.next_file(null));) {
        const name = info.get_name();
        // A symbolic one is coloured by the stylesheet already.
        if (!name.endsWith('.svg') || name.includes('-symbolic'))
            continue;
        try {
            const file = iconDir.get_child(name);
            const made = lightIcon(new TextDecoder().decode(file.load_contents(null)[1]));
            if (!made)
                continue;
            const copy = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
            copy.replace_contents(new TextEncoder().encode(made), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            light.set(file.get_path(), new Gio.FileIcon({file: copy}));
            dark.set(copy.get_path(), new Gio.FileIcon({file}));
        } catch (e) {
            console.warn(`[panel-island] Isle's icon ${name} not made light: ${e}`);
        }
    }
    files.close(null);
    return {light, dark};
}

/**
 * Puts it on Isle's `Island` class (`Theme`: Isle's theme module; `stylesheet`: Isle's stylesheet file; `isLight()`:
 * whether Isle is to be light now; `tint()`: Glass strength, as Panel Island's). Returns `{sync(), undo()}` (`sync`: light or dark again, as `isLight()` now says),
 * or null if Isle no longer has what it changes.
 */
export function lightIsle(Island, Theme, stylesheet, isLight, tint = () => 0) {
    const proto = Island?.prototype;
    if (!proto || typeof proto._syncShape !== 'function' || typeof proto.refreshTheme !== 'function' ||
        typeof Theme?.blur !== 'function')
        return null;
    // The light stylesheet, made from Isle's and kept in our cache, loaded while it is on.
    let file = null;
    try {
        const [, bytes] = stylesheet.load_contents(null);
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'panel-island']);
        GLib.mkdir_with_parents(dir, 0o700);
        file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'isle-light.css']));
        file.replace_contents(new TextEncoder().encode(makeLightStylesheet(new TextDecoder().decode(bytes))), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) {
        console.warn(`[panel-island] Isle's light stylesheet could not be made: ${e}`);
        file = null;
    }
    const themeContext = St.ThemeContext.get_for_stage(global.stage);
    let loaded = false;
    const loadStylesheet = on => {
        if (!file || on === loaded)
            return;
        try {
            const theme = themeContext.get_theme();
            if (on)
                theme.load_stylesheet(file);
            else
                theme.unload_stylesheet(file);
            loaded = on;
        } catch (e) {
            console.warn(`[panel-island] Isle's light stylesheet could not be ${on ? 'loaded' : 'unloaded'}: ${e}`);
        }
    };

    // Its white icons: their light copies on its icons while it is light, Isle's own back after (see above).
    let icons = {light: new Map(), dark: new Map()};
    try {
        icons = lightIcons(stylesheet.get_parent()?.get_child('icons'));
    } catch (e) {
        console.warn(`[panel-island] Isle's icons not made light: ${e}`);
    }
    const watchTag = {};
    const watched = new Set();
    const swapIcon = actor => {
        const path = actor.gicon instanceof Gio.FileIcon ? actor.gicon.get_file().get_path() : null;
        const swapped = path && (isLight() ? icons.light : icons.dark).get(path);
        if (swapped)
            actor.gicon = swapped;
    };
    // Every icon in the island, and every one Isle adds or changes later (its pages are made as they open).
    const watch = actor => {
        if (watched.has(actor))
            return;
        watched.add(actor);
        actor.connectObject('destroy', () => watched.delete(actor),
            'child-added', (_, child) => watch(child), watchTag);
        if (actor instanceof St.Icon) {
            actor.connectObject('notify::gicon', () => swapIcon(actor), watchTag);
            swapIcon(actor);
        }
        actor.get_children().forEach(watch);
    };
    const swapAll = () => watched.forEach(actor => actor instanceof St.Icon && swapIcon(actor));
    const unwatch = () => {
        watched.forEach(actor => actor.disconnectObject(watchTag));
        watched.clear();
    };

    const saved = {
        _syncShape: Object.getOwnPropertyDescriptor(proto, '_syncShape'),
        refreshTheme: Object.getOwnPropertyDescriptor(proto, 'refreshTheme'),
    };
    const syncShape = saved._syncShape.value, refreshTheme = saved.refreshTheme.value;
    proto._syncShape = function (...args) {
        const result = syncShape.apply(this, args);
        try {
            if (isLight()) {
                // The same light glass as Panel Island's (light.js), at the same Glass strength.
                this._fill?.setUniforms({fill: lightFill(tint()), edge: [...LIGHT_EDGE.color, 1],
                    edgeAlpha: [LIGHT_EDGE.top, LIGHT_EDGE.bottom]});
                this.add_style_class_name(LIGHT_CLASS);
                if (icons.light.size)
                    watch(this);
            } else {
                this.remove_style_class_name(LIGHT_CLASS);
            }
        } catch (e) {
            console.warn(`[panel-island] Isle's island not made light: ${e}`);
        }
        return result;
    };
    proto.refreshTheme = function (...args) {
        const result = refreshTheme.apply(this, args);
        try {
            if (isLight() && this._backdrop && Theme.blur())
                this._backdrop.look = lightBlur(Theme.blur(), tint());
        } catch (e) {
            console.warn(`[panel-island] Isle's island glass not made light: ${e}`);
        }
        return result;
    };

    /** Every island there is now (Isle's, by its name), each made anew in its look. */
    const islands = () => {
        const found = [];
        const walk = actor => {
            if (actor instanceof Island)
                found.push(actor);
            else
                actor.get_children?.().forEach(walk);
        };
        walk(Main.layoutManager.uiGroup);
        return found;
    };
    const refresh = () => islands().forEach(island => {
        try {
            island.refreshTheme();
            island._syncShape();
        } catch (e) {
            console.warn(`[panel-island] Isle's island not drawn anew: ${e}`);
        }
    });

    const sync = () => {
        loadStylesheet(isLight());
        refresh();
        // Light: each island watched (in `_syncShape`), its icons light. Dark: Isle's own back, none watched.
        swapAll();
        if (!isLight())
            unwatch();
    };
    sync();
    return {
        sync,
        undo: () => {
            Object.defineProperty(proto, '_syncShape', saved._syncShape);
            Object.defineProperty(proto, 'refreshTheme', saved.refreshTheme);
            loadStylesheet(false);
            unwatch();
            islands().forEach(island => {
                island.remove_style_class_name(LIGHT_CLASS);
                // Isle's own icons back.
                const walk = actor => {
                    const path = actor instanceof St.Icon && actor.gicon instanceof Gio.FileIcon
                        ? actor.gicon.get_file().get_path() : null;
                    if (path && icons.dark.has(path))
                        actor.gicon = icons.dark.get(path);
                    actor.get_children().forEach(walk);
                };
                walk(island);
            });
            refresh();
        },
    };
}
