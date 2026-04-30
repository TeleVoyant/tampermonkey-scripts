// ==UserScript==
// @name         Deriv MT5 — Placed Order Price Diff Tracker
// @namespace    http://mt5-real01-web-svg.deriv.com/
// @icon         https://play-lh.googleusercontent.com/65e0HntWSHuxvon8vp-Vai1gOMXQxBr0YhqDcZkAg9ligsqkJNuPnJgmbMcWii3TsA=w240-h480
// @version      6.0
// @description  Yellow = diff < 1% of open. Red = diff < 0.1% (near trigger). Plays sound + notification on red threshold.
// @author       github.com/TeleVoyant
// @match        http://mt5-real01-web-svg.deriv.com/*
// @match        https://mt5-real01-web-svg.deriv.com/*
// @grant        GM_notification
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    if (window.location.hostname !== 'mt5-real01-web-svg.deriv.com') return;

    // ─── CONFIG ────────────────────────────────────────────────────────────────
    const INTERVAL_MS          = 5000;
    const YELLOW_FRACTION      = 0.01;   // < 1%  of open → dim yellow
    const RED_FRACTION         = 0.001;  // < 0.1% of open → dim red + alert
    const YELLOW_BG            = 'rgba(255, 200, 0, 0.35)';
    const RED_BG               = 'rgba(220, 60, 60, 0.40)';
    const HIGHLIGHT_ATTR       = 'data-pdiff-highlight';
    const DIFF_ATTR            = 'data-price-diff';
    const THRESH_ATTR          = 'data-price-threshold';
    const ALERT_COOLDOWN_MS    = 180000;  // don't re-alert same row within 180 s

    // Track last-alerted timestamp per data-id to avoid spam
    const lastAlerted = {};

    // ─── AUDIO — generated via Web Audio API (no external file needed) ─────────
    let audioCtx = null;
    function getAudioCtx() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return audioCtx;
    }

    function playAlert() {
        try {
            const ctx = getAudioCtx();
            // Three rising beeps
            [0, 0.18, 0.36].forEach((startOffset, i) => {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.type = 'sine';
                osc.frequency.value = 660 + i * 220; // 660 → 880 → 1100 Hz

                const t = ctx.currentTime + startOffset;
                gain.gain.setValueAtTime(0, t);
                gain.gain.linearRampToValueAtTime(0.4, t + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);

                osc.start(t);
                osc.stop(t + 0.16);
            });
        } catch (e) {
            console.warn('[pdiff] audio error:', e);
        }
    }

    // ─── NOTIFICATION ──────────────────────────────────────────────────────────
    function requestNotifPermission() {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
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
        const titleDivs = document.querySelectorAll('.title');
        for (const div of titleDivs) {
            if (div.textContent.includes(symbol)) {
                div.scrollIntoView({ behavior: 'smooth', block: 'center' });
                break;
            }
        }

        // Also scroll the matching table row into view
        const rows = document.querySelectorAll('.tr[data-id]');
        for (const row of rows) {
            const symCell = row.children[0];
            if (symCell && (symCell.getAttribute('title') || '').includes(symbol)) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                row.click(); // <-- Added this line to click the entire row
                break;
            }
        }
    }

    function fireAlert(rowId, symbol, diff, threshold) {
        const now = Date.now();
        if (lastAlerted[rowId] && now - lastAlerted[rowId] < ALERT_COOLDOWN_MS) return;
        lastAlerted[rowId] = now;

        playAlert();

        const pct = ((diff / threshold) * RED_FRACTION * 100).toFixed(3);
        const body = `${symbol} is ${(diff).toFixed(5)} away from trigger (threshold ${threshold.toFixed(5)}). Tap to view.`;

        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
                const n = new Notification(`Order: ${symbol}`, {
                    body,
                    icon: '/terminal/B8oDqCFA.ico',
                    tag:  `pdiff-${rowId}`,         // replaces previous notif for same row
                    requireInteraction: true,        // stays until dismissed
                });
                n.onclick = () => {
                    window.focus();
                    focusSymbolChart(symbol);
                    n.close();
                };
            } catch (e) {
                console.warn('[pdiff] notification error:', e);
            }
        } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission().then(p => {
                if (p === 'granted') fireAlert(rowId, symbol, diff, threshold);
            });
        }
    }

    // ─── HELPERS ───────────────────────────────────────────────────────────────
    function parsePrice(raw) {
        if (!raw) return NaN;
        return parseFloat(raw.replace(/\s/g, ''));
    }

    function adaptiveThreshold(openPrice, fraction) {
        return Math.max(Math.abs(openPrice) * fraction, 1e-9);
    }

    // ─── CELL COLORING ─────────────────────────────────────────────────────────
    // Paint every .td in the row. Pass null to clear.
    function paintRow(row, color) {
        const current = row.getAttribute(HIGHLIGHT_ATTR);
        if (color === null) {
            if (current === null) return;           // already clear
            row.removeAttribute(HIGHLIGHT_ATTR);
            [...row.children].forEach(td => td.style.removeProperty('background-color'));
        } else {
            if (current === color) return;          // already correct color
            row.setAttribute(HIGHLIGHT_ATTR, color);
            [...row.children].forEach(td => {
                td.style.setProperty('background-color', color, 'important');
            });
        }
    }

    // ─── COLUMN INDEX DISCOVERY ────────────────────────────────────────────────
    function discoverColumnIndices(tbody) {
        const fallback  = { openIdx: 5, closeIdx: 8, profitIdx: 10, symbolIdx: 0 };
        const headerRow = tbody.querySelector('.tr:not([data-id])');
        if (!headerRow) return fallback;

        let openIdx = -1, closeIdx = -1, profitIdx = -1, symbolIdx = 0;
        [...headerRow.children].forEach((th, i) => {
            const t = (th.getAttribute('title') || '').trim();
            if (t === 'Open Price')  openIdx   = i;
            if (t === 'Close Price') closeIdx  = i;
            if (t === 'Profit')      profitIdx = i;
            if (t === 'Symbol')      symbolIdx = i;
        });

        return {
            openIdx:   openIdx   >= 0 ? openIdx   : fallback.openIdx,
            closeIdx:  closeIdx  >= 0 ? closeIdx  : fallback.closeIdx,
            profitIdx: profitIdx >= 0 ? profitIdx : fallback.profitIdx,
            symbolIdx,
        };
    }

    // ─── MAIN SCAN ─────────────────────────────────────────────────────────────
    function scan() {
        const tbodies = document.querySelectorAll('.tbody');
        if (!tbodies.length) return;

        tbodies.forEach(tbody => {
            const { openIdx, closeIdx, profitIdx, symbolIdx } = discoverColumnIndices(tbody);

            tbody.querySelectorAll('.tr[data-id]').forEach(row => {
                const cells = [...row.children];

                const profitCell = cells[profitIdx];
                if (!profitCell) return;

                const profitText = (profitCell.getAttribute('title') || profitCell.textContent || '').trim();

                if (profitText !== 'Placed') {
                    paintRow(row, null);
                    return;
                }

                const openCell   = cells[openIdx];
                const closeCell  = cells[closeIdx];
                const symbolCell = cells[symbolIdx];
                if (!openCell || !closeCell) return;

                const openPrice  = parsePrice((openCell.getAttribute('title')  || openCell.textContent  || '').trim());
                const closePrice = parsePrice((closeCell.getAttribute('title') || closeCell.textContent || '').trim());
                const symbol     = (symbolCell ? (symbolCell.getAttribute('title') || symbolCell.textContent || '') : '').trim();

                if (isNaN(openPrice) || isNaN(closePrice)) return;

                const diff         = Math.abs(closePrice - openPrice);
                const redThresh    = adaptiveThreshold(openPrice, RED_FRACTION);
                const yellowThresh = adaptiveThreshold(openPrice, YELLOW_FRACTION);

                row.setAttribute(DIFF_ATTR,   diff.toFixed(6));
                row.setAttribute(THRESH_ATTR, yellowThresh.toFixed(6));

                if (diff < redThresh) {
                    paintRow(row, RED_BG);
                    fireAlert(row.getAttribute('data-id'), symbol, diff, redThresh);
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