// ==UserScript==
// @name         Deriv MT5 — Placed Order Price Diff Tracker
// @namespace    http://mt5-real01-web-svg.deriv.com/
// @icon         https://play-lh.googleusercontent.com/65e0HntWSHuxvon8vp-Vai1gOMXQxBr0YhqDcZkAg9ligsqkJNuPnJgmbMcWii3TsA=w240-h480
// @version      7.0
// @description  Tiered adaptive thresholds by price magnitude. Yellow = watch zone. Red = near-trigger alert + sound + notification.
// @author       github.com/TeleVoyant
// @match        http://mt5-real01-web-svg.deriv.com/*
// @match        https://mt5-real01-web-svg.deriv.com/*
// @grant        GM_notification
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  if (window.location.hostname !== "mt5-real01-web-svg.deriv.com") return;

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const INTERVAL_MS = 5000;
  const YELLOW_BG = "rgba(255, 200, 0, 0.35)";
  const RED_BG = "rgba(220, 60, 60, 0.40)";
  const HIGHLIGHT_ATTR = "data-pdiff-highlight";
  const DIFF_ATTR = "data-price-diff";
  const THRESH_ATTR = "data-price-threshold";
  const ALERT_COOLDOWN_MS = 180000; // 3 min ms between alerts for the same row

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

  /**
   * Returns { yellowThresh, redThresh } for a given open price.
   * Selects the tier whose maxPrice is the first one >= |openPrice|,
   * then multiplies the fractions. Floor of 1e-9 prevents zero issues.
   */
  function getThresholds(openPrice) {
    const abs = Math.abs(openPrice);
    const tier =
      THRESHOLD_TIERS.find((t) => abs < t.maxPrice) ||
      THRESHOLD_TIERS[THRESHOLD_TIERS.length - 1];
    return {
      yellowThresh: Math.max(abs * tier.yellowFrac, 1e-9),
      redThresh: Math.max(abs * tier.redFrac, 1e-9),
    };
  }

  // Track last-alerted timestamp per data-id to avoid spam
  const lastAlerted = {};

  // ─── AUDIO — generated via Web Audio API (no external file needed) ─────────
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

  function fireAlert(rowId, symbol, diff, threshold) {
    const now = Date.now();
    if (lastAlerted[rowId] && now - lastAlerted[rowId] < ALERT_COOLDOWN_MS)
      return;
    lastAlerted[rowId] = now;

    playAlert();

    const pct = ((diff / threshold) * 100).toFixed(3);
    const body = `${symbol} is ${diff.toFixed(5)} away from trigger (threshold ${threshold.toFixed(5)}). Tap to view.`;

    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        const n = new Notification(`Order About To Enter Market`, {
          body,
          icon: "/terminal/B8oDqCFA.ico",
          tag: `pdiff-${rowId}`, // replaces previous notif for same row
          requireInteraction: true, // stays until dismissed
        });
        n.onclick = () => {
          window.focus();
          focusSymbolChart(symbol);
          n.close();
        };
      } catch (e) {
        console.warn("[pdiff] notification error:", e);
      }
    } else if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission().then((p) => {
        if (p === "granted") fireAlert(rowId, symbol, diff, threshold);
      });
    }
  }

  // ─── HELPERS ───────────────────────────────────────────────────────────────
  function parsePrice(raw) {
    if (!raw) return NaN;
    return parseFloat(raw.replace(/\s/g, ""));
  }

  // getThresholds() above replaces the old adaptiveThreshold()

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
    const fallback = { openIdx: 5, closeIdx: 8, profitIdx: 10, symbolIdx: 0 };
    const headerRow = tbody.querySelector(".tr:not([data-id])");
    if (!headerRow) return fallback;

    let openIdx = -1,
      closeIdx = -1,
      profitIdx = -1,
      symbolIdx = 0;
    [...headerRow.children].forEach((th, i) => {
      const t = (th.getAttribute("title") || "").trim();
      if (t === "Open Price") openIdx = i;
      if (t === "Close Price") closeIdx = i;
      if (t === "Profit") profitIdx = i;
      if (t === "Symbol") symbolIdx = i;
    });

    return {
      openIdx: openIdx >= 0 ? openIdx : fallback.openIdx,
      closeIdx: closeIdx >= 0 ? closeIdx : fallback.closeIdx,
      profitIdx: profitIdx >= 0 ? profitIdx : fallback.profitIdx,
      symbolIdx,
    };
  }

  // ─── MAIN SCAN ─────────────────────────────────────────────────────────────
  function scan() {
    const tbodies = document.querySelectorAll(".tbody");
    if (!tbodies.length) return;

    tbodies.forEach((tbody) => {
      const { openIdx, closeIdx, profitIdx, symbolIdx } =
        discoverColumnIndices(tbody);

      tbody.querySelectorAll(".tr[data-id]").forEach((row) => {
        const cells = [...row.children];

        const profitCell = cells[profitIdx];
        if (!profitCell) return;

        const profitText = (
          profitCell.getAttribute("title") ||
          profitCell.textContent ||
          ""
        ).trim();

        if (profitText !== "Placed") {
          paintRow(row, null);
          return;
        }

        const openCell = cells[openIdx];
        const closeCell = cells[closeIdx];
        const symbolCell = cells[symbolIdx];
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
          fireAlert(row.getAttribute("data-id"), symbol, diff, redThresh);
        } else if (diff < yellowThresh) {
          paintRow(row, YELLOW_BG);
        } else {
          paintRow(row, null);
        }
      });
    });
  }

  // ─── BOOT ──────────────────────────────────────────────────────────────────
  requestNotifPermission();
  setTimeout(scan, 10000);
  setInterval(scan, INTERVAL_MS);
})();

