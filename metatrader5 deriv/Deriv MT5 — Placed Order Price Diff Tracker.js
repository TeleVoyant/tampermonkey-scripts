// ==UserScript==
// @name         Deriv MT5 — Price Diff Tracker
// @namespace    http://mt5-real01-web-svg.deriv.com/
// @icon         https://play-lh.googleusercontent.com/65e0HntWSHuxvon8vp-Vai1gOMXQxBr0YhqDcZkAg9ligsqkJNuPnJgmbMcWii3TsA=w240-h480
// @version      9.0
// @description  Modular architecture. Theme-aware UI. Trade-tab detection with pause banner. Robust DOM queries.
// @author       github.com/TeleVoyant
// @match        http://mt5-real01-web-svg.deriv.com/*
// @match        https://mt5-real01-web-svg.deriv.com/*
// @grant        GM_notification
// @run-at       document-end
// ==/UserScript==

/**
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Deriv MT5 — Placed Order Price Diff Tracker  v9.0                  │
 * │                                                                     │
 * │  Architecture (modules):                                            │
 * │    Config        — mutable runtime settings + persistence           │
 * │    Thresholds    — tiered adaptive price-diff thresholds            │
 * │    DOMQuery      — resilient selectors that don't rely on hashes    │
 * │    ThemeEngine   — tracks dark/light theme from the host app        │
 * │    Audio         — Web Audio beep alerts                            │
 * │    Notifier      — browser Notification + focus helpers             │
 * │    Scanner       — main scan loop (trade-tab aware)                 │
 * │    AlertLog      — deduped alert history                            │
 * │    UI            — pill, panel, pause banner                        │
 * │    App           — boot / lifecycle                                 │
 * └─────────────────────────────────────────────────────────────────────┘
 */

(function () {
  "use strict";

  // ── Guard: only run on correct host ─────────────────────────────────────
  if (window.location.hostname !== "mt5-real01-web-svg.deriv.com") return;

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: Config
  // ═══════════════════════════════════════════════════════════════════════

  const Config = (() => {
    const STORAGE_KEY = "pdiff_config_v9";

    const DEFAULTS = Object.freeze({
      intervalMs: 5000,
      cooldownMs: 300000,
      sensitivity: "default", // "tight" | "default" | "loose"
    });

    let _cfg = { ...DEFAULTS };

    /** Load persisted config from localStorage (survives page reloads). */
    function load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          _cfg = { ...DEFAULTS, ...parsed };
        }
      } catch {
        /* ignore corrupt data */
      }
    }

    /** Persist current config to localStorage. */
    function save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_cfg));
      } catch {
        /* quota / private browsing */
      }
    }

    /** Get a config value by key. */
    function get(key) {
      return _cfg[key];
    }

    /**
     * Set a config value. Validates, saves, and returns true if accepted.
     * @param {string} key
     * @param {*} value
     * @returns {boolean}
     */
    function set(key, value) {
      switch (key) {
        case "intervalMs":
          if (typeof value !== "number" || value < 500) return false;
          break;
        case "cooldownMs":
          if (typeof value !== "number" || value < 1000) return false;
          break;
        case "sensitivity":
          if (!["tight", "default", "loose"].includes(value)) return false;
          break;
        default:
          return false;
      }
      _cfg[key] = value;
      save();
      return true;
    }

    /** Reset all config to defaults and persist. */
    function reset() {
      _cfg = { ...DEFAULTS };
      save();
    }

    return { load, save, get, set, reset, DEFAULTS };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: Thresholds
  // ═══════════════════════════════════════════════════════════════════════

  const Thresholds = (() => {
    /**
     * Tiers are matched on |openPrice| magnitude. Each tier specifies:
     *   yellowFrac — watch zone fraction
     *   redFrac    — alert zone fraction
     *
     * Tier boundaries are tuned against real observed Deriv prices.
     */
    const TIERS = Object.freeze([
      // price < 10  → Forex / micro pairs (GBPAUD 1.87, EURUSD 1.08)
      { maxPrice: 10, yellowFrac: 0.003, redFrac: 0.0005 },
      // 10 – 500  → Small-scale indices (Vol 50 ~80–100)
      { maxPrice: 500, yellowFrac: 0.015, redFrac: 0.003 },
      // 500 – 5 000  → Mid-range indices (Vol 100(1s) ~1300)
      { maxPrice: 5000, yellowFrac: 0.01, redFrac: 0.002 },
      // 5 000 – 30 000  → Large volatility indices
      { maxPrice: 30000, yellowFrac: 0.008, redFrac: 0.0015 },
      // 30 000 – 60 000  → Jump/Crash mid
      { maxPrice: 60000, yellowFrac: 0.006, redFrac: 0.001 },
      // 60 000 – 110 000  → Large Jump/Boom
      { maxPrice: 110000, yellowFrac: 0.004, redFrac: 0.0008 },
      // > 110 000  → Very large indices
      { maxPrice: Infinity, yellowFrac: 0.003, redFrac: 0.0006 },
    ]);

    const SENSITIVITY_MULT = Object.freeze({
      tight: 0.5,
      default: 1.0,
      loose: 2.0,
    });

    /**
     * Compute { yellowThresh, redThresh } for a given open price.
     * @param {number} openPrice
     * @returns {{ yellowThresh: number, redThresh: number }}
     */
    function compute(openPrice) {
      const abs = Math.abs(openPrice);
      const tier =
        TIERS.find((t) => abs < t.maxPrice) || TIERS[TIERS.length - 1];
      const mult = SENSITIVITY_MULT[Config.get("sensitivity")] ?? 1.0;
      return {
        yellowThresh: Math.max(abs * tier.yellowFrac * mult, 1e-9),
        redThresh: Math.max(abs * tier.redFrac * mult, 1e-9),
      };
    }

    return { compute, TIERS };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: DOMQuery  — resilient selectors (no svelte hash IDs)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Problem: Svelte appends random hashes to class names on every build
   * (e.g. `.svelte-z9m392`). Querying those is fragile.
   *
   * Strategy:
   *  1. Prefer semantic attributes: [title], [data-id], tag names.
   *  2. Use structural selectors (nth-child, :has()) when needed.
   *  3. Fall back to scanning text content as a last resort.
   *  4. Cache discovered references; re-discover if stale.
   */
  const DOMQuery = (() => {
    let _cache = {};

    /** Invalidate cached references (call on major DOM changes). */
    function invalidate() {
      _cache = {};
    }

    /**
     * Find the bottom panel container that holds Trade / History / Journal.
     * Structural path: .bot-panel  (stable class from the MT5 app, not hashed).
     */
    function getBotPanel() {
      if (_cache.botPanel && document.contains(_cache.botPanel))
        return _cache.botPanel;
      // .bot-panel is set by the MT5 app itself, not Svelte-hashed
      _cache.botPanel = document.querySelector(".bot-panel");
      return _cache.botPanel;
    }

    /**
     * Detect which bottom-panel tab is currently active.
     * The tab buttons have title="Trade", title="History", title="Journal".
     * The active one has class "checked".
     *
     * We look for icon-buttons whose title matches, inside the left-panel
     * bottom section (below the drawing tools).
     *
     * @returns {"trade"|"history"|"journal"|"unknown"}
     */
    function getActiveTab() {
      const tabs = document.querySelectorAll(
        '[title="Trade"], [title="History"], [title="Journal"]',
      );
      for (const tab of tabs) {
        // "checked" class is applied by the app (not hashed)
        if (tab.classList.contains("checked")) {
          return tab.getAttribute("title").toLowerCase();
        }
      }
      return "unknown";
    }

    /**
     * Get the trade table's <tbody>-equivalent container.
     *
     * Structure from the HTML:
     *   .bot-panel  >  .layout  >  .wrapper  >  .table  >  .tbody
     *
     * `.tbody` is used by the app as a semantic class (not hashed).
     * We verify it's in the bot-panel to avoid grabbing the market-watch table.
     */
    function getTradeTbody() {
      const botPanel = getBotPanel();
      if (!botPanel) return null;
      // There should be exactly one .tbody inside the bot-panel
      return botPanel.querySelector(".tbody");
    }

    /**
     * Discover column indices from the header row.
     * Header cells use title="Symbol", title="Open Price", etc.
     * These title attributes are set by the MT5 app and are stable.
     *
     * @param {Element} tbody
     * @returns {Object} Map of column names to indices
     */
    function discoverColumns(tbody) {
      // The header row is a .tr without [data-id]
      const headerRow = tbody.querySelector(".tr:not([data-id])");
      if (!headerRow) return null;

      const columns = {};
      const WANTED = [
        "Symbol",
        "Ticket",
        "Time",
        "Open Price",
        "Close Price",
        "Profit",
      ];
      const cells = [...headerRow.children];

      cells.forEach((cell, idx) => {
        // Prefer the title attribute for column identification
        const title = (cell.getAttribute("title") || "").trim();
        if (WANTED.includes(title)) {
          // Normalize key: "Open Price" → "openPrice"
          const key = title
            .split(" ")
            .map((w, i) =>
              i === 0
                ? w.toLowerCase()
                : w[0].toUpperCase() + w.slice(1).toLowerCase(),
            )
            .join("");
          columns[key] = idx;
        }
      });

      return columns;
    }

    /**
     * Find the theme toggle button.
     * The button has title="Light Theme" (when in dark mode)
     * or title="Dark Theme" (when in light mode).
     *
     * Instead of relying on Svelte-hashed classes, we query by title attr.
     */
    function getThemeButton() {
      return (
        document.querySelector('[title="Light Theme"]') ||
        document.querySelector('[title="Dark Theme"]')
      );
    }

    /**
     * Detect current theme from the <html> element's CSS custom properties.
     * The MT5 app sets `--color-dark: 1` for dark and `--color-dark: 0` for light.
     * This is the most reliable signal — it's a CSS variable, not a class name.
     *
     * @returns {"dark"|"light"}
     */
    function getCurrentTheme() {
      const htmlEl = document.documentElement;
      const colorDark = getComputedStyle(htmlEl)
        .getPropertyValue("--color-dark")
        .trim();
      return colorDark === "1" ? "dark" : "light";
    }

    /**
     * Get the chart canvas element.
     * Located inside .chart > .chart-overlay > canvas
     */
    function getChartCanvas() {
      if (_cache.chartCanvas && document.contains(_cache.chartCanvas))
        return _cache.chartCanvas;
      _cache.chartCanvas = document.querySelector(".chart canvas");
      return _cache.chartCanvas;
    }

    /**
     * Get the chart overlay container (parent of the canvas).
     */
    function getChartOverlay() {
      if (_cache.chartOverlay && document.contains(_cache.chartOverlay))
        return _cache.chartOverlay;
      _cache.chartOverlay = document.querySelector(".chart-overlay");
      return _cache.chartOverlay;
    }

    return {
      invalidate,
      getBotPanel,
      getActiveTab,
      getTradeTbody,
      discoverColumns,
      getThemeButton,
      getCurrentTheme,
      getChartCanvas,
      getChartOverlay,
    };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: ThemeEngine
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Observes the host app's theme (dark/light) and exposes CSS custom
   * properties that the script's UI binds to.
   *
   * Detection method: reads `--color-dark` from <html> style attribute.
   * The MT5 app sets inline styles on <html> when the theme changes.
   * We use a MutationObserver on <html> style to detect switches.
   */
  const ThemeEngine = (() => {
    let _current = "dark";
    const _listeners = [];

    /** Subscribe to theme changes. Callback receives "dark"|"light". */
    function onChange(fn) {
      _listeners.push(fn);
    }

    function _notify() {
      _listeners.forEach((fn) => {
        try {
          fn(_current);
        } catch {
          /* swallow */
        }
      });
    }

    /** @returns {"dark"|"light"} */
    function current() {
      return _current;
    }

    /**
     * CSS custom properties for the script's own UI, derived from the
     * host app's CSS variables. This keeps the script in sync with the
     * platform's palette without hardcoding colors.
     */
    function getCSSVariables() {
      const s = getComputedStyle(document.documentElement);
      const v = (name) => s.getPropertyValue(name).trim();
      return {
        "--pdiff-bg": v("--color-background") || "#0f1720",
        "--pdiff-card": v("--color-card") || "#262f3f",
        "--pdiff-border": v("--color-border") || "#2b3543",
        "--pdiff-text": v("--color-text-default") || "#ffffff",
        "--pdiff-text-secondary": v("--color-text-secondary") || "#8fa2b8",
        "--pdiff-text-disabled": v("--color-icon-disabled") || "#647181",
        "--pdiff-blue": v("--color-text-blue") || "#4597ff",
        "--pdiff-red": v("--color-text-red") || "#ff5858",
        "--pdiff-green": v("--color-fill-green") || "#36b34b",
        "--pdiff-orange": v("--color-text-orange") || "#ff8643",
        "--pdiff-fill-blue": v("--color-fill-blue") || "#3183ff",
      };
    }

    /** Apply CSS variables to the script's root widget element. */
    function applyTo(element) {
      const vars = getCSSVariables();
      Object.entries(vars).forEach(([k, v]) => {
        element.style.setProperty(k, v);
      });
    }

    /** Start observing theme changes. */
    function init() {
      _current = DOMQuery.getCurrentTheme();

      // Watch the <html> element's style attribute for changes
      const observer = new MutationObserver(() => {
        const next = DOMQuery.getCurrentTheme();
        if (next !== _current) {
          _current = next;
          _notify();
        }
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style"],
      });
    }

    return { init, current, onChange, getCSSVariables, applyTo };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: Audio
  // ═══════════════════════════════════════════════════════════════════════

  const Audio = (() => {
    let _ctx = null;

    function _getCtx() {
      if (!_ctx) {
        _ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      return _ctx;
    }

    /** Play three rising beeps (660 → 880 → 1100 Hz). */
    function playAlert() {
      try {
        const ctx = _getCtx();
        const BEEPS = [
          { offset: 0, freq: 660 },
          { offset: 0.18, freq: 880 },
          { offset: 0.36, freq: 1100 },
        ];
        BEEPS.forEach(({ offset, freq }) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.type = "sine";
          osc.frequency.value = freq;

          const t = ctx.currentTime + offset;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(0.4, t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);

          osc.start(t);
          osc.stop(t + 0.16);
        });
      } catch (e) {
        console.warn("[pdiff] audio error:", e);
      }
    }

    return { playAlert };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: Notifier
  // ═══════════════════════════════════════════════════════════════════════

  const Notifier = (() => {
    /** Request notification permission if not yet decided. */
    function requestPermission() {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
      ) {
        Notification.requestPermission();
      }
    }

    /**
     * Focus the browser window and scroll to the row matching the symbol.
     * Uses [title] and [data-id] attributes — no Svelte hashes.
     */
    function focusSymbol(symbol) {
      window.focus();

      // Scroll chart title into view
      const titles = document.querySelectorAll(".title");
      for (const el of titles) {
        if (el.textContent.includes(symbol)) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          break;
        }
      }

      // Click and scroll the matching trade row
      const rows = document.querySelectorAll(".tr[data-id]");
      for (const row of rows) {
        const firstCell = row.children[0];
        if (
          firstCell &&
          (firstCell.getAttribute("title") || "").includes(symbol)
        ) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          row.click();
          break;
        }
      }
    }

    /**
     * Fire a browser notification.
     * @param {string} symbol
     * @param {number} diff
     * @param {number} threshold
     * @param {string} rowId
     */
    function send(symbol, diff, threshold, rowId) {
      const body = `${symbol} — ${diff.toFixed(5)} from trigger (limit ${threshold.toFixed(5)})`;

      if (typeof Notification === "undefined") return;

      if (Notification.permission === "granted") {
        try {
          const n = new Notification(`Near Market: ${symbol}`, {
            body,
            icon: "https://www.atfxcapital.com/wp-content/uploads/2024/08/ATFX_MT52x.png",
            tag: `pdiff-${rowId}`,
            requireInteraction: true,
          });
          n.onclick = () => {
            focusSymbol(symbol);
            n.close();
          };
        } catch (e) {
          console.warn("[pdiff] notification error:", e);
        }
      } else if (Notification.permission === "default") {
        Notification.requestPermission();
      }
    }

    return { requestPermission, focusSymbol, send };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: AlertLog
  // ═══════════════════════════════════════════════════════════════════════

  const AlertLog = (() => {
    /** @type {{ ticket: string, symbol: string, time: number }[]} */
    const _entries = [];
    const _listeners = [];

    function onChange(fn) {
      _listeners.push(fn);
    }

    function _notify() {
      _listeners.forEach((fn) => {
        try {
          fn();
        } catch {
          /* swallow */
        }
      });
    }

    /**
     * Record or update an alert entry. Deduplicates by ticket.
     * @param {string} ticket
     * @param {string} symbol
     */
    function record(ticket, symbol) {
      const existing = _entries.find((e) => e.ticket === ticket);
      if (existing) {
        existing.time = Date.now();
      } else {
        _entries.unshift({ ticket, symbol, time: Date.now() });
      }
      _notify();
    }

    /**
     * Remove entries whose tickets are no longer present.
     * @param {Set<string>} activeTickets
     */
    function prune(activeTickets) {
      let changed = false;
      for (let i = _entries.length - 1; i >= 0; i--) {
        if (!activeTickets.has(_entries[i].ticket)) {
          _entries.splice(i, 1);
          changed = true;
        }
      }
      if (changed) _notify();
    }

    /** @returns {ReadonlyArray} */
    function entries() {
      return _entries;
    }

    return { record, prune, entries, onChange };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: Scanner
  // ═══════════════════════════════════════════════════════════════════════

  const Scanner = (() => {
    const HIGHLIGHT_ATTR = "data-pdiff-highlight";
    const DIFF_ATTR = "data-price-diff";
    const THRESH_ATTR = "data-price-threshold";

    let _timer = null;
    let _paused = false;
    const _cooldowns = {}; // ticket → last-alerted timestamp

    let stats = { total: 0, yellow: 0, red: 0 };
    const _statsListeners = [];

    function onStats(fn) {
      _statsListeners.push(fn);
    }

    function _notifyStats() {
      _statsListeners.forEach((fn) => {
        try {
          fn(stats);
        } catch {
          /* swallow */
        }
      });
    }

    /** @returns {boolean} Whether the scanner is currently paused. */
    function isPaused() {
      return _paused;
    }

    // ── Row painting ────────────────────────────────────────────────────

    const YELLOW_BG = "rgba(255, 200, 0, 0.35)";
    const RED_BG = "rgba(220, 60, 60, 0.40)";

    function _paintRow(row, color) {
      const current = row.getAttribute(HIGHLIGHT_ATTR);
      if (color === null) {
        if (current === null) return;
        row.removeAttribute(HIGHLIGHT_ATTR);
        [...row.children].forEach((td) =>
          td.style.removeProperty("background-color"),
        );
      } else {
        if (current === color) return;
        row.setAttribute(HIGHLIGHT_ATTR, color);
        [...row.children].forEach((td) => {
          td.style.setProperty("background-color", color, "important");
        });
      }
    }

    function _parsePrice(raw) {
      return raw ? parseFloat(raw.replace(/\s/g, "")) : NaN;
    }

    // ── Core scan ───────────────────────────────────────────────────────

    function scan() {
      // ▸ Tab detection: only scan when Trade tab is active
      const activeTab = DOMQuery.getActiveTab();
      if (activeTab !== "trade") {
        if (!_paused) {
          _paused = true;
          _notifyStats(); // triggers UI to show pause banner
        }
        return;
      }

      if (_paused) {
        _paused = false;
        _notifyStats(); // triggers UI to hide pause banner
      }

      const tbody = DOMQuery.getTradeTbody();
      if (!tbody) return;

      const cols = DOMQuery.discoverColumns(tbody);
      if (!cols) return;

      let total = 0,
        yellow = 0,
        red = 0;
      const activeTickets = new Set();

      const rows = tbody.querySelectorAll(".tr[data-id]");
      rows.forEach((row) => {
        const cells = [...row.children];

        // Check if this is a "Placed" order
        const profitIdx = cols.profit;
        if (profitIdx === undefined) return;
        const profitCell = cells[profitIdx];
        if (!profitCell) return;

        const profitText = (
          profitCell.getAttribute("title") ||
          profitCell.textContent ||
          ""
        ).trim();
        if (profitText !== "Placed") {
          _paintRow(row, null);
          return;
        }

        const ticket = row.getAttribute("data-id") || "";
        activeTickets.add(ticket);
        total++;

        const openCell = cells[cols.openPrice];
        const closeCell = cells[cols.closePrice];
        const symbolCell = cells[cols.symbol];
        if (!openCell || !closeCell) return;

        const openPrice = _parsePrice(
          (openCell.getAttribute("title") || openCell.textContent || "").trim(),
        );
        const closePrice = _parsePrice(
          (
            closeCell.getAttribute("title") ||
            closeCell.textContent ||
            ""
          ).trim(),
        );
        const symbol = symbolCell
          ? (
              symbolCell.getAttribute("title") ||
              symbolCell.textContent ||
              ""
            ).trim()
          : "";

        if (isNaN(openPrice) || isNaN(closePrice)) return;

        const diff = Math.abs(closePrice - openPrice);
        const { yellowThresh, redThresh } = Thresholds.compute(openPrice);

        row.setAttribute(DIFF_ATTR, diff.toFixed(6));
        row.setAttribute(THRESH_ATTR, yellowThresh.toFixed(6));

        if (diff < redThresh) {
          _paintRow(row, RED_BG);
          red++;
          _fireAlert(ticket, symbol, diff, redThresh);
        } else if (diff < yellowThresh) {
          _paintRow(row, YELLOW_BG);
          yellow++;
        } else {
          _paintRow(row, null);
        }
      });

      stats = { total, yellow, red };
      AlertLog.prune(activeTickets);
      _notifyStats();
    }

    function _fireAlert(ticket, symbol, diff, threshold) {
      const now = Date.now();
      if (
        _cooldowns[ticket] &&
        now - _cooldowns[ticket] < Config.get("cooldownMs")
      )
        return;
      _cooldowns[ticket] = now;

      Audio.playAlert();
      AlertLog.record(ticket, symbol);
      Notifier.send(symbol, diff, threshold, ticket);
    }

    // ── Timer management ────────────────────────────────────────────────

    function start() {
      stop();
      scan();
      _timer = setInterval(scan, Config.get("intervalMs"));
    }

    function stop() {
      if (_timer) {
        clearInterval(_timer);
        _timer = null;
      }
    }

    function restart() {
      start();
    }

    function getStats() {
      return stats;
    }

    return { scan, start, stop, restart, isPaused, onStats, getStats };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: UI
  // ═══════════════════════════════════════════════════════════════════════

  const UI = (() => {
    // ── Constants ──────────────────────────────────────────────────────

    const SCRIPT_META = Object.freeze({
      name: "Deriv MT5 — Placed Order Price Diff Tracker",
      version: "9.0",
      description:
        "Modular architecture. Theme-aware UI. Trade-tab detection with pause banner. Robust DOM queries. Chart indicator scaffold.",
      author: "https://github.com/TeleVoyant",
      namespace: "http://mt5-real01-web-svg.deriv.com/",
      match: "http(s)://mt5-real01-web-svg.deriv.com/*",
      runAt: "document-end",
    });

    const startTime = Date.now();

    // ── Element refs ──────────────────────────────────────────────────

    let widget, pill, panel, aboutPopup, pauseBanner;
    let panelOpen = false;

    // ── Helpers ───────────────────────────────────────────────────────

    function timeAgo(ms) {
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      return `${Math.floor(s / 3600)}h ago`;
    }

    function formatUptime(ms) {
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sc = s % 60;
      return [h ? `${h}h` : "", m ? `${m}m` : "", `${sc}s`]
        .filter(Boolean)
        .join(" ");
    }

    // ── Styles ────────────────────────────────────────────────────────

    function _injectStyles() {
      const style = document.createElement("style");
      style.id = "pdiff-styles";
      style.textContent = `
        /* ═══════════════════════════════════════════════════════════════
           All colors reference CSS variables set by ThemeEngine.applyTo()
           so they auto-switch with dark/light theme.
           ═══════════════════════════════════════════════════════════════ */

        #pdiff-widget {
          position: fixed; top: 10px; right: 100px; z-index: 999999;
          font-family: 'Trebuchet MS', Roboto, Ubuntu, sans-serif;
          font-size: 16px; user-select: none;
        }

        /* ── pill ── */
        #pdiff-pill {
          display: flex; align-items: center; gap: 7px;
          background: var(--pdiff-card);
          border: 1px solid var(--pdiff-border); border-radius: 20px;
          padding: 5px 12px 5px 8px; cursor: pointer;
          box-shadow: 0 2px 12px rgba(0,0,0,0.4);
          transition: box-shadow 0.2s, border-color 0.2s;
        }
        #pdiff-pill:hover {
          border-color: var(--pdiff-blue);
          box-shadow: 0 4px 18px rgba(69,151,255,0.25);
        }

        #pdiff-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: var(--pdiff-green); flex-shrink: 0;
          box-shadow: 0 0 6px var(--pdiff-green);
          animation: pdiff-pulse 2s infinite;
        }
        #pdiff-dot.red {
          background: var(--pdiff-red);
          box-shadow: 0 0 8px var(--pdiff-red);
          animation: pdiff-pulse-red 0.6s infinite;
        }
        #pdiff-dot.yellow {
          background: #ffc800;
          box-shadow: 0 0 6px #ffc800;
        }
        #pdiff-dot.paused {
          background: var(--pdiff-orange);
          box-shadow: 0 0 6px var(--pdiff-orange);
          animation: pdiff-pulse 1.5s infinite;
        }

        @keyframes pdiff-pulse     { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes pdiff-pulse-red { 0%,100%{opacity:1} 50%{opacity:0.2} }

        #pdiff-pill-label {
          color: var(--pdiff-text-secondary);
          font-size: 12px; letter-spacing: 0.5px; text-transform: uppercase;
        }
        #pdiff-pill-badges { display: flex; gap: 4px; }

        .pdiff-badge {
          border-radius: 10px; padding: 1px 7px;
          font-size: 12px; font-weight: 600; line-height: 16px;
        }
        .pdiff-badge.y {
          background: rgba(255,200,0,0.18); color: #ffc800;
          border: 1px solid rgba(255,200,0,0.3);
        }
        .pdiff-badge.r {
          background: rgba(220,60,60,0.18); color: var(--pdiff-red);
          border: 1px solid rgba(220,60,60,0.3);
        }
        .pdiff-badge.t {
          background: rgba(69,151,255,0.12); color: var(--pdiff-blue);
          border: 1px solid rgba(69,151,255,0.25);
        }

        /* ── panel ── */
        #pdiff-panel {
          position: absolute; top: calc(100% + 8px); right: 0;
          width: 340px; max-height: 80vh;
          background: var(--pdiff-bg);
          border: 1px solid var(--pdiff-border); border-radius: 12px;
          box-shadow: 0 16px 46px rgba(0,0,0,0.55);
          display: flex; flex-direction: column; overflow: hidden;
          opacity: 0; pointer-events: none; transform: translateY(-6px);
          transition: opacity 0.18s ease, transform 0.18s ease;
        }
        #pdiff-panel.open {
          opacity: 1; pointer-events: all; transform: translateY(0);
        }

        #pdiff-panel-header {
          padding: 14px 16px 10px;
          border-bottom: 1px solid var(--pdiff-border);
          display: flex; align-items: center; justify-content: space-between;
        }
        #pdiff-panel-title {
          color: var(--pdiff-text); font-weight: 600; font-size: 16px;
        }
        #pdiff-panel-close {
          color: var(--pdiff-text-disabled); cursor: pointer;
          font-size: 18px; line-height: 1; transition: color 0.15s;
        }
        #pdiff-panel-close:hover { color: var(--pdiff-text); }

        /* stats row */
        #pdiff-stats {
          display: grid; grid-template-columns: 1fr 1fr 1fr 1fr;
          gap: 8px; padding: 12px 16px;
          border-bottom: 1px solid var(--pdiff-border);
        }
        .pdiff-stat {
          background: var(--pdiff-card); border-radius: 8px;
          padding: 8px 6px; text-align: center;
          border: 1px solid var(--pdiff-border);
        }
        .pdiff-stat-val {
          font-size: 18px; font-weight: 700;
          color: var(--pdiff-text); line-height: 1.2;
        }
        .pdiff-stat-val.up  { color: var(--pdiff-text-secondary); font-size: 14px; font-weight: 600; }
        .pdiff-stat-val.yel { color: #ffc800; }
        .pdiff-stat-val.red { color: var(--pdiff-red); }
        .pdiff-stat-val.blu { color: var(--pdiff-blue); }
        .pdiff-stat-lbl {
          font-size: 10px; color: var(--pdiff-text-disabled);
          text-transform: uppercase; letter-spacing: 0.4px; margin-top: 2px;
        }

        /* section titles */
        .pdiff-section-title {
          padding: 10px 16px 6px; font-size: 10px; font-weight: 700;
          color: var(--pdiff-text-disabled);
          text-transform: uppercase; letter-spacing: 0.8px;
        }

        /* alert list */
        #pdiff-alert-list {
          max-height: 150px; overflow-y: auto; padding: 0 16px 8px;
        }
        #pdiff-alert-list::-webkit-scrollbar { width: 4px; }
        #pdiff-alert-list::-webkit-scrollbar-track { background: transparent; }
        #pdiff-alert-list::-webkit-scrollbar-thumb {
          background: var(--pdiff-border); border-radius: 2px;
        }
        .pdiff-alert-item {
          display: flex; align-items: center; gap: 8px;
          padding: 7px 10px; border-radius: 7px; margin-bottom: 4px;
          background: var(--pdiff-card);
          border: 1px solid var(--pdiff-border);
          cursor: pointer; transition: border-color 0.15s;
        }
        .pdiff-alert-item:hover { border-color: var(--pdiff-blue); }
        .pdiff-alert-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--pdiff-red); flex-shrink: 0;
        }
        .pdiff-alert-main { flex: 1; min-width: 0; }
        .pdiff-alert-symbol {
          color: var(--pdiff-text); font-size: 14px; font-weight: 600;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pdiff-alert-ticket { color: var(--pdiff-text-disabled); font-size: 10px; }
        .pdiff-alert-time { color: var(--pdiff-blue); font-size: 10px; white-space: nowrap; }
        .pdiff-empty {
          color: var(--pdiff-text-disabled); font-size: 14px;
          padding: 10px 0; text-align: center;
        }

        /* settings */
        #pdiff-settings {
          padding: 0 16px 8px;
          border-top: 1px solid var(--pdiff-border);
        }
        .pdiff-setting-row {
          display: flex; align-items: center; justify-content: space-between;
          padding: 7px 0;
          border-bottom: 1px solid rgba(43,53,67,0.5);
        }
        .pdiff-setting-row:last-of-type { border-bottom: none; }
        .pdiff-setting-label { color: var(--pdiff-text-secondary); font-size: 14px; }
        .pdiff-input {
          background: var(--pdiff-card);
          border: 1px solid var(--pdiff-border); border-radius: 6px;
          color: var(--pdiff-text); font-size: 14px;
          padding: 3px 8px; width: 90px;
          outline: none; transition: border-color 0.15s;
        }
        .pdiff-input:focus { border-color: var(--pdiff-blue); }
        .pdiff-select {
          background: var(--pdiff-card);
          border: 1px solid var(--pdiff-border); border-radius: 6px;
          color: var(--pdiff-text); font-size: 14px;
          padding: 3px 6px; outline: none; cursor: pointer;
          transition: border-color 0.15s;
        }
        .pdiff-select:focus { border-color: var(--pdiff-blue); }
        .pdiff-warning {
          font-size: 10px; color: var(--pdiff-text-disabled);
          padding: 6px 0 10px; border-top: 1px solid var(--pdiff-border);
          line-height: 1.5;
        }
        .pdiff-warning span { color: var(--pdiff-orange); }

        /* about button */
        #pdiff-about-btn {
          margin: 0 16px 14px; padding: 7px; border-radius: 7px;
          background: rgba(69,151,255,0.08);
          border: 1px solid rgba(69,151,255,0.2);
          color: var(--pdiff-blue); font-size: 14px; font-weight: 600;
          text-align: center; cursor: pointer; transition: background 0.15s;
        }
        #pdiff-about-btn:hover { background: rgba(69,151,255,0.15); }

        /* about popup */
        #pdiff-about-popup {
          position: fixed; inset: 0; z-index: 9999999;
          background: rgba(0,0,0,0.6);
          display: flex; align-items: center; justify-content: center;
          opacity: 0; pointer-events: none; transition: opacity 0.18s;
        }
        #pdiff-about-popup.open { opacity: 1; pointer-events: all; }
        #pdiff-about-box {
          background: var(--pdiff-bg);
          border: 1px solid var(--pdiff-border); border-radius: 14px;
          padding: 24px 28px; width: 380px;
          box-shadow: 0 24px 60px rgba(0,0,0,0.6);
          transform: scale(0.95); transition: transform 0.18s;
        }
        #pdiff-about-popup.open #pdiff-about-box { transform: scale(1); }
        #pdiff-about-box h2 {
          color: var(--pdiff-text); font-size: 15px; margin: 0 0 4px;
        }
        #pdiff-about-box .v {
          color: var(--pdiff-blue); font-size: 14px; margin-bottom: 14px;
        }
        .pdiff-about-row {
          display: flex; gap: 8px; padding: 5px 0;
          border-bottom: 1px solid var(--pdiff-border);
        }
        .pdiff-about-row:last-of-type { border-bottom: none; }
        .pdiff-about-key {
          color: var(--pdiff-text-disabled); font-size: 12px;
          width: 90px; flex-shrink: 0;
          text-transform: uppercase; letter-spacing: 0.4px; padding-top: 1px;
        }
        .pdiff-about-val {
          color: var(--pdiff-text-secondary); font-size: 14px;
          line-height: 1.5; word-break: break-all;
        }
        #pdiff-about-close-btn {
          margin-top: 16px; width: 100%; padding: 8px;
          background: rgba(69,151,255,0.1);
          border: 1px solid rgba(69,151,255,0.25);
          border-radius: 8px; color: var(--pdiff-blue);
          font-size: 16px; font-weight: 600;
          cursor: pointer; transition: background 0.15s;
        }
        #pdiff-about-close-btn:hover { background: rgba(69,151,255,0.2); }

        #pdiff-panel-scroll { overflow-y: auto; flex: 1; }
        #pdiff-panel-scroll::-webkit-scrollbar { width: 4px; }
        #pdiff-panel-scroll::-webkit-scrollbar-thumb {
          background: var(--pdiff-border); border-radius: 2px;
        }

        /* ── Pause banner ── */
        #pdiff-pause-banner {
          display: none; /* shown by JS */
          position: fixed; bottom: 60px; left: 50%;
          transform: translateX(-50%);
          z-index: 999998;
          background: var(--pdiff-card);
          border: 1px solid var(--pdiff-orange);
          border-radius: 10px; padding: 10px 20px;
          color: var(--pdiff-orange); font-size: 14px; font-weight: 600;
          font-family: 'Trebuchet MS', Roboto, Ubuntu, sans-serif;
          box-shadow: 0 4px 20px rgba(0,0,0,0.4);
          animation: pdiff-banner-in 0.3s ease;
          cursor: pointer;
        }
        #pdiff-pause-banner.visible { display: flex; align-items: center; gap: 8px; }
        @keyframes pdiff-banner-in {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        #pdiff-pause-banner .pdiff-pause-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: var(--pdiff-orange);
          animation: pdiff-pulse 1.5s infinite;
        }
      `;
      document.head.appendChild(style);
    }

    // ── Build ─────────────────────────────────────────────────────────

    function build() {
      _injectStyles();

      // ── Widget root ──
      widget = document.createElement("div");
      widget.id = "pdiff-widget";

      // ── Pill ──
      pill = document.createElement("div");
      pill.id = "pdiff-pill";
      pill.innerHTML = `
        <div id="pdiff-dot"></div>
        <span id="pdiff-pill-label">Price Diff</span>
        <div id="pdiff-pill-badges">
          <span class="pdiff-badge t" id="pdiff-badge-total">0</span>
          <span class="pdiff-badge y" id="pdiff-badge-yellow">0</span>
          <span class="pdiff-badge r" id="pdiff-badge-red">0</span>
        </div>
      `;
      pill.addEventListener("click", togglePanel);

      // ── Panel ──
      panel = document.createElement("div");
      panel.id = "pdiff-panel";
      panel.innerHTML = `
        <div id="pdiff-panel-header">
          <span id="pdiff-panel-title">Price Diff Monitor</span>
          <span id="pdiff-panel-close" title="Close">\u2715</span>
        </div>
        <div id="pdiff-panel-scroll">
          <div id="pdiff-stats">
            <div class="pdiff-stat">
              <div class="pdiff-stat-val up" id="pdiff-stat-uptime">0s</div>
              <div class="pdiff-stat-lbl">Uptime</div>
            </div>
            <div class="pdiff-stat">
              <div class="pdiff-stat-val blu" id="pdiff-stat-total">0</div>
              <div class="pdiff-stat-lbl">Orders</div>
            </div>
            <div class="pdiff-stat">
              <div class="pdiff-stat-val yel" id="pdiff-stat-yellow">0</div>
              <div class="pdiff-stat-lbl">Watch</div>
            </div>
            <div class="pdiff-stat">
              <div class="pdiff-stat-val red" id="pdiff-stat-red">0</div>
              <div class="pdiff-stat-lbl">Near</div>
            </div>
          </div>

          <div class="pdiff-section-title">Alert Log</div>
          <div id="pdiff-alert-list">
            <div class="pdiff-empty">No alerts yet</div>
          </div>

          <div class="pdiff-section-title">Settings</div>
          <div id="pdiff-settings">
            <div class="pdiff-setting-row">
              <span class="pdiff-setting-label">Scan interval (ms)</span>
              <input class="pdiff-input" id="pdiff-set-interval" type="number"
                     min="500" max="30000" value="${Config.get("intervalMs")}">
            </div>
            <div class="pdiff-setting-row">
              <span class="pdiff-setting-label">Alert cooldown (ms)</span>
              <input class="pdiff-input" id="pdiff-set-cooldown" type="number"
                     min="1000" max="600000" value="${Config.get("cooldownMs")}">
            </div>
            <div class="pdiff-setting-row">
              <span class="pdiff-setting-label">Tier sensitivity</span>
              <select class="pdiff-select" id="pdiff-set-sensitivity">
                <option value="tight" ${Config.get("sensitivity") === "tight" ? "selected" : ""}>Tight (0.5\u00D7)</option>
                <option value="default" ${Config.get("sensitivity") === "default" ? "selected" : ""}>Default (1\u00D7)</option>
                <option value="loose" ${Config.get("sensitivity") === "loose" ? "selected" : ""}>Loose (2\u00D7)</option>
              </select>
            </div>
            <div class="pdiff-warning">
              <span>\u26A0 Note:</span> Settings are persisted in localStorage and survive page reloads.
            </div>
          </div>

          <div id="pdiff-about-btn">About this script</div>
        </div>
      `;

      // Panel close
      panel
        .querySelector("#pdiff-panel-close")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          closePanel();
        });

      // Settings listeners
      panel
        .querySelector("#pdiff-set-interval")
        .addEventListener("change", (e) => {
          const v = parseInt(e.target.value, 10);
          if (Config.set("intervalMs", v)) {
            Scanner.restart();
          }
        });
      panel
        .querySelector("#pdiff-set-cooldown")
        .addEventListener("change", (e) => {
          Config.set("cooldownMs", parseInt(e.target.value, 10));
        });
      panel
        .querySelector("#pdiff-set-sensitivity")
        .addEventListener("change", (e) => {
          Config.set("sensitivity", e.target.value);
        });

      // About
      panel
        .querySelector("#pdiff-about-btn")
        .addEventListener("click", openAbout);

      widget.appendChild(pill);
      widget.appendChild(panel);

      // ── About popup ──
      aboutPopup = document.createElement("div");
      aboutPopup.id = "pdiff-about-popup";
      aboutPopup.innerHTML = `
        <div id="pdiff-about-box">
          <h2>${SCRIPT_META.name}</h2>
          <div class="v">v${SCRIPT_META.version}</div>
          ${Object.entries({
            Description: SCRIPT_META.description,
            Author: SCRIPT_META.author,
            Namespace: SCRIPT_META.namespace,
            Match: SCRIPT_META.match,
            "Run at": SCRIPT_META.runAt,
          })
            .map(
              ([k, v]) =>
                `<div class="pdiff-about-row"><span class="pdiff-about-key">${k}</span><span class="pdiff-about-val">${v}</span></div>`,
            )
            .join("")}
          <button id="pdiff-about-close-btn">Close</button>
        </div>
      `;
      aboutPopup.addEventListener("click", (e) => {
        if (e.target === aboutPopup) closeAbout();
      });
      aboutPopup
        .querySelector("#pdiff-about-close-btn")
        .addEventListener("click", closeAbout);

      // ── Pause banner ──
      pauseBanner = document.createElement("div");
      pauseBanner.id = "pdiff-pause-banner";
      pauseBanner.innerHTML = `
        <div class="pdiff-pause-dot"></div>
        <span>Scan paused — switch to <strong>Trade</strong> tab to resume</span>
      `;
      pauseBanner.addEventListener("click", () => {
        // Try clicking the Trade tab button
        const tradeBtn = document.querySelector('[title="Trade"]');
        if (tradeBtn) tradeBtn.click();
      });

      // ── Append to DOM ──
      document.body.appendChild(widget);
      document.body.appendChild(aboutPopup);
      document.body.appendChild(pauseBanner);

      // Apply theme variables
      ThemeEngine.applyTo(widget);
      ThemeEngine.applyTo(aboutPopup);
      ThemeEngine.applyTo(pauseBanner);

      // ── Uptime ticker ──
      setInterval(() => {
        const el = document.getElementById("pdiff-stat-uptime");
        if (el) el.textContent = formatUptime(Date.now() - startTime);
      }, 1000);

      // ── Close panel on outside click ──
      document.addEventListener("click", (e) => {
        if (panelOpen && !widget.contains(e.target)) closePanel();
      });

      // ── Subscribe to events ──

      Scanner.onStats((s) => {
        _updatePill(s);
        _updatePauseBanner();
      });

      AlertLog.onChange(() => {
        _renderAlertLog();
      });

      ThemeEngine.onChange(() => {
        ThemeEngine.applyTo(widget);
        ThemeEngine.applyTo(aboutPopup);
        ThemeEngine.applyTo(pauseBanner);
      });

      // Alert log time refresh
      setInterval(() => {
        if (AlertLog.entries().length) _renderAlertLog();
      }, 10000);
    }

    // ── Panel control ─────────────────────────────────────────────────

    function togglePanel() {
      panelOpen ? closePanel() : openPanel();
    }

    function openPanel() {
      panelOpen = true;
      panel.classList.add("open");
    }

    function closePanel() {
      panelOpen = false;
      panel.classList.remove("open");
    }

    function openAbout() {
      aboutPopup.classList.add("open");
    }

    function closeAbout() {
      aboutPopup.classList.remove("open");
    }

    // ── Updates ───────────────────────────────────────────────────────

    function _updatePill(s) {
      const dot = document.getElementById("pdiff-dot");
      if (!dot) return;

      if (Scanner.isPaused()) {
        dot.className = "paused";
      } else if (s.red > 0) {
        dot.className = "red";
      } else if (s.yellow > 0) {
        dot.className = "yellow";
      } else {
        dot.className = "";
      }

      const setEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };

      setEl("pdiff-badge-total", s.total);
      setEl("pdiff-badge-yellow", s.yellow);
      setEl("pdiff-badge-red", s.red);
      setEl("pdiff-stat-total", s.total);
      setEl("pdiff-stat-yellow", s.yellow);
      setEl("pdiff-stat-red", s.red);
    }

    function _updatePauseBanner() {
      if (!pauseBanner) return;
      if (Scanner.isPaused()) {
        pauseBanner.classList.add("visible");
      } else {
        pauseBanner.classList.remove("visible");
      }
    }

    function _renderAlertLog() {
      const listEl = document.getElementById("pdiff-alert-list");
      if (!listEl) return;

      const entries = AlertLog.entries();
      if (entries.length === 0) {
        listEl.innerHTML = '<div class="pdiff-empty">No alerts yet</div>';
        return;
      }

      listEl.innerHTML = entries
        .map(
          (a) => `
          <div class="pdiff-alert-item" data-ticket="${a.ticket}" title="Click to focus order row">
            <div class="pdiff-alert-dot"></div>
            <div class="pdiff-alert-main">
              <div class="pdiff-alert-symbol">${a.symbol}</div>
              <div class="pdiff-alert-ticket">#${a.ticket}</div>
            </div>
            <div class="pdiff-alert-time">${timeAgo(a.time)}</div>
          </div>`,
        )
        .join("");

      listEl.querySelectorAll(".pdiff-alert-item").forEach((item) => {
        item.addEventListener("click", () => {
          const ticket = item.dataset.ticket;
          const row = document.querySelector(`.tr[data-id="${ticket}"]`);
          if (row) {
            row.click();
            row.scrollIntoView({ behavior: "smooth", block: "center" });
          }
          closePanel();
        });
      });
    }

    return { build };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: App  — boot / lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  const App = (() => {
    function boot() {
      // 1. Load persisted config
      Config.load();

      // 2. Start theme engine
      ThemeEngine.init();

      // 3. Request notification permission
      Notifier.requestPermission();

      // 4. Build UI
      UI.build();

      // 5. Start scanner after a short delay (let MT5 app hydrate)
      setTimeout(() => {
        Scanner.start();
      }, 5000);

      console.log(
        `[pdiff] v9.0 booted — theme: ${ThemeEngine.current()}, interval: ${Config.get("intervalMs")}ms`,
      );
    }

    return { boot };
  })();

  // ── GO ──────────────────────────────────────────────────────────────
  App.boot();
})();
