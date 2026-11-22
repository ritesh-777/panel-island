# Panel Island

[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-51-blue.svg)](https://gnome.org)
[![License](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](LICENSE)
[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?style=flat&logo=github-sponsors)](https://github.com/sponsors/ritesh-777)

Glass islands for the GNOME top bar.

Panel Island puts a glass capsule round the left, middle and right items of the top bar, and opens their menus as
glass that grows out of the capsule, the way a dynamic island opens. Quick Settings, the calendar, tray menus and
the app menu all drop out of their island instead of appearing as separate popups.

It is made to sit beside [Isle](https://github.com/zickrian/isle), and works just as well without it. With Isle, the
side capsules share Isle's glass and follow its look, and Isle's island keeps the clock in the middle. Without Isle,
Panel Island draws the whole bar itself.

## Quick Links

- [Requirements](#requirements)
- [Installation](#installation)
- [Settings](#settings)
- [Working With Isle](#working-with-isle)
- [How It Works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Acknowledgments](#acknowledgments)

## What You Get

- **Three capsules**: round the bar's left, middle and right items, each on or off.
- **Menus that grow out of their capsule** as one piece of glass, on hover or on click, with a little bounce.
- **Pill or notch**: floating in the bar, or joined to the top of the screen, or the same shape as Isle's island.
- **Glass or black**, with glass strength, edge light and edge blur of its own.
- **Edge to edge**: the side capsules can run to the screen's sides, their corners rounded, square or flaring down
  the screen's side, optionally matching your windows' corners.
- **Light or dark**: follows GNOME's style or is set on its own, and the bar's menus are drawn in the same style,
  whatever GNOME's is.
- **Light workspace switches**: the glass holds still while a workspace slides and blurs again once it stops, much
  lighter on the CPU (or follows the slide live, if you prefer).
- **A home for Island Menu's workspace features**: with [Island Menu](https://github.com/ritesh-777/island-menu), the
  workspace peek, workspace numbers, drag to workspaces and the attention glow grow out of the left capsule.
- **Flat buttons**: no hover shading on the buttons in a capsule; the glass is the feedback.
- **The top bar's colour while Isle is off**, from see-through to black.
- **Optional additions to Isle**, made while it runs and never to its files.

## Requirements

- **GNOME Shell 51**

Optional:

- [Isle](https://github.com/zickrian/isle): the capsules share its glass and look, and its island holds the clock.
- [Rounded Window Corners](https://github.com/ztrahmet/rounded-window-corners): its corner radius is used when the
  capsules match your windows' corners. Without it, libadwaita's 15 px is used.

## Installation

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/ritesh-777/panel-island/main/install.sh | bash
```

Then log out and back in, and enable the extension:

```bash
gnome-extensions enable panel-island@ritesh
```

Running the same command again updates it to the latest version.

### Local Install

```bash
git clone https://github.com/ritesh-777/panel-island.git
cd panel-island
./install.sh
```

Log out and back in, then enable it from the Extensions app.

### Uninstalling

```bash
gnome-extensions disable panel-island@ritesh
rm -rf ~/.local/share/gnome-shell/extensions/panel-island@ritesh
```

## Settings

Open the Extensions app, find **Panel Island**, and click the settings button. Settings take effect at once.

### Capsules

- **Style** — Follow GNOME, Light or Dark. The bar's menus opened on the glass (Quick Settings, the calendar) are drawn
  in the same style, even when GNOME's own is the other one.
- **Shape** — Pill (floating in the bar), Notch (joined to the top of the screen), or Like Isle.
- **Look** — Glass, Black, or Like Isle.
- **Glass as strong as Isle's** — Follows Isle's Glass tint. Off, **Glass strength** sets it here, from clear to
  dark.
- **Edge light** — Even all round the edge, or Directional, lit from the top left as Isle's.
- **Edge blur** — Fades into clear glass towards the screen's edge, or stays solid to it.
- **Left capsule / Right capsule** — Each side on or off. A side turned off looks and opens as GNOME's.
- **Middle capsule** — Automatic (only while Isle is off), On or Off.
- **Keep GNOME's Activities button** — Shown even when another extension hides it, such as O-tiling's workspace
  numbers, so both sit side by side.
- **Flat buttons** — No shading on a button under the pointer or pressed.

### Workspace Switches

- **Glass during workspace switches** — **Still** (the default): the glass holds still while a workspace slides and
  blurs again once it stops, much lighter on the CPU. **Still on battery**: still on battery, following the slide on
  mains power. **Live**: follows the slide as it moves, smoothest and heaviest.

### Workspaces

The workspace peek, workspace numbers, drag to workspaces and attention glow are now part of
[Island Menu](https://github.com/ritesh-777/island-menu), and are set there. They are drawn on Panel Island's left
capsule while both are on; Panel Island hands them its glass, and nothing else is needed. Settings you had for them
here are carried over to Island Menu the first time it starts.

### Top Bar

The bar's colour while Isle is off. With Isle on, Isle colours the bar itself.

- **Colour** — Like Isle (Isle's own Top bar settings), Coloured (see-through to black, with white text), or the
  theme's own.
- **Opacity** — 0 is see-through, 100 is black.
- **Hide GNOME's clock** — off by default: GNOME's own clock in the bar hidden, whatever else is on (Isle's island
  keeps its own clock).
- **Bar at the bottom** — off by default. Moves GNOME's top bar to the bottom of the main display. The capsules sit
  on the screen's bottom edge, and menus (and Island Menu's launcher and workspace peek) open upwards in glass
  growing out of them. Windows keep clear of the bar there, as GNOME does at the top. The "top corner" settings under
  Screen Edges are for the corner at the screen's edge, which is then the bottom one. Isle's island stays at the top
  of the screen as a notch of its own, as on a display with no bar: Isle does this itself, and nothing of Isle's is
  changed. While the screen is locked the bar is back at the top (extensions are off there).

### Screen Edges

- **Reach screen edges** — The side capsules run to the screen's sides.
- **Bottom corner / Top corner** — The corner at the screen's side, each set apart or the top the same as the
  bottom:
  - **Corner radius** — Positive rounds it in, 0 leaves it square, negative flares it out along the screen's side
    (−48 to 48 px).
  - **Match window corners** — Sized from your windows' corners: round as they are, or flared to follow a window
    below the bar at an even gap.
  - **Window radius from Rounded Window Corners**, or a **Window corner radius** set by hand.

### Clock

A page of its own. A clock of Panel Island's own in a capsule, shown whatever hides GNOME's clock (Top Bar
Organizer's hide list, Isle's island). It is a clock to read: clicking it opens nothing.

- **Clock in a capsule** — off by default.
- **Hide GNOME's clock** — on by default, so the time shows once; off leaves GNOME's clock to whatever else says.
- **Capsule** — the left one (at its end) or the middle one (first in the middle of the bar; with the bar at the top,
  Isle's island sits there).
- **Style** — **Flip digits** (small tiles, a changed digit flipping over) or **Sun arc** (a sun or moon on an arc
  across the day, the time beside it).
- **AM and PM** (12-hour clocks) — with flip digits, stacked (the current one lit) or a tile of its own; with the sun
  arc, a small label, or none (morning on the arc's left, evening on its right).
- **Date** — the day and date after the time.
- **Scroll to switch** — the date and week, then your first world clock, for a few seconds.
- **Sun colours** — golden before sunset, blue at dusk and dawn, a moon at night, from your weather place's sunrise
  and sunset (6 and 18 o'clock without one).
- **Next event** — before an event with a time in your calendar, its name and how soon ("Standup · 12 min") beside the
  clock, from 15 minutes before (your choice, 1 to 120) until a minute after it starts.
- **Notifications** — while notifications wait, a dot (or how many) right of the time, as GNOME's own dot counts
  them; none with Do Not Disturb.
- **Do Not Disturb moon** and **Right click copies** the date and time.

It changes once a minute and keeps its width between changes, so its capsule never moves with the time.

### Weather

A page of its own. GNOME's own weather (for the place set in GNOME Weather) in the left or the middle capsule.

- **Weather in a capsule** — off by default: its icon and temperature; hidden while there is no weather to show.
- **Capsule** — the end of the left capsule, or of the middle one (after the clock if it is there).
- **Weather on the glass** — the capsule's glass takes on the sky: drops of rain, frost when it is cold, a warm glare
  in sun, mist in fog, a few stars on a clear night. Still, never moving, redrawn only as the sky changes.
- **Conditions in words** and **Rain coming** ("Rain ~4 PM", up to three hours ahead, from the hourly forecast).
- Clicking it opens nothing. The weather is asked for every half hour.

### Opening Menus

- **Open menus** — On hover, on click, or Like Isle.
- **Island Menu opens from** — The left capsule (default) or the middle one. With the middle one, Island Menu's
  launcher is centred under it (above it with the bar at the bottom), its glass growing out of that capsule. Only the
  launcher moves: the workspace peek stays with the left capsule. While the middle capsule is not shown (Middle
  capsule set to Automatic with Isle on and the bar at the top), the left one is used.
- **Hover delay** — How long the pointer rests before a menu opens.
- **Close delay** — How long after the pointer leaves a menu opened on hover it closes.

### Motion

- **Animation speed** — 1 is normal, 2 twice as fast, 0.5 half as fast.
- **Bounce** — A little overshoot as a menu opens.
- **Centre menus** — A menu moves to the middle of its glass instead of sitting under its button.

### Isle

Shown only with Isle installed. Each one changes Isle as it runs and never its files.

- **Light Isle** — Isle's island light too when the Style above is light: its glass, text and icons, including Isle's
  own white icons, drawn dark on the light glass.
- **Keep Isle's glass in the overview** — Isle's island stays blurred in the overview and while switching
  workspaces, blurring what is really behind it.
- **Lighter blur updates** — A window just below the bar, a video playing in it, no longer has Isle's glass blurred
  again every frame.
- **Weather on Isle's Calendar page** — Today's weather beside the date, and the day's weather in full on a click,
  for the place set in GNOME Weather.
- **Smooth Isle's notch corners** — Isle's notch drawn with Panel Island's own corners, without the seam where its
  shoulders meet.
- **Isle's edge blur** — With smooth corners on: fades into clear glass at the screen's edge, as Isle draws it, or
  solid to the edge.

## Working With Isle

Panel Island never changes Isle's files, and Isle works the same with it or without it.

- **With Isle installed**, Panel Island loads Isle's own glass code, so both look the same and follow the same
  settings.
- **Without Isle**, it uses its own copy of Isle's glass (in `glass/`), so it looks the same.
- **Isle turned on or off** while the shell runs: the middle capsule and the top bar's colour hand over at once,
  with no need to log out.
- **The additions to Isle** are put on only while Isle runs, each can be turned off, and each first checks that Isle
  still has what it changes. If an Isle update changes it, that addition is skipped, a line is written to the log,
  and Isle works as usual.

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│                         GNOME Shell                          │
│                                                              │
│   Top bar: left box        middle box        right box       │
│        │                       │                  │          │
│        ▼                       ▼                  ▼          │
│   ┌─────────┐            ┌──────────┐        ┌─────────┐     │
│   │ Capsule │            │ Capsule  │        │ Capsule │     │
│   └────┬────┘            └────┬─────┘        └────┬────┘     │
│        └──────────────────────┼───────────────────┘          │
│                               ▼                              │
│                   ┌───────────────────────┐                  │
│                   │ Glass: Isle's, or its │                  │
│                   │ own copy in glass/,   │                  │
│                   │ cut to shape corner   │                  │
│                   │ by corner             │                  │
│                   └───────────┬───────────┘                  │
│                               ▼                              │
│       A menu opens: one glass shape grows from its capsule   │
│       down round the menu, and back as it closes             │
└──────────────────────────────────────────────────────────────┘
```

- **Each capsule** follows the items in its box, and is drawn once and kept: the bar redrawing round it (a clock
  ticking, Isle's island animating) paints the kept picture again instead of blurring it again.
- **The glass** blurs a copy of the wallpaper and the windows under it, and cuts it to the capsule's shape with a
  shader of Panel Island's own, which shapes each corner apart (round, square, or flaring along an edge).
- **In the overview and while switching workspaces**, the glass blurs a copy of GNOME's own scene, so it shows what
  is really behind it.
- **A menu** is given no background of its own while open; the glass under it is its background.

## Troubleshooting

### The extension does not appear

1. Check the folder is at `~/.local/share/gnome-shell/extensions/panel-island@ritesh/`
2. Recompile the schema:
   `glib-compile-schemas ~/.local/share/gnome-shell/extensions/panel-island@ritesh/schemas/`
3. Log out and back in

### New settings do not show up

Close the Extensions app and open it again: it keeps the old settings window until it is restarted.

### Something looks wrong

Check the log for Panel Island's lines:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep panel-island
```

A line saying Isle's glass has changed means an Isle update changed something an addition relies on: that addition
is skipped and Isle works as usual.

## Support

If Panel Island has made your desktop nicer, consider supporting its development:

- [Sponsor on GitHub Sponsors](https://github.com/sponsors/ritesh-777)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the GNU General Public License v3.0 or later — see the [LICENSE](LICENSE) file for
details.

## Acknowledgments

- [Isle](https://github.com/zickrian/isle) by zickrian (GPL-3.0-or-later):
  - the glass in `glass/` is copied from Isle 1.7.3;
  - the shader in `shape.js` is built from Isle's glass shader, its tone, lens and rim kept as Isle's;
  - the top bar's colour rules in `stylesheet.css` come from Isle's stylesheet;
  - the capsules' measurements and look follow Isle's island.
- GNOME Shell Extensions framework
