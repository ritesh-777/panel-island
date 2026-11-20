// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ritesh Seth
//
// Settings → Style for the bar's menus: a menu opened on the capsules' glass drawn light or dark as the capsules are,
// even when GNOME's own style (Settings → Appearance) is the other one. GNOME draws every menu in one stylesheet, light
// or dark; this makes, from the shell theme's own two (GNOME's or Yaru's, as the session has it), what the other one
// changes — only colours (text, fills, borders, shadows), only where the two differ — each rule kept for actors inside
// a menu with the class `panel-island-scheme-light` or `panel-island-scheme-dark` (put on its boxpointer). So a menu
// looks as GNOME would draw it in that style, whatever the theme is.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const SCHEME_CLASS = {light: 'panel-island-scheme-light', dark: 'panel-island-scheme-dark'};

/** The shell theme's stylesheet `name` (as GNOME's main.js finds it), or null. */
function stylesheet(name) {
    const candidates = [Gio.File.new_for_uri(`resource:///org/gnome/shell/theme/${name}`),
        ...GLib.get_system_data_dirs().map(dir => Gio.File.new_for_path(GLib.build_filenamev([dir, 'gnome-shell', 'theme', name]))),
        Gio.File.new_for_path(`${global.datadir}/theme/${name}`)];
    return candidates.find(file => file.query_exists(null)) ?? null;
}

/** The theme's light and dark stylesheets, as GNOME picks them for each style (`-light.css`, else the plain one). */
function stylesheets() {
    const name = Main.sessionMode.stylesheetName ?? 'gnome-shell.css';
    const variant = v => stylesheet(name.replace('.css', `-${v}.css`));
    const plain = stylesheet(name);
    return {light: variant('light') ?? plain, dark: variant('dark') ?? plain};
}

const read = file => new TextDecoder().decode(file.load_contents(null)[1]);

/** What draws colour: these alone are taken. */
const isColour = p => p.includes('color') || p.startsWith('background') || p === 'box-shadow' || p === 'text-shadow' ||
    p === 'icon-shadow' || p === 'outline' || /^border(-(top|bottom|left|right))?$/.test(p);

/** A stylesheet as `selector → {property: value}`, each selector of a group on its own, later rules winning. */
function parse(text) {
    const rules = new Map();
    text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/g, '');
    for (const [, selectorText, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (selectorText.trim().startsWith('@'))
            continue;
        const decls = {};
        for (const decl of body.split(';')) {
            const i = decl.indexOf(':');
            if (i < 0)
                continue;
            const property = decl.slice(0, i).trim().toLowerCase();
            if (isColour(property))
                decls[property] = decl.slice(i + 1).trim();
        }
        if (!Object.keys(decls).length)
            continue;
        for (const selector of selectorText.split(',').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean)) {
            const at = rules.get(selector) ?? {};
            rules.set(selector, Object.assign(at, decls));
        }
    }
    return rules;
}

/** What a menu of the bar can hold (GNOME's menus, Quick Settings, the calendar and its messages, others' menus). */
const IN_MENU = /^(stage|\*)$|popup|quick-|calendar|datemenu|message|notification|events|world-clock|weather|slider|toggle|check-?box|switch|button|separator|dnd|media|power|privacy|background-app|header|^\.(icon|label)/;
// Never in a menu: the bar, the overview, dialogs, the lock and login screens, OSDs, the dash, windows.
const NOT_IN_MENU = /#panel\b|overview|workspace|dash|app-grid|search|dialog|unlock|login|screen-shield|osd|switcher|window-|lightbox|keyboard-|ripple|tile-preview|candidate|magnifier|pad-|lookingglass|screenshot|parental|^\.app-/i;

/** The menu itself (its boxpointer and its box), not what is in it. */
const MENU_ITSELF = /(^|\s|>)\.(popup-menu|popup-menu-boxpointer|popup-menu-content|quick-settings)(\.[\w-]+)*(:[\w-]+)*$/;

/** `selector` kept inside an actor with class `cls`: under it, and (its first part a class) on it too. */
function scoped(selector, cls) {
    if (selector === 'stage' || selector === '*')
        return [`.${cls}`];
    if (selector.startsWith('stage '))
        return [`.${cls} ${selector.slice(6)}`];
    const out = [`.${cls} ${selector}`];
    const m = selector.match(/^(\.[^\s>:]+)(.*)$/);
    if (m && /popup-menu|quick-settings/.test(m[1]))
        out.push(`${m[1]}.${cls}${m[2]}`);
    return out;
}

/** The stylesheet drawing a menu with class `SCHEME_CLASS[scheme]` as `scheme` (its colours, where they differ). */
function make(scheme, sheets) {
    const want = parse(read(sheets[scheme]));
    const other = parse(read(sheets[scheme === 'light' ? 'dark' : 'light']));
    const cls = SCHEME_CLASS[scheme];
    const out = [];
    for (const [selector, decls] of want) {
        if (!IN_MENU.test(selector) || NOT_IN_MENU.test(selector))
            continue;
        const theirs = other.get(selector) ?? {};
        // The menu's own background, border, shadow and arrow never: the glass is them (stylesheet.css).
        const own = MENU_ITSELF.test(selector);
        const changed = Object.entries(decls).filter(([p, v]) => theirs[p] !== v && !p.startsWith('-arrow-') &&
            !(own && (p.startsWith('background') || p.startsWith('border') || p === 'box-shadow')));
        if (changed.length)
            out.push(`${scoped(selector, cls).join(',\n')} {\n${changed.map(([p, v]) => `    ${p}: ${v};`).join('\n')}\n}`);
    }
    return `/* Made by Panel Island from the shell theme's ${scheme} stylesheet: menus drawn ${scheme} (menuScheme.js). */\n\n${out.join('\n\n')}\n`;
}

/**
 * Makes both (once, as Panel Island starts). Returns `{use(scheme), unload()}`: `use` loads the one for a menu drawn
 * 'light' or 'dark' against GNOME's own style, or none (null); null if the theme has no light and dark stylesheets of
 * its own (then menus stay as GNOME draws them).
 */
export function loadMenuSchemes() {
    const sheets = stylesheets();
    if (!sheets.light || !sheets.dark || sheets.light.equal(sheets.dark))
        return null;
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'panel-island']);
    GLib.mkdir_with_parents(dir, 0o700);
    const files = [];
    for (const scheme of ['light', 'dark']) {
        try {
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, `menus-${scheme}.css`]));
            file.replace_contents(new TextEncoder().encode(make(scheme, sheets)), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            files.push(file);
        } catch (e) {
            console.warn(`[panel-island] Menus can't be drawn ${scheme}: ${e}`);
        }
    }
    // Only the one in use is loaded, and only while a menu is drawn in the other style from GNOME's (each loaded rule
    // is looked at whenever anything in the shell is styled anew). Into whichever theme there is: GNOME carries
    // custom stylesheets over when it changes theme.
    const theme = () => St.ThemeContext.get_for_stage(global.stage).get_theme();
    const byScheme = Object.fromEntries(files.map(file => [file.get_basename().includes('light') ? 'light' : 'dark', file]));
    let loaded = null;
    const use = scheme => {
        const want = scheme ? byScheme[scheme] ?? null : null;
        if (want === loaded)
            return;
        try {
            if (loaded)
                theme().unload_stylesheet(loaded);
        } catch {}
        loaded = null;
        if (!want)
            return;
        try {
            theme().load_stylesheet(want);
            loaded = want;
        } catch (e) {
            console.warn(`[panel-island] Menu stylesheet not loaded: ${e}`);
        }
    };
    return {
        /** The style menus are forced to now ('light', 'dark'), or null (as GNOME's own: none loaded). */
        use,
        unload: () => use(null),
    };
}
