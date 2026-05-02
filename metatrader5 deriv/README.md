# Deriv MT5 — Placed Order Price Diff Tracker

A Tampermonkey userscript that monitors pending limit orders on the Deriv MT5 web terminal and alerts you in real time when the market price is approaching your order's open price — with row highlighting, audio beeps, system notifications, an in-page popup notification, and a live status widget.

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [How It Works](#how-it-works)
- [Visual Indicators](#visual-indicators)
- [Alert System](#alert-system)
  - [Audio](#audio)
  - [System Notification](#system-notification)
  - [In-page Popup Notification](#in-page-popup-notification)
  - [Alert Log](#alert-log)
  - [Cooldown](#cooldown)
- [Status Indicator Widget](#status-indicator-widget)
  - [The Pill](#the-pill)
  - [The Panel](#the-panel)
  - [Stats Section](#stats-section)
  - [Alert Log Section](#alert-log-section)
  - [Settings Section](#settings-section)
  - [About Section](#about-section)
- [Adaptive Threshold Logic](#adaptive-threshold-logic)
- [Column Detection](#column-detection)
- [DOM Rendering Note](#dom-rendering-note)
- [Configuration Reference](#configuration-reference)
- [Debugging](#debugging)
- [Limitations](#limitations)

---

## Overview

The script runs every **5 seconds** inside the Deriv MT5 web terminal (`mt5-real01-web-svg.deriv.com`) and scans the pending orders table for rows whose `Profit` column reads `Placed`. For each such row it computes the absolute difference between the **Open Price** (your limit order price) and the **Close Price** (the current live market price), then compares that difference against two adaptive thresholds derived from the order's own open price. Rows are highlighted yellow or red depending on how close the market is to triggering the order, and an audio + desktop notification alert fires when a row enters the red zone.

Rows are highlighted yellow or red depending on proximity to trigger. When a row enters the red zone the script fires three simultaneous alerts: an audio beep sequence, a desktop system notification, and an in-page popup notification card. A live status widget fixed to the top-right corner shows at-a-glance counts and a full monitoring panel on click.

---

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open the Tampermonkey dashboard → **Create a new script**.
3. Delete the default template and paste the full contents of `deriv_price_diff_tracker.user.js`.
4. Save (`Ctrl + S`).
5. Navigate to `http://mt5-real01-web-svg.deriv.com` or `https://mt5-real01-web-svg.deriv.com`.
6. When prompted, click **Allow** to grant desktop notification permission.

> The script will **not run on any other site**. Both the `@match` directives in the header and a runtime hostname guard (`window.location.hostname !== 'mt5-real01-web-svg.deriv.com'`) ensure this.

---

## How It Works

### Startup sequence

On page load (`@run-at document-end`) the script:

1. Checks the hostname and exits immediately if not on the target site.
2. Requests browser notification permission if not already granted.
3. Builds and injects the status indicator widget and all CSS into the page.
4. Waits **10 seconds** for the Svelte app to finish rendering the table, then runs the first scan.
5. Schedules a repeat scan every **5 seconds** via `setInterval`.

### Scan cycle (`scan()`)

Each cycle does the following:

```
For each .tbody in the DOM:
  → Discover column indices from header row title= attributes
  → Clear the activeTickets set
  → For each .tr[data-id] (order rows only):
      → Read Profit cell — skip row if ≠ "Placed"
      → Mark ticket as active
      → Parse Open Price and Close Price (strip space thousands separators)
      → diff = |Close Price − Open Price|
      → { yellowThresh, redThresh } = getThresholds(openPrice)
      → if diff < redThresh  → paint RED  + fireAlert()
      → if diff < yellowThresh → paint YELLOW
      → else → clear any highlight
  → Prune alertLog: remove entries whose ticket is not in activeTickets
  → Update stats counters and widget
```

---

## Visual Indicators

Colours are applied by setting `background-color` with `!important` directly on **every `.td` cell** inside the row. See [DOM Rendering Note](#dom-rendering-note) for why the `.tr` element itself cannot be targeted.

| Colour                                | Condition             | Meaning                                              |
| ------------------------------------- | --------------------- | ---------------------------------------------------- |
| No colour                             | `diff ≥ yellowThresh` | Order is far from the market — no action needed      |
| **Dim yellow** `rgba(255,200,0,0.35)` | `diff < yellowThresh` | Order is within watch range — market is approaching  |
| **Dim red** `rgba(220,60,60,0.40)`    | `diff < redThresh`    | Order is near-trigger — immediate attention required |

When a row transitions from red back to yellow or clear (market moves away), the highlight updates automatically on the next scan and no new alert fires.

---

## Alert System

When a row enters the **red zone** (`diff < redThresh`), three things fire simultaneously — subject to the per-row cooldown.

### Audio

Three short rising sine-wave beeps generated entirely via the **Web Audio API** — no external sound file required.

| Beep | Frequency | Start offset | Duration |
| ---- | --------- | ------------ | -------- |
| 1st  | 660 Hz    | 0.00 s       | 160 ms   |
| 2nd  | 880 Hz    | 0.18 s       | 160 ms   |
| 3rd  | 1100 Hz   | 0.36 s       | 160 ms   |

Each beep fades in over 20 ms and decays exponentially. The `AudioContext` is created lazily on first use and reused for all subsequent alerts.

> **Note:** browsers require at least one prior user interaction before allowing audio playback. In practice this is always satisfied since you must interact to log in.

### System Notification

A native OS desktop notification is displayed using the **browser Notification API**:

- **Title:** `⚠️ Near market: {Symbol Name}`
- **Body:** symbol name, current price distance from trigger, and the red threshold value
- **Icon:** the site's own favicon (`/terminal/B8oDqCFA.ico`)
- **Tag:** `pdiff-{rowId}` — replaces any previous notification for the same order rather than stacking
- **`requireInteraction: true`** — stays on screen until manually dismissed

**Clicking the system notification** brings the browser window into focus, clicks the matching `.tr` row to open that symbol's chart, and scrolls the row into view.

If permission is `default` when an alert fires, the script requests permission again and retries the notification once granted. If permission is `denied`, system notifications are silently skipped — audio and the in-page popup still fire.

### In-page Popup Notification

Simultaneously with the system notification, an animated card slides into the page from the top-right (below the status pill). It shows:

- The warning icon and symbol name in the header
- The current price distance and red threshold in the body
- An **×** dismiss button

Clicking anywhere on the card focuses the order row and dismisses the card. The card auto-dismisses after 8 seconds if not interacted with. Multiple simultaneous red-zone rows stack as separate cards.

### Alert Log

Every alert is recorded in the in-memory `alertLog` array (`{ ticket, symbol, time }`). The log is:

- **Deduplicated by ticket** — if the same order fires again, its entry's timestamp updates rather than duplicating
- **Newest-first** — `alertLog.unshift()` keeps the most recent alert at the top
- **Automatically pruned** — at the end of every scan, any log entry whose ticket number is no longer present in the active orders table is removed
- **Rendered in the widget panel** — see [Alert Log Section](#alert-log-section)

### Cooldown

The `lastAlerted` map stores a timestamp per `data-id`. An alert will not re-fire for the same row until **30 seconds** (configurable) have elapsed, preventing spam during rapid scans.

---

## Status Indicator Widget

A fixed overlay in the **top-right corner** of the page, always visible. It consists of a pill and a slide-down panel.

### The Pill

A compact rounded badge showing:

- **Pulsing dot** — green (all clear), amber (watch zone active), red/fast-pulse (alert zone active)
- **"Price Diff" label**
- **Three count badges** — blue (total Placed orders), yellow (watch zone), red (near-trigger)

Clicking the pill opens or closes the panel.

### The Panel

A 340 px wide slide-down panel with smooth fade + translate animation. It is divided into four sections inside a scrollable container.

### Stats Section

Four stat cards displayed in a 2×2 grid:

| Card   | Colour | Value                                                 |
| ------ | ------ | ----------------------------------------------------- |
| Uptime | grey   | Time since script loaded — live, ticking every second |
| Orders | blue   | Total `Placed` orders currently in the table          |
| Watch  | yellow | Orders in the yellow zone                             |
| Near   | red    | Orders in the red zone                                |

### Alert Log Section

A scrollable list (max 150 px) of all orders that have fired a red-zone alert this session. Each entry shows:

- Red dot indicator
- Symbol name (bold)
- Ticket number (e.g. `#20589743197`)
- Relative time (e.g. `2m ago`, `1h ago`) — refreshes every 30 seconds

**Clicking an alert entry** clicks and scrolls to that order's row in the table, then closes the panel.

Entries are automatically removed from the list when their ticket number disappears from the orders table (i.e. the order has been filled or cancelled).

### Settings Section

Three live-editable settings. Changes take effect immediately on the next scan — no reload required.

| Setting             | Input type   | Default      | Range                                    |
| ------------------- | ------------ | ------------ | ---------------------------------------- |
| Scan interval (ms)  | Number input | 2000         | 500 – 30000                              |
| Alert cooldown (ms) | Number input | 30000        | 1000 – 300000                            |
| Tier sensitivity    | Dropdown     | Default (1×) | Tight (0.5×) / Default (1×) / Loose (2×) |

**Sensitivity** applies a multiplier to all tier fractions:

- **Tight (0.5×)** — thresholds are halved; highlights and alerts only trigger very close to the order price
- **Default (1×)** — standard calibrated fractions
- **Loose (2×)** — thresholds are doubled; highlights and alerts trigger earlier / further out

> ⚠ **All settings reset on page reload.** They are held in the in-memory `cfg` object only. There is no persistence mechanism.

### About Section

A button at the bottom of the panel. Clicking it opens a centred modal overlay showing all `==UserScript==` header fields as stored in the `SCRIPT_META` object at the top of the script:

- Name, Version, Description, Author, Namespace, Match, Run-at

The modal closes by clicking the **Close** button or clicking the dark overlay backdrop.

---

## Adaptive Threshold Logic

A single flat percentage fails across Deriv's instruments because price scales differ by five orders of magnitude — GBPAUD trades at ~1.87 while Jump 25 Index trades at ~134,000. A 2% threshold on GBPAUD would be hundreds of pips (far too wide), while the same 2% on Boom 50 at 104,000 is still 2,080 points (too coarse for a fast-moving index).

The script uses a **tiered system**: the open price magnitude selects a tier, and each tier has its own yellow and red fractions calibrated to that instrument class. A sensitivity multiplier from the settings panel scales all fractions uniformly.

### Tier Table

| Price range      | Instrument class                          | Yellow fraction | Red fraction |
| ---------------- | ----------------------------------------- | --------------- | ------------ |
| < 10             | Forex pairs (GBPAUD, EURUSD…)             | 0.30%           | 0.050%       |
| 10 – 500         | Small indices (Vol 50, Vol 100)           | 1.50%           | 0.300%       |
| 500 – 5,000      | Mid indices (Vol 100(1s), Vol 75(1s))     | 1.00%           | 0.200%       |
| 5,000 – 30,000   | Large volatility (Vol 90(1s), Vol 10(1s)) | 0.80%           | 0.150%       |
| 30,000 – 60,000  | Jump/Crash mid (Vol 75, Jump 50)          | 0.60%           | 0.100%       |
| 60,000 – 110,000 | Large Jump/Boom (Jump 10, Boom 50)        | 0.40%           | 0.080%       |
| > 110,000        | Very large indices (Jump 25 and above)    | 0.30%           | 0.060%       |

### Formula

```
tier         = first tier where |openPrice| < tier.maxPrice
mult         = 0.5 (tight) | 1.0 (default) | 2.0 (loose)
yellowThresh = max(|openPrice| × tier.yellowFrac × mult, 1e-9)
redThresh    = max(|openPrice| × tier.redFrac    × mult, 1e-9)
```

### Worked examples (default sensitivity)

| Symbol              | Open Price | Yellow threshold | Red threshold |
| ------------------- | ---------- | ---------------- | ------------- |
| GBPAUD              | 1.87000    | 0.005610         | 0.000935      |
| Volatility 50 Index | 98.51      | 1.4777           | 0.2955        |
| Vol 100 (1s) Index  | 1,298.68   | 12.987           | 2.597         |
| Volatility 75 (1s)  | 4,500.00   | 45.000           | 9.000         |
| Vol 90 (1s) Index   | 10,251.59  | 82.013           | 15.377        |
| Crash 900 Index     | 19,801.06  | 158.408          | 29.701        |
| Volatility 75 Index | 36,415.31  | 218.492          | 36.415        |
| Jump 50 Index       | 44,900.00  | 269.400          | 44.900        |
| Jump 10 Index       | 97,176.73  | 388.707          | 77.741        |
| Boom 50 Index       | 104,404.98 | 417.620          | 83.524        |
| Jump 25 Index       | 134,371.98 | 403.116          | 80.623        |

The `1e-9` floor prevents comparison issues on theoretical zero-price instruments.

---

## Column Detection

Rather than relying on Svelte-generated class names (e.g. `svelte-6vhlj1`) which change between builds, the script discovers column positions dynamically by reading the **`title` attribute on header cells** (e.g. `<div class="th" title="Open Price">`).

The first `.tr` inside `.tbody` that has **no `data-id` attribute** is the header row. All `.tr[data-id]` elements are order data rows.

Columns discovered: Symbol (0), Ticket (1), Time (2), Open Price (5), Close Price (6), Profit (8).

Fallback hardcoded indices are used if the header row is not yet in the DOM:

| Column      | Fallback index |
| ----------- | -------------- |
| Symbol      | 0              |
| Ticket      | 1              |
| Time        | 2              |
| Open Price  | 5              |
| Close Price | 6              |
| Profit      | 8              |

---

## DOM Rendering Note

The Deriv MT5 terminal uses **CSS Grid** on the `.tbody` container:

```
.tbody  →  display: grid  (grid-template-columns defines all column widths)
.tr     →  grid row container — NOT a painting box
.td     →  actual rendered cells, positioned directly in the grid
```

Setting `background-color` on `.tr` — regardless of CSS specificity, `!important`, injection position, or cascade order — has **no visual effect** because `.tr` is a non-painting pass-through element in this layout.

The script sets `background-color` inline on **each `.td` child** via:

```javascript
td.style.setProperty("background-color", color, "important");
```

And removes it via:

```javascript
td.style.removeProperty("background-color");
```

This is the only reliable approach for this grid layout.

---

## Configuration Reference

### In-code constants (require script edit to change permanently)

| Constant          | Default                | Description                                          |
| ----------------- | ---------------------- | ---------------------------------------------------- |
| `YELLOW_BG`       | `rgba(255,200,0,0.35)` | Yellow highlight colour                              |
| `RED_BG`          | `rgba(220,60,60,0.40)` | Red highlight colour                                 |
| `THRESHOLD_TIERS` | (array)                | Tiered fraction table — see Adaptive Threshold Logic |

### Runtime settings (configurable via the widget panel, reset on reload)

| Setting       | Default     | Description                                                         |
| ------------- | ----------- | ------------------------------------------------------------------- |
| `intervalMs`  | `2000`      | Scan frequency in milliseconds                                      |
| `cooldownMs`  | `30000`     | Minimum ms between alerts for the same order row                    |
| `sensitivity` | `'default'` | Tier multiplier: `'tight'` (0.5×), `'default'` (1×), `'loose'` (2×) |

---

## Debugging

Each scanned order row gets debug attributes stamped on the `.tr` element, visible in browser DevTools → Elements tab:

| Attribute              | Value                                                       |
| ---------------------- | ----------------------------------------------------------- | ------------ | -------------- |
| `data-price-diff`      | Absolute `                                                  | Close − Open | ` for this row |
| `data-price-threshold` | Yellow threshold (2% tier fraction × open price)            |
| `data-pdiff-highlight` | Current paint colour string, or absent if row is uncoloured |

To inspect: open DevTools → Elements → find a `.tr[data-id="..."]` element → check its attributes panel.

Console prefix: all script warnings use the `[pdiff]` prefix for easy filtering.

---

## Limitations

- **Settings are not persistent.** All runtime configuration (`intervalMs`, `cooldownMs`, `sensitivity`) resets to defaults on every page reload. There is no localStorage or external storage mechanism.
- **Notification click → chart navigation** works by clicking the matching `.tr` row element, which the terminal uses internally to switch the chart. If Deriv updates their internal routing this click may stop switching the chart, though window focus and row scroll will still work.
- **Audio autoplay policy.** Browsers block audio until the user has interacted with the page. In practice this is always satisfied before alerts can fire, since the user must interact to log in and navigate to the orders table.
- **Tab suspension.** If the browser suspends the tab (common in low-memory situations), `setInterval` scans pause. The script resumes automatically when the tab is reactivated.
- **Header title attribute dependency.** If Deriv renames column headers (e.g. changes `title="Open Price"` to something else), column detection falls back to hardcoded indices which may be wrong. Check the fallback values against the live DOM if highlighting stops working after a site update.
- **In-memory alert log only.** The alert log is cleared on every page reload. There is no export or persistence of historical alerts.
