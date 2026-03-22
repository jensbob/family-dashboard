# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a single-file family dashboard (`index.html`) designed to run full-screen in a browser (e.g., on a wall-mounted display). There is no build system, no dependencies to install, and no tests. Everything lives in one HTML file with inline CSS and JavaScript.

## Development

Open `index.html` directly in a browser. There is no build step, dev server, or package manager.

## Architecture

The entire application is `index.html` — a self-contained page with three sections:

- **`<style>`** — All CSS, including two visual modes: standard (blurred glass cards over rotating Unsplash backgrounds) and birthday mode (dark purple with canvas confetti, no backdrop blur).
- **`<body>`** — Two-column layout: left glass card (clock, weather, word of the day, alert history, birthday countdown) and right panel (analog clock or birthday display).
- **`<script>`** — All application logic inline.

### Key JavaScript Systems

**Clock & Date** — `updateTime()` runs every second, drives both the digital clock (`#clock`) and the analog clock hands via CSS transforms. Daily content (word of the day, birthday countdown) recalculates only when the date changes.

**Birthday Mode** — `birthdays` object maps `"MM-DD"` strings to names. `checkBirthday()` runs every second but only touches the DOM when mode changes. Birthday mode swaps the right panel from analog clock to a birthday display, replaces the background with a canvas confetti animation, and removes backdrop-filter blur (prevents flicker with canvas).

**Weather** — Fetches from `https://api.open-meteo.com/v1/forecast` using `currentLat`/`currentLon`. Refreshes every 30 minutes.

**City Picker** — City list loaded from the Cloudflare Worker `/cities` endpoint. Selected city persisted to `localStorage` (`selectedCity`). Changing city updates weather and alert history immediately.

**Rocket Alert System (OREF)** — Polls the Cloudflare Worker `/oref` endpoint every 3 seconds. Deduplicates alerts by ID using `localStorage` (`seenAlertIds`, 2-hour window). Three alert states: `warning` (orange pulse + chime), `alert` (red pulse + siren), `allclear` (green + ascending chime, auto-dismisses after 15s). All audio synthesized via Web Audio API — no audio files.

**Alert History** — Fetches `/history` from the worker every 5 minutes, displays up to 3 recent alerts for the selected city.

**Background Cycling** — Rotates through 25 Unsplash nature photos every 10 minutes with a 1-second crossfade. In birthday mode, images still cycle silently so the transition is instant when birthday mode ends.

### Cloudflare Worker Backend

Base URL: `https://yellow-waterfall-020a.jb-jens-jb.workers.dev`

| Endpoint | Purpose |
|----------|---------|
| `/cities` | Returns `{ cities: { [key]: {en, he, lat, lng} } }` — Israeli city list for the alert system |
| `/oref` | Proxies Israel's Home Front Command (Pikud HaOref) real-time alert API |
| `/history` | Returns recent alert events array; each event has `.alerts[]` with `.cities`, `.threat`, `.time`, `.isDrill` |

The worker exists to bypass CORS on the OREF API. The worker code lives separately (not in this repo).

### Alert Threat Types

OREF category numbers map to threat types in `alertTypes`. Categories `1` (missiles) and `2` (aircraft) trigger full red alert; category `10` with specific Hebrew title strings triggers either early warning or all-clear.

### localStorage Keys

- `selectedCity` — `{en, he, lat, lon}` of the user-selected city
- `seenAlertIds` — dedup map of `alertId → timestamp` (pruned to 2-hour window)
- `orefLog` — debug log of last 50 raw OREF payloads (read with `JSON.parse(localStorage.getItem('orefLog'))`)
