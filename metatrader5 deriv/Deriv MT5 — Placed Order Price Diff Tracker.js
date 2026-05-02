// ==UserScript==
// @name         Deriv MT5 — Placed Order Price Diff Tracker
// @namespace    http://mt5-real01-web-svg.deriv.com/
// @icon         https://play-lh.googleusercontent.com/65e0HntWSHuxvon8vp-Vai1gOMXQxBr0YhqDcZkAg9ligsqkJNuPnJgmbMcWii3TsA=w240-h480
// @version      8.0
// @description  Tiered adaptive thresholds by price magnitude. Yellow = watch zone. Red = near-trigger alert + sound + notification. Includes status indicator widget.
// @author       github.com/TeleVoyant
// @match        http://mt5-real01-web-svg.deriv.com/*
// @match        https://mt5-real01-web-svg.deriv.com/*
// @grant        GM_notification
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  if (window.location.hostname !== "mt5-real01-web-svg.deriv.com") return;

  // ─── SCRIPT META (mirrors ==UserScript== header for the About popup) ────────
  const SCRIPT_META = {
    name: "Deriv MT5 — Placed Order Price Diff Tracker",
    version: "8.0",
    description:
      "Tiered adaptive thresholds by price magnitude. Yellow = watch zone. Red = near-trigger alert + sound + notification.",
    author: "https://github.com/TeleVoyant",
    namespace: "http://mt5-real01-web-svg.deriv.com/",
    match: "http(s)://mt5-real01-web-svg.deriv.com/*",
    runAt: "document-end",
  };

  // ─── MUTABLE CONFIG (can be changed via settings panel) ────────────────────
  let cfg = {
    intervalMs: 5000,
    cooldownMs: 300000,
    // sensitivity multiplier applied on top of tier fractions: 1 = default
    // 'tight' = 0.5×, 'default' = 1×, 'loose' = 2×
    sensitivity: "default",
  };

  // ─── CONSTANTS ──────────────────────────────────────────────────────────────
  const YELLOW_BG = "rgba(255, 200, 0, 0.35)";
  const RED_BG = "rgba(220, 60, 60, 0.40)";
  const HIGHLIGHT_ATTR = "data-pdiff-highlight";
  const DIFF_ATTR = "data-price-diff";
  const THRESH_ATTR = "data-price-threshold";

  // ─── TIERED ADAPTIVE THRESHOLDS ────────────────────────────────────────────
  // Tiers are matched on |openPrice| magnitude. Each tier specifies:
  //   yellowFrac  — watch zone  (dim yellow)
  //   redFrac     — alert zone  (dim red + sound + notification)
  //
  // Tier boundaries and fractions are tuned against real observed prices.
  const THRESHOLD_TIERS = [
    // price < 10  → Forex / micro pairs (e.g. GBPAUD 1.87, EURUSD 1.08)
    // Moves in 4th–5th decimal place. 0.3% yellow, 0.05% red.
    { maxPrice: 10, yellowFrac: 0.003, redFrac: 0.0005 },

    // 10 – 500  → Small-scale indices (Vol 50 ~80–100, Vol 100 ~480–600)
    // Moderate tick size relative to price. 1.5% yellow, 0.3% red.
    { maxPrice: 500, yellowFrac: 0.015, redFrac: 0.003 },

    // 500 – 5 000  → Mid-range indices (Vol 75(1s) ~4500, Vol 100(1s) ~1300)
    // 1% yellow, 0.2% red.
    { maxPrice: 5000, yellowFrac: 0.01, redFrac: 0.002 },

    // 5 000 – 30 000  → Large volatility indices (Vol 90(1s) ~10k, Vol 10(1s) ~10k)
    // 0.8% yellow, 0.15% red.
    { maxPrice: 30000, yellowFrac: 0.008, redFrac: 0.0015 },

    // 30 000 – 60 000  → Jump/Crash mid (Vol 75 ~35k, Jump 50 ~45k, Crash 900 ~18k)
    // 0.6% yellow, 0.1% red.
    { maxPrice: 60000, yellowFrac: 0.006, redFrac: 0.001 },

    // 60 000 – 110 000  → Large Jump/Boom (Jump 10 ~97k, Boom 50 ~104k)
    // Fast-moving. 0.4% yellow, 0.08% red.
    { maxPrice: 110000, yellowFrac: 0.004, redFrac: 0.0008 },

    // > 110 000  → Very large indices (Jump 25 ~134k and above)
    // 0.3% yellow, 0.06% red.
    { maxPrice: Infinity, yellowFrac: 0.003, redFrac: 0.0006 },
  ];

  // Returns { yellowThresh, redThresh } for a given open price.
  // Selects the tier whose maxPrice is the first one >= |openPrice|,
  // then multiplies the fractions. Floor of 1e-9 prevents zero issues.
  function getThresholds(openPrice) {
    const abs = Math.abs(openPrice);
    const tier =
      THRESHOLD_TIERS.find((t) => abs < t.maxPrice) ||
      THRESHOLD_TIERS[THRESHOLD_TIERS.length - 1];
    const mult =
      cfg.sensitivity === "tight"
        ? 0.5
        : cfg.sensitivity === "loose"
          ? 2.0
          : 1.0;
    return {
      yellowThresh: Math.max(abs * tier.yellowFrac * mult, 1e-9),
      redThresh: Math.max(abs * tier.redFrac * mult, 1e-9),
    };
  }

  // ─── STATE ──────────────────────────────────────────────────────────────────
  const startTime = Date.now();
  const lastAlerted = {}; // Track last-alerted timestamp per data-id to avoid spam rowId → timestamp
  const alertLog = []; // { ticket, symbol, time, timeLabel }
  let scanTimer = null;
  let stats = { total: 0, yellow: 0, red: 0 };

  // ─── AUDIO ──────────────────────────────────────────────────────────────────
  //  generated via Web Audio API (no external file needed)
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx)
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function playAlert() {
    try {
      const ctx = getAudioCtx();
      // Three rising beeps
      [0, 0.18, 0.36].forEach((startOffset, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.type = "sine";
        osc.frequency.value = 660 + i * 220; // 660 → 880 → 1100 Hz

        const t = ctx.currentTime + startOffset;
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

  // ─── NOTIFICATION ──────────────────────────────────────────────────────────
  function requestNotifPermission() {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission();
    }
  }

  // Find the symbol's chart tab/button and click it.
  // The left-bar shows the active chart symbol. Clicking the chart area
  // title for the symbol is not directly clickable, but we can attempt to
  // switch chart symbol by finding any visible symbol text in the market
  // watch or chart title and clicking it. As a reliable fallback we focus
  // the window so the user sees the highlight.
  function focusSymbolChart(symbol) {
    window.focus();

    //document.querySelectorAll('.tr[data-id]').forEach(row => {
    //    const c = row.children[0];
    //    if (c && (c.getAttribute('title') || '').includes(symbol)) {
    //        row.click();
    //        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    //    }
    //});

    // Try to find a clickable element in the chart title area that contains
    // the symbol name — the chart title div shows "Symbol, H1: ..."
    const titleDivs = document.querySelectorAll(".title");
    for (const div of titleDivs) {
      if (div.textContent.includes(symbol)) {
        div.scrollIntoView({ behavior: "smooth", block: "center" });
        break;
      }
    }

    // Also scroll the matching table row into view
    const rows = document.querySelectorAll(".tr[data-id]");
    for (const row of rows) {
      const symCell = row.children[0];
      if (symCell && (symCell.getAttribute("title") || "").includes(symbol)) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.click(); // <-- Added this line to click the entire row
        break;
      }
    }
  }

  function fireAlert(rowId, symbol, ticket, diff, threshold) {
    const now = Date.now();
    if (lastAlerted[rowId] && now - lastAlerted[rowId] < cfg.cooldownMs) return;
    lastAlerted[rowId] = now;
    playAlert();

    // Add to alert log (deduplicate by ticket)
    if (!alertLog.find((a) => a.ticket === ticket)) {
      alertLog.unshift({ ticket, symbol, time: now });
    } else {
      const entry = alertLog.find((a) => a.ticket === ticket);
      entry.time = now; // update time
    }
    renderAlertLog();

    const body = `${symbol} — ${diff.toFixed(5)} from trigger (limit ${threshold.toFixed(5)})`;
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        const n = new Notification(`Near Market: ${symbol}`, {
          body,
          icon: "/terminal/B8oDqCFA.ico",
          tag: `pdiff-${rowId}`,
          requireInteraction: true,
        });
        n.onclick = () => {
          window.focus();
          focusSymbolChart(symbol);
          n.close();
        };
      } catch (e) {
        console.warn("[pdiff] notif:", e);
      }
    } else if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission().then((p) => {
        if (p === "granted") fireAlert(rowId, symbol, ticket, diff, threshold);
      });
    }
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────
  function parsePrice(raw) {
    return raw ? parseFloat(raw.replace(/\s/g, "")) : NaN;
  }

  // ─── CELL COLORING ─────────────────────────────────────────────────────────
  // Paint every .td in the row. Pass null to clear.
  function paintRow(row, color) {
    const current = row.getAttribute(HIGHLIGHT_ATTR);
    if (color === null) {
      if (current === null) return; // already clear
      row.removeAttribute(HIGHLIGHT_ATTR);
      [...row.children].forEach((td) =>
        td.style.removeProperty("background-color"),
      );
    } else {
      if (current === color) return; // already correct color
      row.setAttribute(HIGHLIGHT_ATTR, color);
      [...row.children].forEach((td) => {
        td.style.setProperty("background-color", color, "important");
      });
    }
  }

  // ─── COLUMN INDEX DISCOVERY ────────────────────────────────────────────────
  function discoverColumnIndices(tbody) {
    const fallback = {
      symbolIdx: 0,
      ticketIdx: 1,
      timeIdx: 2,
      openIdx: 5,
      closeIdx: 8,
      profitIdx: 10,
    };
    const hdr = tbody.querySelector(".tr:not([data-id])");
    if (!hdr) return fallback;
    let symbolIdx = 0,
      ticketIdx = 1,
      timeIdx = 2,
      openIdx = -1,
      closeIdx = -1,
      profitIdx = -1;
    [...hdr.children].forEach((th, i) => {
      const t = (th.getAttribute("title") || "").trim();
      if (t === "Open Price") openIdx = i;
      if (t === "Close Price") closeIdx = i;
      if (t === "Profit") profitIdx = i;
      if (t === "Symbol") symbolIdx = i;
      if (t === "Ticket") ticketIdx = i;
      if (t === "Time") timeIdx = i;
    });
    return {
      symbolIdx: symbolIdx,
      ticketIdx: ticketIdx,
      timeIdx: timeIdx,
      openIdx: openIdx >= 0 ? openIdx : fallback.openIdx,
      closeIdx: closeIdx >= 0 ? closeIdx : fallback.closeIdx,
      profitIdx: profitIdx >= 0 ? profitIdx : fallback.profitIdx,
    };
  }

  function timeAgo(ms) {
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sc = s % 60;
    return [h ? `${h}h` : "", m ? `${m}m` : "", `${sc}s`]
      .filter(Boolean)
      .join(" ");
  }

  // ─── MAIN SCAN ─────────────────────────────────────────────────────────────
  // Track active tickets to prune alert log
  const activeTickets = new Set();

  function scan() {
    const tbodies = document.querySelectorAll(".tbody");
    if (!tbodies.length) return;

    let total = 0,
      yellow = 0,
      red = 0;
    activeTickets.clear();

    tbodies.forEach((tbody) => {
      const idx = discoverColumnIndices(tbody);
      tbody.querySelectorAll(".tr[data-id]").forEach((row) => {
        const cells = [...row.children];
        const profitCell = cells[idx.profitIdx];
        if (!profitCell) return;
        const profit = (
          profitCell.getAttribute("title") ||
          profitCell.textContent ||
          ""
        ).trim();
        if (profit !== "Placed") {
          paintRow(row, null);
          return;
        }

        const ticket = row.getAttribute("data-id") || "";
        activeTickets.add(ticket);
        total++;

        const openCell = cells[idx.openIdx];
        const closeCell = cells[idx.closeIdx];
        const symbolCell = cells[idx.symbolIdx];
        if (!openCell || !closeCell) return;

        const openPrice = parsePrice(
          (openCell.getAttribute("title") || openCell.textContent || "").trim(),
        );
        const closePrice = parsePrice(
          (
            closeCell.getAttribute("title") ||
            closeCell.textContent ||
            ""
          ).trim(),
        );
        const symbol = (
          symbolCell
            ? symbolCell.getAttribute("title") || symbolCell.textContent || ""
            : ""
        ).trim();

        if (isNaN(openPrice) || isNaN(closePrice)) return;

        const diff = Math.abs(closePrice - openPrice);
        const { yellowThresh, redThresh } = getThresholds(openPrice);
        row.setAttribute(DIFF_ATTR, diff.toFixed(6));
        row.setAttribute(THRESH_ATTR, yellowThresh.toFixed(6));

        if (diff < redThresh) {
          paintRow(row, RED_BG);
          red++;
          fireAlert(ticket, symbol, ticket, diff, redThresh);
        } else if (diff < yellowThresh) {
          paintRow(row, YELLOW_BG);
          yellow++;
        } else {
          paintRow(row, null);
        }
      });
    });

    stats = { total, yellow, red };

    // Prune alert log — remove entries whose ticket is no longer on the table
    for (let i = alertLog.length - 1; i >= 0; i--) {
      if (!activeTickets.has(alertLog[i].ticket)) alertLog.splice(i, 1);
    }

    updateWidget();
  }

  // ─── UI ─────────────────────────────────────────────────────────────────────
  let panelOpen = false;
  let aboutOpen = false;
  let widget, pill, panel, alertListEl, uptimeEl, totalEl, yellowEl, redEl;

  function buildUI() {
    // ── Inject styles ──────────────────────────────────────────────────────
    const style = document.createElement("style");
    style.textContent = `
      #pdiff-widget {
        position: fixed; top: 10px; right: 100px; z-index: 999999;
        font-family: 'Trebuchet MS', Roboto, Ubuntu, sans-serif;
        font-size: 16px; user-select: none;
      }

      /* ── pill ── */
      #pdiff-pill {
        display: flex; align-items: center; gap: 7px;
        background: linear-gradient(135deg, #1a2535 0%, #0f1720 100%);
        border: 1px solid #2b3543; border-radius: 20px;
        padding: 5px 12px 5px 8px; cursor: pointer;
        box-shadow: 0 2px 12px rgba(0,0,0,0.4);
        transition: box-shadow 0.2s, border-color 0.2s;
      }
      #pdiff-pill:hover { border-color: #4597ff; box-shadow: 0 4px 18px rgba(69,151,255,0.25); }
      #pdiff-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #36b34b; flex-shrink: 0;
        box-shadow: 0 0 6px #36b34b;
        animation: pdiff-pulse 2s infinite;
      }
      #pdiff-dot.red  { background: #ff5858; box-shadow: 0 0 8px #ff5858; animation: pdiff-pulse-red 0.6s infinite; }
      #pdiff-dot.yellow { background: #ffc800; box-shadow: 0 0 6px #ffc800; }
      @keyframes pdiff-pulse     { 0%,100%{opacity:1} 50%{opacity:0.4} }
      @keyframes pdiff-pulse-red { 0%,100%{opacity:1} 50%{opacity:0.2} }
      #pdiff-pill-label { color: #8fa2b8; font-size: 12px; letter-spacing: 0.5px; text-transform: uppercase; }
      #pdiff-pill-badges { display: flex; gap: 4px; }
      .pdiff-badge {
        border-radius: 10px; padding: 1px 7px; font-size: 12px; font-weight: 600;
        line-height: 16px;
      }
      .pdiff-badge.y { background: rgba(255,200,0,0.18); color: #ffc800; border: 1px solid rgba(255,200,0,0.3); }
      .pdiff-badge.r { background: rgba(220,60,60,0.18);  color: #ff5858; border: 1px solid rgba(220,60,60,0.3); }
      .pdiff-badge.t { background: rgba(69,151,255,0.12); color: #4597ff; border: 1px solid rgba(69,151,255,0.25); }

      /* ── panel ── */
      #pdiff-panel {
        position: absolute; top: calc(100% + 8px); right: 0;
        width: 340px; max-height: 80vh;
        background: #151e2b; border: 1px solid #2b3543; border-radius: 12px;
        box-shadow: 0 16px 46px rgba(0,0,0,0.55);
        display: flex; flex-direction: column; overflow: hidden;
        opacity: 0; pointer-events: none; transform: translateY(-6px);
        transition: opacity 0.18s ease, transform 0.18s ease;
      }
      #pdiff-panel.open { opacity: 1; pointer-events: all; transform: translateY(0); }

      /* panel header */
      #pdiff-panel-header {
        padding: 14px 16px 10px; border-bottom: 1px solid #1e2d3d;
        display: flex; align-items: center; justify-content: space-between;
      }
      #pdiff-panel-title { color: #fff; font-weight: 600; font-size: 16px; }
      #pdiff-panel-close {
        color: #647181; cursor: pointer; font-size: 18px; line-height: 1;
        transition: color 0.15s;
      }
      #pdiff-panel-close:hover { color: #fff; }

      /* stats row */
      #pdiff-stats {
        display: grid; grid-template-columns: 1fr 1fr 1fr 1fr;
        gap: 8px; padding: 12px 16px; border-bottom: 1px solid #1e2d3d;
      }
      .pdiff-stat {
        background: #1a2535; border-radius: 8px; padding: 8px 6px;
        text-align: center; border: 1px solid #2b3543;
      }
      .pdiff-stat-val { font-size: 18px; font-weight: 700; color: #fff; line-height: 1.2; }
      .pdiff-stat-val.up  { color: #8fa2b8; font-size: 14px; font-weight: 600; }
      .pdiff-stat-val.yel { color: #ffc800; }
      .pdiff-stat-val.red { color: #ff5858; }
      .pdiff-stat-val.blu { color: #4597ff; }
      .pdiff-stat-lbl { font-size: 10px; color: #647181; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 2px; }

      /* section titles */
      .pdiff-section-title {
        padding: 10px 16px 6px; font-size: 10px; font-weight: 700;
        color: #647181; text-transform: uppercase; letter-spacing: 0.8px;
      }

      /* alert list */
      #pdiff-alert-list {
        max-height: 150px; overflow-y: auto; padding: 0 16px 8px;
      }
      #pdiff-alert-list::-webkit-scrollbar { width: 4px; }
      #pdiff-alert-list::-webkit-scrollbar-track { background: transparent; }
      #pdiff-alert-list::-webkit-scrollbar-thumb { background: #2b3543; border-radius: 2px; }
      .pdiff-alert-item {
        display: flex; align-items: center; gap: 8px;
        padding: 7px 10px; border-radius: 7px; margin-bottom: 4px;
        background: #1a2535; border: 1px solid #2b3543; cursor: pointer;
        transition: border-color 0.15s;
      }
      .pdiff-alert-item:hover { border-color: #4597ff; }
      .pdiff-alert-dot { width: 6px; height: 6px; border-radius: 50%; background: #ff5858; flex-shrink:0; }
      .pdiff-alert-main { flex: 1; min-width: 0; }
      .pdiff-alert-symbol { color: #fff; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pdiff-alert-ticket { color: #647181; font-size: 10px; }
      .pdiff-alert-time { color: #4597ff; font-size: 10px; white-space: nowrap; }
      .pdiff-empty { color: #647181; font-size: 14px; padding: 10px 0; text-align: center; }

      /* settings */
      #pdiff-settings { padding: 0 16px 8px; border-top: 1px solid #1e2d3d; }
      .pdiff-setting-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 7px 0; border-bottom: 1px solid rgba(43,53,67,0.5);
      }
      .pdiff-setting-row:last-of-type { border-bottom: none; }
      .pdiff-setting-label { color: #8fa2b8; font-size: 14px; }
      .pdiff-input {
        background: #1a2535; border: 1px solid #2b3543; border-radius: 6px;
        color: #fff; font-size: 14px; padding: 3px 8px; width: 90px;
        outline: none; transition: border-color 0.15s;
      }
      .pdiff-input:focus { border-color: #4597ff; }
      .pdiff-select {
        background: #1a2535; border: 1px solid #2b3543; border-radius: 6px;
        color: #fff; font-size: 14px; padding: 3px 6px;
        outline: none; cursor: pointer; transition: border-color 0.15s;
      }
      .pdiff-select:focus { border-color: #4597ff; }
      .pdiff-warning {
        font-size: 10px; color: #647181; padding: 6px 0 10px;
        border-top: 1px solid #1e2d3d; line-height: 1.5;
      }
      .pdiff-warning span { color: #ff8643; }

      /* about button */
      #pdiff-about-btn {
        margin: 0 16px 14px; padding: 7px; border-radius: 7px;
        background: rgba(69,151,255,0.08); border: 1px solid rgba(69,151,255,0.2);
        color: #4597ff; font-size: 14px; font-weight: 600;
        text-align: center; cursor: pointer; transition: background 0.15s;
      }
      #pdiff-about-btn:hover { background: rgba(69,151,255,0.15); }

      /* about popup */
      #pdiff-about-popup {
        position: fixed; inset: 0; z-index: 9999999;
        background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none; transition: opacity 0.18s;
      }
      #pdiff-about-popup.open { opacity: 1; pointer-events: all; }
      #pdiff-about-box {
        background: #151e2b; border: 1px solid #2b3543; border-radius: 14px;
        padding: 24px 28px; width: 380px; box-shadow: 0 24px 60px rgba(0,0,0,0.6);
        transform: scale(0.95); transition: transform 0.18s;
      }
      #pdiff-about-popup.open #pdiff-about-box { transform: scale(1); }
      #pdiff-about-box h2 { color: #fff; font-size: 15px; margin: 0 0 4px; }
      #pdiff-about-box .v { color: #4597ff; font-size: 14px; margin-bottom: 14px; }
      .pdiff-about-row { display: flex; gap: 8px; padding: 5px 0; border-bottom: 1px solid #1e2d3d; }
      .pdiff-about-row:last-of-type { border-bottom: none; }
      .pdiff-about-key { color: #647181; font-size: 12px; width: 90px; flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.4px; padding-top: 1px; }
      .pdiff-about-val { color: #d1d1d2; font-size: 14px; line-height: 1.5; word-break: break-all; }
      #pdiff-about-close-btn {
        margin-top: 16px; width: 100%; padding: 8px;
        background: rgba(69,151,255,0.1); border: 1px solid rgba(69,151,255,0.25);
        border-radius: 8px; color: #4597ff; font-size: 16px; font-weight: 600;
        cursor: pointer; transition: background 0.15s;
      }
      #pdiff-about-close-btn:hover { background: rgba(69,151,255,0.2); }
      #pdiff-panel-scroll { overflow-y: auto; flex: 1; }
      #pdiff-panel-scroll::-webkit-scrollbar { width: 4px; }
      #pdiff-panel-scroll::-webkit-scrollbar-thumb { background: #2b3543; border-radius: 2px; }
    `;
    document.head.appendChild(style);

    // ── Widget root ────────────────────────────────────────────────────────
    widget = document.createElement("div");
    widget.id = "pdiff-widget";

    // ── Pill ───────────────────────────────────────────────────────────────
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

    // ── Panel ──────────────────────────────────────────────────────────────
    panel = document.createElement("div");
    panel.id = "pdiff-panel";
    panel.innerHTML = `
      <div id="pdiff-panel-header">
        <span id="pdiff-panel-title">📊 Price Diff Monitor</span>
        <span id="pdiff-panel-close" title="Close">✕</span>
      </div>

      <div id="pdiff-panel-scroll">

        <!-- Stats -->
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

        <!-- Alert Log -->
        <div class="pdiff-section-title">🔔 Alert Log</div>
        <div id="pdiff-alert-list">
          <div class="pdiff-empty" id="pdiff-no-alerts">No alerts yet</div>
        </div>

        <!-- Settings -->
        <div class="pdiff-section-title">⚙️ Settings</div>
        <div id="pdiff-settings">
          <div class="pdiff-setting-row">
            <span class="pdiff-setting-label">Scan interval (ms)</span>
            <input class="pdiff-input" id="pdiff-set-interval" type="number" min="500" max="30000" value="5000">
          </div>
          <div class="pdiff-setting-row">
            <span class="pdiff-setting-label">Alert cooldown (ms)</span>
            <input class="pdiff-input" id="pdiff-set-cooldown" type="number" min="5000" max="300000" value="300000">
          </div>
          <div class="pdiff-setting-row">
            <span class="pdiff-setting-label">Tier sensitivity</span>
            <select class="pdiff-select" id="pdiff-set-sensitivity">
              <option value="tight">Tight (0.5×)</option>
              <option value="default" selected>Default (1×)</option>
              <option value="loose">Loose (2×)</option>
            </select>
          </div>
          <div class="pdiff-warning">
            <span>⚠ Warning:</span> Settings reset on page reload. Changes apply immediately to the next scan cycle.
          </div>
        </div>

        <!-- About -->
        <div id="pdiff-about-btn">ℹ About this script</div>

      </div><!-- /scroll -->
    `;

    panel.querySelector("#pdiff-panel-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closePanel();
    });

    // Settings listeners
    panel
      .querySelector("#pdiff-set-interval")
      .addEventListener("change", (e) => {
        const v = parseInt(e.target.value, 10);
        if (v >= 500) {
          cfg.intervalMs = v;
          restartTimer();
        }
      });
    panel
      .querySelector("#pdiff-set-cooldown")
      .addEventListener("change", (e) => {
        const v = parseInt(e.target.value, 10);
        if (v >= 1000) cfg.cooldownMs = v;
      });
    panel
      .querySelector("#pdiff-set-sensitivity")
      .addEventListener("change", (e) => {
        cfg.sensitivity = e.target.value;
      });

    // About button
    panel
      .querySelector("#pdiff-about-btn")
      .addEventListener("click", openAbout);

    widget.appendChild(pill);
    widget.appendChild(panel);

    // ── About popup ────────────────────────────────────────────────────────
    const aboutPopup = document.createElement("div");
    aboutPopup.id = "pdiff-about-popup";
    aboutPopup.innerHTML = `
      <div id="pdiff-about-box">
        <h2>${SCRIPT_META.name}</h2>
        <div class="v">v${SCRIPT_META.version}</div>
        <div class="pdiff-about-row"><span class="pdiff-about-key">Description</span><span class="pdiff-about-val">${SCRIPT_META.description}</span></div>
        <div class="pdiff-about-row"><span class="pdiff-about-key">Author</span><span class="pdiff-about-val">${SCRIPT_META.author}</span></div>
        <div class="pdiff-about-row"><span class="pdiff-about-key">Namespace</span><span class="pdiff-about-val">${SCRIPT_META.namespace}</span></div>
        <div class="pdiff-about-row"><span class="pdiff-about-key">Match</span><span class="pdiff-about-val">${SCRIPT_META.match}</span></div>
        <div class="pdiff-about-row"><span class="pdiff-about-key">Run at</span><span class="pdiff-about-val">${SCRIPT_META.runAt}</span></div>
        <button id="pdiff-about-close-btn">Close</button>
      </div>
    `;
    aboutPopup.addEventListener("click", (e) => {
      if (e.target === aboutPopup) closeAbout();
    });
    aboutPopup
      .querySelector("#pdiff-about-close-btn")
      .addEventListener("click", closeAbout);

    document.body.appendChild(widget);
    document.body.appendChild(aboutPopup);

    // Store refs
    uptimeEl = document.getElementById("pdiff-stat-uptime");
    totalEl = document.getElementById("pdiff-stat-total");
    yellowEl = document.getElementById("pdiff-stat-yellow");
    redEl = document.getElementById("pdiff-stat-red");
    alertListEl = document.getElementById("pdiff-alert-list");

    // Uptime ticker
    setInterval(updateUptime, 1000);

    // Close panel on outside click
    document.addEventListener("click", (e) => {
      if (panelOpen && !widget.contains(e.target)) closePanel();
    });
  }

  function togglePanel() {
    panelOpen ? closePanel() : openPanel();
  }
  function openPanel() {
    panelOpen = true;
    panel.classList.add("open");
    updateWidget();
  }
  function closePanel() {
    panelOpen = false;
    panel.classList.remove("open");
  }
  function openAbout() {
    aboutOpen = true;
    document.getElementById("pdiff-about-popup").classList.add("open");
  }
  function closeAbout() {
    aboutOpen = false;
    document.getElementById("pdiff-about-popup").classList.remove("open");
  }

  function updateUptime() {
    if (uptimeEl) uptimeEl.textContent = formatUptime(Date.now() - startTime);
  }

  function updateWidget() {
    if (!pill) return;
    const dot = document.getElementById("pdiff-dot");
    const badgeTotal = document.getElementById("pdiff-badge-total");
    const badgeYellow = document.getElementById("pdiff-badge-yellow");
    const badgeRed = document.getElementById("pdiff-badge-red");

    // Pill dot colour priority: red > yellow > green
    dot.className = stats.red > 0 ? "red" : stats.yellow > 0 ? "yellow" : "";

    badgeTotal.textContent = stats.total;
    badgeYellow.textContent = stats.yellow;
    badgeRed.textContent = stats.red;

    if (totalEl) totalEl.textContent = stats.total;
    if (yellowEl) yellowEl.textContent = stats.yellow;
    if (redEl) redEl.textContent = stats.red;
  }

  function renderAlertLog() {
    if (!alertListEl) return;
    if (alertLog.length === 0) {
      alertListEl.innerHTML =
        '<div class="pdiff-empty" id="pdiff-no-alerts">No alerts yet</div>';
      return;
    }
    alertListEl.innerHTML = alertLog
      .map(
        (a) => `
      <div class="pdiff-alert-item" data-ticket="${a.ticket}" title="Click to focus order row">
        <div class="pdiff-alert-dot"></div>
        <div class="pdiff-alert-main">
          <div class="pdiff-alert-symbol">${a.symbol}</div>
          <div class="pdiff-alert-ticket">#${a.ticket}</div>
        </div>
        <div class="pdiff-alert-time">${timeAgo(a.time)}</div>
      </div>
    `,
      )
      .join("");

    // Click handlers on alert items
    alertListEl.querySelectorAll(".pdiff-alert-item").forEach((item) => {
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

  // Update alert time labels every #seconds
  setInterval(() => {
    if (alertLog.length) renderAlertLog();
  }, cfg.cooldownMs);

  // ─── TIMER MANAGEMENT ───────────────────────────────────────────────────────
  function restartTimer() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = setInterval(scan, cfg.intervalMs);
  }

  // ─── BOOT ───────────────────────────────────────────────────────────────────
  requestNotifPermission();
  buildUI();
  setTimeout(() => {
    scan();
    restartTimer();
  }, 10000);
})();
