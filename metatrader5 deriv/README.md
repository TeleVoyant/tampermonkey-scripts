# Deriv MT5 — Placed Order Price Diff Tracker

A Tampermonkey userscript that monitors pending limit orders on the Deriv MT5 web terminal and visually alerts you when the market price is approaching your order's open price.

---

# DEMO

![Script in Action](row whose position are about to enter market.png)

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [How It Works](#how-it-works)
- [Visual Indicators](#visual-indicators)
- [Alert System](#alert-system)
- [Adaptive Threshold Logic](#adaptive-threshold-logic)
- [Column Detection](#column-detection)
- [DOM Rendering Note](#dom-rendering-note)
- [Configuration Reference](#configuration-reference)
- [Debugging](#debugging)
- [Limitations](#limitations)

---

## Overview

The script runs every **5 seconds** inside the Deriv MT5 web terminal (`mt5-real01-web-svg.deriv.com`) and scans the pending orders table for rows whose `Profit` column reads `Placed`. For each such row it computes the absolute difference between the **Open Price** (your limit order price) and the **Close Price** (the current live market price), then compares that difference against two adaptive thresholds derived from the order's own open price. Rows are highlighted yellow or red depending on how close the market is to triggering the order, and an audio + desktop notification alert fires when a row enters the red zone.

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

### Startup

On page load (`@run-at document-end`) the script:

1. Checks the hostname and exits immediately if not on the target site.
2. Requests browser notification permission if not already granted.
3. Waits **10 seconds** for the Svelte app to finish rendering the table, then runs the first scan.
4. Schedules a repeat scan every **5 seconds** via `setInterval`.

### Scan cycle (`scan()`)

Each cycle does the following:

```
For each .tbody found in the DOM:
  → Discover column indices from header row title attributes
  → For each .tr[data-id] (order rows only):
      → Read the Profit cell
      → Skip if Profit ≠ "Placed"
      → Parse Open Price and Close Price
      → Compute diff = |Close Price − Open Price|
      → Compute yellowThresh = Open Price × 0.02
      → Compute redThresh    = Open Price × 0.005
      → if diff < redThresh  → paint row RED  + fire alert
      → if diff < yellowThresh → paint row YELLOW
      → else → clear any highlight
```

---

## Visual Indicators

| Colour                                | Condition                   | Meaning                                              |
| ------------------------------------- | --------------------------- | ---------------------------------------------------- |
| **No colour**                         | `diff ≥ 2%` of Open Price   | Order is far from the market — no action needed      |
| **Dim yellow** `rgba(255,200,0,0.35)` | `diff < 2%` of Open Price   | Order is within watch range — market is approaching  |
| **Dim red** `rgba(220,60,60,0.40)`    | `diff < 0.5%` of Open Price | Order is near-trigger — immediate attention required |

Colours are applied by setting `background-color` with `!important` directly on **every `.td` cell** inside the row (not the `.tr` element itself). This is necessary because the table uses CSS Grid layout (`display: grid` on `.tbody`), which makes `.tr` a non-painting box whose own `background` property has no visual effect.

---

## Alert System

When a row enters the **red zone** (`diff < 0.5%`), two things happen simultaneously:

### 1. Audio Alert (`playAlert()`)

Three short rising sine-wave beeps are generated entirely in-browser using the **Web Audio API** — no external sound file is required.

| Beep | Frequency | Start offset |
| ---- | --------- | ------------ |
| 1st  | 660 Hz    | 0.00 s       |
| 2nd  | 880 Hz    | 0.18 s       |
| 3rd  | 1100 Hz   | 0.36 s       |

Each beep fades in over 20 ms and decays over 160 ms. The `AudioContext` is created lazily on first use and reused for subsequent alerts.

### 2. Desktop Notification (`fireAlert()`)

A browser notification is shown with:

- **Title:** `⚠️ Order near market: {Symbol Name}`
- **Body:** the symbol name, current price distance from trigger, and the red threshold value
- **Icon:** the site's own favicon
- **Tag:** `pdiff-{rowId}` — ensures that if the same order fires again, the previous notification is replaced rather than stacking
- **`requireInteraction: true`** — the notification stays on screen until you manually dismiss it

**Clicking the notification** brings the browser window into focus and clicks the matching order row in the table, which opens that symbol's chart in the terminal.

### Cooldown

Each order row (`data-id`) has its alert timestamp stored in the `lastAlerted` map. An alert will not re-fire for the same row within **180 seconds**, preventing spam during the 2-second scan interval.

### Notification Permission

- On first load the script calls `Notification.requestPermission()` — the browser will show a permission prompt.
- If permission is `denied`, notifications are silently skipped (audio still plays).
- If permission is `default` at the time an alert fires, the script requests it again and retries the notification once granted.

---

## Adaptive Threshold Logic

A fixed threshold (e.g. "flag if diff < 50 points") would be meaningless across the wide range of instruments on Deriv — prices range from ~1.87 (GBPAUD) to ~134,000 (Jump 25 Index).

Instead, both thresholds are calculated as a **percentage of the order's own Open Price**:

```
yellowThresh = max(|openPrice| × 0.02,  1e-9)   → 2%  of open price
redThresh    = max(|openPrice| × 0.005, 1e-9)   → 0.5% of open price
```

**Examples:**

| Symbol              | Open Price | Yellow threshold | Red threshold |
| ------------------- | ---------- | ---------------- | ------------- |
| GBPAUD              | 1.87000    | 0.03740          | 0.00935       |
| Volatility 50 Index | 98.51      | 1.9703           | 0.4926        |
| Volatility 10 (1s)  | 10,251     | 205.03           | 51.26         |
| Jump 10 Index       | 97,176     | 1,943.5          | 485.9         |
| Boom 50 Index       | 104,404    | 2,088.1          | 522.0         |

The `1e-9` floor prevents division/comparison issues on theoretical zero-price instruments.

---

## Column Detection

Rather than relying on fragile Svelte-generated class names (e.g. `svelte-6vhlj1`) which change between builds, the script discovers column positions dynamically by reading the **`title` attribute on header cells** (`<div class="th" title="Open Price">`).

The first `.tr` element inside `.tbody` that has **no `data-id` attribute** is treated as the header row. All subsequent `.tr[data-id]` elements are order data rows.

Fallback column indices (used if the header row is not yet rendered):

| Column      | Fallback index |
| ----------- | -------------- |
| Symbol      | 0              |
| Open Price  | 5              |
| Close Price | 8              |
| Profit      | 10             |

---

## DOM Rendering Note

The Deriv MT5 terminal is built with **Svelte** and renders its orders table using **CSS Grid** on the `.tbody` container. In this layout:

- `.tbody` → `display: grid` with explicit `grid-template-columns`
- `.tr` → a grid row container, but **not a painting box** — `background-color` set on `.tr` has no visual effect regardless of CSS specificity or `!important`
- `.td` → the actual rendered cells

This is why earlier versions of the script (which set `background` on `.tr` via injected stylesheets) produced no visible colour change even though the attributes were correctly applied. The solution is to set `background-color` inline on **each `.td`** directly using `element.style.setProperty('background-color', color, 'important')`.

---

## Configuration Reference

All tunable values are constants at the top of the script:

| Constant            | Default                | Description                                        |
| ------------------- | ---------------------- | -------------------------------------------------- |
| `INTERVAL_MS`       | `5000`                 | Scan frequency in milliseconds                     |
| `YELLOW_FRACTION`   | `0.01`                 | Yellow threshold as fraction of open price (1%)    |
| `RED_FRACTION`      | `0.001`                | Red threshold as fraction of open price (0.1%)     |
| `YELLOW_BG`         | `rgba(255,200,0,0.35)` | Yellow highlight colour                            |
| `RED_BG`            | `rgba(220,60,60,0.40)` | Red highlight colour                               |
| `ALERT_COOLDOWN_MS` | `180000`               | Minimum ms between alerts for the same row (180 s) |

To make the yellow zone wider, increase `YELLOW_FRACTION`. To make the red alert trigger sooner, increase `RED_FRACTION` (e.g. `0.01` for 1%).

---

## Debugging

Each scanned order row gets two debug attributes stamped on the `.tr` element, visible in browser DevTools:

| Attribute              | Value                                                |
| ---------------------- | ---------------------------------------------------- |
| `data-price-diff`      | Absolute difference between Close and Open Price     |
| `data-price-threshold` | The yellow threshold value (2% of open)              |
| `data-pdiff-highlight` | Current paint colour, or absent if row is uncoloured |

To inspect: open DevTools → Elements tab → find a `.tr[data-id]` element → check its attributes.

---

## Limitations

- **Notification click → chart navigation** scrolls the matching row into view and clicks it to open the symbol chart. If the terminal's internal routing changes this behaviour, the click may not switch the chart but the window focus and row scroll will still work.
- The script only runs while the browser tab is open and active enough to execute JavaScript. If the tab is suspended by the browser, scans will pause.
- Audio requires at least one prior user interaction with the page (browser autoplay policy). In practice this is always satisfied since you must have clicked to log in.
- If Deriv updates the terminal build and changes the `title` attributes on header cells, column detection will fall back to hardcoded indices (which may be wrong). Check the fallback values against the live DOM if highlighting stops working after a site update.
