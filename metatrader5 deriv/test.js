// ==UserScript==
// @name         Deriv MT5 — SMC Indicator Plugin
// @namespace    http://mt5-real01-web-svg.deriv.com/
// @icon         https://play-lh.googleusercontent.com/65e0HntWSHuxvon8vp-Vai1gOMXQxBr0YhqDcZkAg9ligsqkJNuPnJgmbMcWii3TsA=w240-h480
// @version      2.0
// @description  Smart Money Concepts overlay for MT5 Web Terminal. WebSocket interception for OHLC data. Non-invasive canvas overlay.
// @author       github.com/TeleVoyant
// @match        http://mt5-real01-web-svg.deriv.com/*
// @match        https://mt5-real01-web-svg.deriv.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  SMC Indicator Plugin  v2.0                                             │
 * │                                                                          │
 * │  WHY v1.0 FAILED:                                                        │
 * │    1. Chart canvas is WebGL — getImageData() returns blank pixels        │
 * │    2. Injecting into .chart-overlay breaks WASM renderer DOM refs        │
 * │                                                                          │
 * │  v2.0 APPROACH:                                                          │
 * │    • @run-at document-start to intercept WebSocket before WASM boots     │
 * │    • Patch window.WebSocket to tap the binary protocol for OHLC data     │
 * │    • Place overlay canvas as SIBLING of .chart-overlay in .chart div     │
 * │    • pointer-events:none — zero interference with chart interactions     │
 * │    • Parse chart title for symbol + timeframe (stable [title] attrs)     │
 * │                                                                          │
 * │  Modules:                                                                │
 * │    WSInterceptor  — tap WebSocket messages for chart bar data            │
 * │    BarStore       — accumulate and manage OHLC bars per symbol           │
 * │    ChartInfo      — read symbol/timeframe/dimensions from DOM            │
 * │    SMCEngine      — swing detection, BOS/CHoCH, OB, FVG, PD, EQL        │
 * │    SMCRenderer    — draw markings on overlay canvas                       │
 * │    SMCPanel       — settings toggle UI                                   │
 * │    Overlay        — canvas management (sibling positioning)              │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

(function () {
  "use strict";

  if (window.location.hostname !== "mt5-real01-web-svg.deriv.com") return;

  // ═══════════════════════════════════════════════════════════════════════
  //  CONSTANTS & CONFIG
  // ═══════════════════════════════════════════════════════════════════════

  const SMC_VERSION = "2.0";
  const STORAGE_KEY = "smc_config_v2";

  const TF_MINUTES = {
    M1: 1,
    M5: 5,
    M15: 15,
    M30: 30,
    H1: 60,
    H4: 240,
    D1: 1440,
    W1: 10080,
    MN: 43200,
  };

  const SMCConfig = (() => {
    const DEFAULTS = {
      enabled: true,
      refreshMs: 1500,
      swingLookback: 5,
      showStructure: true,
      showOrderBlocks: true,
      showFVG: true,
      showPremiumDiscount: true,
      showEqualLevels: true,
      showLiquiditySweeps: true,
      obMaxDisplay: 5,
      fvgMinPips: 3,
      equalTolPercent: 0.05,
    };
    let _c = { ...DEFAULTS };

    function load() {
      try {
        const r = localStorage.getItem(STORAGE_KEY);
        if (r) _c = { ...DEFAULTS, ...JSON.parse(r) };
      } catch {
        /**/
      }
    }
    function save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_c));
      } catch {
        /**/
      }
    }
    function get(k) {
      return _c[k];
    }
    function set(k, v) {
      if (k in DEFAULTS) {
        _c[k] = v;
        save();
      }
    }
    function toggle(k) {
      if (typeof _c[k] === "boolean") {
        _c[k] = !_c[k];
        save();
        return _c[k];
      }
      return null;
    }
    function all() {
      return { ..._c };
    }
    return { load, save, get, set, toggle, all, DEFAULTS };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: WSInterceptor — tap WebSocket for chart bar data
  //  @run-at document-start ensures we patch BEFORE the WASM module boots
  // ═══════════════════════════════════════════════════════════════════════

  const WSInterceptor = (() => {
    const _listeners = []; // fn(data: ArrayBuffer | string)
    let _patched = false;

    /** Subscribe to all WebSocket messages. */
    function onMessage(fn) {
      _listeners.push(fn);
    }

    /**
     * Monkey-patch window.WebSocket to intercept all messages.
     * Must be called at document-start before the WASM module creates its socket.
     */
    function patch() {
      if (_patched) return;
      _patched = true;

      const OrigWS = window.WebSocket;

      window.WebSocket = function (url, protocols) {
        const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);

        const origAddEventListener = ws.addEventListener.bind(ws);

        // Intercept onmessage
        const _origOnMessage = { value: null };
        Object.defineProperty(ws, "onmessage", {
          get: () => _origOnMessage.value,
          set: (fn) => {
            _origOnMessage.value = fn;
          },
        });

        // Use a native listener to tap all messages
        origAddEventListener("message", (evt) => {
          _notifyListeners(evt.data);
          // Call the original handler if set
          if (_origOnMessage.value) {
            _origOnMessage.value(evt);
          }
        });

        // Also intercept addEventListener("message", ...)
        const origAEL = ws.addEventListener;
        ws.addEventListener = function (type, listener, options) {
          if (type === "message") {
            // Wrap the listener to also tap the data
            const wrapped = function (evt) {
              _notifyListeners(evt.data);
              listener.call(this, evt);
            };
            return origAEL.call(this, type, wrapped, options);
          }
          return origAEL.call(this, type, listener, options);
        };

        return ws;
      };

      // Copy static properties
      window.WebSocket.CONNECTING = OrigWS.CONNECTING;
      window.WebSocket.OPEN = OrigWS.OPEN;
      window.WebSocket.CLOSING = OrigWS.CLOSING;
      window.WebSocket.CLOSED = OrigWS.CLOSED;
      window.WebSocket.prototype = OrigWS.prototype;
    }

    function _notifyListeners(data) {
      for (const fn of _listeners) {
        try {
          fn(data);
        } catch {
          /**/
        }
      }
    }

    return { patch, onMessage };
  })();

  // Patch WebSocket immediately (before WASM boots)
  WSInterceptor.patch();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: BarStore — accumulate OHLC bars from WebSocket data
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * The MT5 binary protocol is proprietary and not publicly documented.
   * We cannot reliably parse individual OHLC bars from the wire.
   *
   * FALLBACK STRATEGY: Instead of parsing the binary protocol, we
   * accumulate price data from the market watch table (DOM) and build
   * our own OHLC bars at the configured timeframe interval.
   *
   * This gives us REAL price data without touching the chart canvas.
   */
  const BarStore = (() => {
    // Per-symbol bar buffers
    // { symbol: { bars: [{t, o, h, l, c}], currentBar: {t, o, h, l, c}, lastTick: number } }
    const _symbols = {};
    const MAX_BARS = 300;

    /**
     * Feed a tick price into the bar store.
     * @param {string} symbol
     * @param {number} price  Current bid price
     * @param {number} tfMinutes  Timeframe in minutes
     */
    function tick(symbol, price, tfMinutes) {
      if (!symbol || isNaN(price) || price <= 0) return;

      if (!_symbols[symbol]) {
        _symbols[symbol] = { bars: [], currentBar: null, lastTick: 0 };
      }

      const store = _symbols[symbol];
      const now = Date.now();
      const barMs = tfMinutes * 60 * 1000;
      const barTime = Math.floor(now / barMs) * barMs;

      if (!store.currentBar || store.currentBar.t !== barTime) {
        // Close current bar and start new one
        if (store.currentBar) {
          store.bars.push({ ...store.currentBar });
          if (store.bars.length > MAX_BARS) store.bars.shift();
        }
        store.currentBar = {
          t: barTime,
          o: price,
          h: price,
          l: price,
          c: price,
        };
      } else {
        // Update current bar
        store.currentBar.h = Math.max(store.currentBar.h, price);
        store.currentBar.l = Math.min(store.currentBar.l, price);
        store.currentBar.c = price;
      }

      store.lastTick = now;
    }

    /**
     * Get all completed bars + the current forming bar for a symbol.
     * @param {string} symbol
     * @returns {Array<{t, o, h, l, c}>}
     */
    function getBars(symbol) {
      const store = _symbols[symbol];
      if (!store) return [];
      const result = [...store.bars];
      if (store.currentBar) result.push({ ...store.currentBar });
      return result;
    }

    /** Get the count of accumulated bars. */
    function barCount(symbol) {
      const store = _symbols[symbol];
      if (!store) return 0;
      return store.bars.length + (store.currentBar ? 1 : 0);
    }

    return { tick, getBars, barCount };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: ChartInfo — read symbol, timeframe, price from DOM
  // ═══════════════════════════════════════════════════════════════════════

  const ChartInfo = (() => {
    function parseTitle() {
      const titleEl = document.querySelector(".title");
      if (!titleEl) return { symbol: null, tf: "H1", tfMinutes: 60 };
      const text = titleEl.textContent || "";
      const m = text.match(
        /([A-Za-z0-9._]+),\s*(M1|M5|M15|M30|H1|H4|D1|W1|MN)\s*:/,
      );
      if (m)
        return { symbol: m[1], tf: m[2], tfMinutes: TF_MINUTES[m[2]] || 60 };
      return { symbol: null, tf: "H1", tfMinutes: 60 };
    }

    /**
     * Read current bid price for a symbol from the market watch table.
     * Uses table structure + [title] attributes (no Svelte hashes).
     */
    function getCurrentPrice(symbol) {
      if (!symbol) return null;
      const rows = document.querySelectorAll("table tbody tr");
      for (const row of rows) {
        const nameEl = row.querySelector("td:first-child");
        if (!nameEl) continue;
        const name = (
          nameEl.getAttribute("title") ||
          nameEl.textContent ||
          ""
        ).trim();
        if (name === symbol || name.includes(symbol)) {
          const priceEl = row.querySelector("td:nth-child(2) .price");
          if (priceEl) {
            const p = parseFloat(priceEl.textContent.replace(/\s/g, ""));
            if (!isNaN(p)) return p;
          }
        }
      }
      return null;
    }

    /**
     * Get the chart canvas element and its dimensions.
     * We don't read pixels — only dimensions for coordinate mapping.
     */
    function getChartDimensions() {
      const canvas = document.querySelector(".chart-overlay canvas");
      if (!canvas) return null;
      return {
        width: canvas.width,
        height: canvas.height,
        cssWidth: canvas.clientWidth,
        cssHeight: canvas.clientHeight,
      };
    }

    /**
     * Get the .chart container (parent of .chart-overlay).
     * Our overlay goes here as a SIBLING, not inside .chart-overlay.
     */
    function getChartContainer() {
      const chartOverlay = document.querySelector(".chart-overlay");
      if (!chartOverlay) return null;
      return chartOverlay.parentElement; // This is the .chart div
    }

    return {
      parseTitle,
      getCurrentPrice,
      getChartDimensions,
      getChartContainer,
    };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: SMCEngine — Smart Money Concepts algorithms
  //  (Pure functions operating on OHLC arrays — no DOM access)
  // ═══════════════════════════════════════════════════════════════════════

  const SMCEngine = (() => {
    function detectSwings(bars, lookback) {
      const swings = [];
      for (let i = lookback; i < bars.length - lookback; i++) {
        let isHigh = true,
          isLow = true;
        for (let j = 1; j <= lookback; j++) {
          if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h)
            isHigh = false;
          if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l)
            isLow = false;
        }
        if (isHigh) swings.push({ idx: i, type: "high", price: bars[i].h });
        if (isLow) swings.push({ idx: i, type: "low", price: bars[i].l });
      }
      return swings.sort((a, b) => a.idx - b.idx);
    }

    function detectStructure(bars, swings) {
      const result = [];
      if (swings.length < 3) return result;
      let trend = "unknown",
        lastHi = null,
        lastLo = null;

      for (const sw of swings) {
        if (sw.type === "high") {
          if (lastHi) {
            if (sw.price > lastHi.price) {
              if (trend === "bull") {
                result.push({
                  type: "BOS",
                  dir: "bull",
                  price: lastHi.price,
                  fromIdx: lastHi.idx,
                  toIdx: sw.idx,
                });
              } else if (trend === "bear") {
                result.push({
                  type: "CHoCH",
                  dir: "bull",
                  price: lastHi.price,
                  fromIdx: lastHi.idx,
                  toIdx: sw.idx,
                });
                trend = "bull";
              } else {
                trend = "bull";
              }
            }
          }
          lastHi = sw;
        } else {
          if (lastLo) {
            if (sw.price < lastLo.price) {
              if (trend === "bear") {
                result.push({
                  type: "BOS",
                  dir: "bear",
                  price: lastLo.price,
                  fromIdx: lastLo.idx,
                  toIdx: sw.idx,
                });
              } else if (trend === "bull") {
                result.push({
                  type: "CHoCH",
                  dir: "bear",
                  price: lastLo.price,
                  fromIdx: lastLo.idx,
                  toIdx: sw.idx,
                });
                trend = "bear";
              } else {
                trend = "bear";
              }
            }
          }
          lastLo = sw;
        }
      }
      return result;
    }

    function detectOrderBlocks(bars, structures) {
      const obs = [];
      for (const s of structures) {
        const bi = s.toIdx;
        if (bi < 3) continue;
        if (s.dir === "bull") {
          for (let i = bi - 1; i >= Math.max(0, bi - 8); i--) {
            if (bars[i].c < bars[i].o) {
              // bearish candle
              obs.push({
                type: "bull",
                top: bars[i].h,
                bottom: bars[i].l,
                idx: i,
                mitigated: false,
              });
              break;
            }
          }
        } else {
          for (let i = bi - 1; i >= Math.max(0, bi - 8); i--) {
            if (bars[i].c > bars[i].o) {
              // bullish candle
              obs.push({
                type: "bear",
                top: bars[i].h,
                bottom: bars[i].l,
                idx: i,
                mitigated: false,
              });
              break;
            }
          }
        }
      }
      // Check mitigation
      for (const ob of obs) {
        for (let i = ob.idx + 1; i < bars.length; i++) {
          if (ob.type === "bull" && bars[i].l <= ob.bottom) {
            ob.mitigated = true;
            break;
          }
          if (ob.type === "bear" && bars[i].h >= ob.top) {
            ob.mitigated = true;
            break;
          }
        }
      }
      return obs
        .filter((o) => !o.mitigated)
        .slice(-SMCConfig.get("obMaxDisplay"));
    }

    function detectFVG(bars) {
      const fvgs = [];
      for (let i = 1; i < bars.length - 1; i++) {
        const prev = bars[i - 1],
          next = bars[i + 1];
        // Bullish FVG
        if (next.l > prev.h) {
          fvgs.push({
            type: "bull",
            top: next.l,
            bottom: prev.h,
            idx: i,
            filled: false,
          });
        }
        // Bearish FVG
        if (prev.l > next.h) {
          fvgs.push({
            type: "bear",
            top: prev.l,
            bottom: next.h,
            idx: i,
            filled: false,
          });
        }
      }
      for (const f of fvgs) {
        for (let i = f.idx + 2; i < bars.length; i++) {
          if (f.type === "bull" && bars[i].l <= f.bottom) {
            f.filled = true;
            break;
          }
          if (f.type === "bear" && bars[i].h >= f.top) {
            f.filled = true;
            break;
          }
        }
      }
      return fvgs.filter((f) => !f.filled);
    }

    function calcPremiumDiscount(swings) {
      const highs = swings.filter((s) => s.type === "high");
      const lows = swings.filter((s) => s.type === "low");
      if (!highs.length || !lows.length) return null;
      const hi = highs[highs.length - 1].price;
      const lo = lows[lows.length - 1].price;
      if (hi <= lo) return null;
      const eq = (hi + lo) / 2;
      return { high: hi, low: lo, equilibrium: eq };
    }

    function detectEqualLevels(swings) {
      const equals = [];
      const tol = SMCConfig.get("equalTolPercent") / 100;
      const highs = swings.filter((s) => s.type === "high");
      const lows = swings.filter((s) => s.type === "low");

      for (let i = 0; i < highs.length; i++) {
        for (let j = i + 1; j < highs.length; j++) {
          const avg = (highs[i].price + highs[j].price) / 2;
          if (Math.abs(highs[i].price - highs[j].price) / avg < tol) {
            equals.push({
              type: "EQH",
              price: avg,
              idx1: highs[i].idx,
              idx2: highs[j].idx,
            });
          }
        }
      }
      for (let i = 0; i < lows.length; i++) {
        for (let j = i + 1; j < lows.length; j++) {
          const avg = (lows[i].price + lows[j].price) / 2;
          if (Math.abs(lows[i].price - lows[j].price) / avg < tol) {
            equals.push({
              type: "EQL",
              price: avg,
              idx1: lows[i].idx,
              idx2: lows[j].idx,
            });
          }
        }
      }
      return equals;
    }

    function detectSweeps(bars, swings) {
      const sweeps = [];
      for (const sw of swings) {
        const after = bars.slice(sw.idx + 1, sw.idx + 5);
        if (sw.type === "low") {
          for (const b of after) {
            if (b.l < sw.price && b.c > sw.price) {
              sweeps.push({
                type: "bullSweep",
                price: sw.price,
                barIdx: bars.indexOf(b),
                swingIdx: sw.idx,
              });
              break;
            }
          }
        } else {
          for (const b of after) {
            if (b.h > sw.price && b.c < sw.price) {
              sweeps.push({
                type: "bearSweep",
                price: sw.price,
                barIdx: bars.indexOf(b),
                swingIdx: sw.idx,
              });
              break;
            }
          }
        }
      }
      return sweeps;
    }

    function analyze(bars, tfMinutes) {
      if (bars.length < 12) return null;
      const lb = tfMinutes >= 1440 ? 3 : 5;
      const swings = detectSwings(bars, lb);
      return {
        swings,
        structures: SMCConfig.get("showStructure")
          ? detectStructure(bars, swings)
          : [],
        orderBlocks: SMCConfig.get("showOrderBlocks")
          ? detectOrderBlocks(bars, structures)
          : [],
        fvgs: SMCConfig.get("showFVG") ? detectFVG(bars) : [],
        pd: SMCConfig.get("showPremiumDiscount")
          ? calcPremiumDiscount(swings)
          : null,
        equalLevels: SMCConfig.get("showEqualLevels")
          ? detectEqualLevels(swings)
          : [],
        sweeps: SMCConfig.get("showLiquiditySweeps")
          ? detectSweeps(bars, swings)
          : [],
        barCount: bars.length,
      };

      // Fix: structures needs to be in scope
      function structures() {
        return SMCConfig.get("showStructure")
          ? detectStructure(bars, swings)
          : [];
      }
    }

    // Corrected analyze that properly scopes structures
    function analyzeAll(bars, tfMinutes) {
      if (bars.length < 12) return null;
      const lb = tfMinutes >= 1440 ? 3 : 5;
      const swings = detectSwings(bars, lb);
      const structs = SMCConfig.get("showStructure")
        ? detectStructure(bars, swings)
        : [];
      const obs = SMCConfig.get("showOrderBlocks")
        ? detectOrderBlocks(bars, structs)
        : [];
      const fvgs = SMCConfig.get("showFVG") ? detectFVG(bars) : [];
      const pd = SMCConfig.get("showPremiumDiscount")
        ? calcPremiumDiscount(swings)
        : null;
      const eql = SMCConfig.get("showEqualLevels")
        ? detectEqualLevels(swings)
        : [];
      const sweeps = SMCConfig.get("showLiquiditySweeps")
        ? detectSweeps(bars, swings)
        : [];
      return {
        swings,
        structures: structs,
        orderBlocks: obs,
        fvgs,
        pd,
        equalLevels: eql,
        sweeps,
        barCount: bars.length,
      };
    }

    return { analyzeAll };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: Overlay — canvas management as SIBLING of chart-overlay
  // ═══════════════════════════════════════════════════════════════════════

  const Overlay = (() => {
    let _canvas = null;
    let _ctx = null;
    let _observer = null;

    /**
     * Create overlay canvas as a SIBLING of .chart-overlay in the .chart div.
     * CRITICAL: NOT a child of .chart-overlay — that breaks the WASM renderer.
     */
    function init() {
      if (_canvas) return true;

      const container = ChartInfo.getChartContainer();
      if (!container) return false;

      const dims = ChartInfo.getChartDimensions();
      if (!dims) return false;

      _canvas = document.createElement("canvas");
      _canvas.id = "smc-overlay";
      _canvas.width = dims.width;
      _canvas.height = dims.height;
      _canvas.style.cssText = `
        position: absolute;
        top: 0; left: 0;
        width: ${dims.cssWidth}px;
        height: ${dims.cssHeight}px;
        pointer-events: none;
        z-index: 5;
      `;

      // Insert AFTER .chart-overlay, not inside it
      container.appendChild(_canvas);
      _ctx = _canvas.getContext("2d");

      // Sync size when chart resizes
      _observer = new ResizeObserver(() => _syncSize());
      _observer.observe(container);

      return true;
    }

    function _syncSize() {
      const dims = ChartInfo.getChartDimensions();
      if (!dims || !_canvas) return;
      _canvas.width = dims.width;
      _canvas.height = dims.height;
      _canvas.style.width = dims.cssWidth + "px";
      _canvas.style.height = dims.cssHeight + "px";
    }

    function getCtx() {
      return _ctx;
    }
    function getCanvas() {
      return _canvas;
    }

    function clear() {
      if (_ctx && _canvas) _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    }

    function destroy() {
      if (_observer) _observer.disconnect();
      if (_canvas && _canvas.parentNode)
        _canvas.parentNode.removeChild(_canvas);
      _canvas = null;
      _ctx = null;
    }

    return { init, getCtx, getCanvas, clear, destroy };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: SMCRenderer — draw SMC markings on the overlay canvas
  // ═══════════════════════════════════════════════════════════════════════

  const SMCRenderer = (() => {
    /**
     * Map bar index → pixel X position and price → pixel Y position.
     *
     * We compute the mapping from the bar array and the canvas dimensions.
     * The chart displays the most recent bars on the right side.
     * We assume a right margin of ~56px (price axis) and 20px bottom (time axis).
     */
    function _buildMapping(bars, canvas) {
      const w = canvas.width;
      const h = canvas.height;
      const RIGHT_MARGIN = 56;
      const BOTTOM_MARGIN = 20;
      const chartW = w - RIGHT_MARGIN;
      const chartH = h - BOTTOM_MARGIN;

      if (bars.length === 0) return null;

      // Price range
      let minP = Infinity,
        maxP = -Infinity;
      for (const b of bars) {
        if (b.h > maxP) maxP = b.h;
        if (b.l < minP) minP = b.l;
      }
      const pRange = maxP - minP || 1;
      // Add 5% padding
      const paddedMin = minP - pRange * 0.05;
      const paddedMax = maxP + pRange * 0.05;
      const paddedRange = paddedMax - paddedMin;

      // Bar width: distribute bars evenly across chart width
      const barW = chartW / bars.length;

      return {
        barToX: (idx) => Math.round(idx * barW + barW / 2),
        priceToY: (price) =>
          Math.round(((paddedMax - price) / paddedRange) * chartH),
        chartW,
        chartH,
        barW,
      };
    }

    function render(ctx, canvas, bars, analysis) {
      if (!analysis || !bars || bars.length < 12) return;

      const m = _buildMapping(bars, canvas);
      if (!m) return;

      const cfg = SMCConfig.all();

      // Draw layers back to front
      if (cfg.showPremiumDiscount && analysis.pd) {
        _drawPD(ctx, m, analysis.pd);
      }
      if (cfg.showFVG) {
        _drawFVGs(ctx, m, analysis.fvgs, bars);
      }
      if (cfg.showOrderBlocks) {
        _drawOBs(ctx, m, analysis.orderBlocks, bars);
      }
      if (cfg.showEqualLevels) {
        _drawEQL(ctx, m, analysis.equalLevels, bars);
      }
      if (cfg.showStructure) {
        _drawStructure(ctx, m, analysis.structures, analysis.swings, bars);
      }
      if (cfg.showLiquiditySweeps) {
        _drawSweeps(ctx, m, analysis.sweeps, bars);
      }
    }

    function _drawPD(ctx, m, pd) {
      const topY = m.priceToY(pd.high);
      const eqY = m.priceToY(pd.equilibrium);
      const botY = m.priceToY(pd.low);

      ctx.fillStyle = "rgba(234,76,76,0.05)";
      ctx.fillRect(0, topY, m.chartW, eqY - topY);
      ctx.fillStyle = "rgba(54,179,75,0.05)";
      ctx.fillRect(0, eqY, m.chartW, botY - eqY);

      ctx.strokeStyle = "rgba(128,128,128,0.3)";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, eqY);
      ctx.lineTo(m.chartW, eqY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = "9px Trebuchet MS, sans-serif";
      ctx.fillStyle = "rgba(234,76,76,0.5)";
      ctx.fillText("PREMIUM", 6, topY + 12);
      ctx.fillStyle = "rgba(128,128,128,0.5)";
      ctx.fillText("EQ", 6, eqY - 3);
      ctx.fillStyle = "rgba(54,179,75,0.5)";
      ctx.fillText("DISCOUNT", 6, botY - 5);
    }

    function _drawFVGs(ctx, m, fvgs, bars) {
      for (const f of fvgs) {
        const topY = m.priceToY(f.top);
        const botY = m.priceToY(f.bottom);
        const x = m.barToX(f.idx);

        ctx.fillStyle =
          f.type === "bull" ? "rgba(54,179,75,0.08)" : "rgba(234,76,76,0.08)";
        ctx.fillRect(x, topY, m.chartW - x, botY - topY);

        ctx.strokeStyle =
          f.type === "bull" ? "rgba(54,179,75,0.2)" : "rgba(234,76,76,0.2)";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x, topY, m.chartW - x, botY - topY);

        ctx.font = "8px Trebuchet MS, sans-serif";
        ctx.fillStyle =
          f.type === "bull" ? "rgba(54,179,75,0.5)" : "rgba(234,76,76,0.5)";
        ctx.fillText("FVG", x + 2, topY + 9);
      }
    }

    function _drawOBs(ctx, m, obs, bars) {
      for (const ob of obs) {
        const topY = m.priceToY(ob.top);
        const botY = m.priceToY(ob.bottom);
        const x = m.barToX(ob.idx);

        ctx.fillStyle =
          ob.type === "bull" ? "rgba(54,179,75,0.1)" : "rgba(234,76,76,0.1)";
        ctx.fillRect(x, topY, m.chartW - x, botY - topY);

        ctx.fillStyle =
          ob.type === "bull" ? "rgba(54,179,75,0.7)" : "rgba(234,76,76,0.7)";
        ctx.fillRect(x, topY, 3, botY - topY);

        ctx.strokeStyle =
          ob.type === "bull" ? "rgba(54,179,75,0.25)" : "rgba(234,76,76,0.25)";
        ctx.lineWidth = 0.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, topY);
        ctx.lineTo(m.chartW, topY);
        ctx.moveTo(x, botY);
        ctx.lineTo(m.chartW, botY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = "bold 10px Trebuchet MS, sans-serif";
        ctx.fillStyle =
          ob.type === "bull" ? "rgba(54,179,75,0.8)" : "rgba(234,76,76,0.8)";
        ctx.fillText("OB", x + 6, topY + 12);
      }
    }

    function _drawEQL(ctx, m, equals, bars) {
      for (const eq of equals) {
        const y = m.priceToY(eq.price);
        const x1 = m.barToX(eq.idx1);
        const x2 = m.barToX(eq.idx2);

        ctx.strokeStyle =
          eq.type === "EQH" ? "rgba(234,76,76,0.4)" : "rgba(54,179,75,0.4)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(m.chartW, y);
        ctx.stroke();
        ctx.setLineDash([]);

        [x1, x2].forEach((x) => {
          ctx.fillStyle =
            eq.type === "EQH" ? "rgba(234,76,76,0.6)" : "rgba(54,179,75,0.6)";
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        });

        ctx.font = "8px Trebuchet MS, sans-serif";
        ctx.fillStyle =
          eq.type === "EQH" ? "rgba(234,76,76,0.6)" : "rgba(54,179,75,0.6)";
        ctx.fillText(eq.type, x2 + 6, y - 3);
      }
    }

    function _drawStructure(ctx, m, structures, swings, bars) {
      // Swing point diamonds
      for (const sw of swings) {
        const x = m.barToX(sw.idx);
        const y = m.priceToY(sw.price);
        const isH = sw.type === "high";

        ctx.fillStyle = isH ? "rgba(234,76,76,0.5)" : "rgba(54,179,75,0.5)";
        ctx.beginPath();
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x + 3, y);
        ctx.lineTo(x, y + 4);
        ctx.lineTo(x - 3, y);
        ctx.closePath();
        ctx.fill();
      }

      // BOS / CHoCH labels + lines
      for (const s of structures) {
        const y = m.priceToY(s.price);
        const x1 = m.barToX(s.fromIdx);
        const x2 = m.barToX(s.toIdx);
        const isBull = s.dir === "bull";

        ctx.strokeStyle = isBull
          ? "rgba(54,179,75,0.45)"
          : "rgba(234,76,76,0.45)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label
        const label = s.type;
        ctx.font = "bold 10px Trebuchet MS, sans-serif";
        const tw = ctx.measureText(label).width;
        const lx = (x1 + x2) / 2 - tw / 2 - 4;
        const ly = isBull ? y - 14 : y + 3;

        ctx.fillStyle =
          s.type === "CHoCH"
            ? isBull
              ? "rgba(54,179,75,0.2)"
              : "rgba(234,76,76,0.2)"
            : isBull
              ? "rgba(54,179,75,0.1)"
              : "rgba(234,76,76,0.1)";
        ctx.fillRect(lx, ly, tw + 8, 14);

        ctx.strokeStyle = isBull
          ? "rgba(54,179,75,0.35)"
          : "rgba(234,76,76,0.35)";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(lx, ly, tw + 8, 14);

        ctx.fillStyle = isBull
          ? "rgba(54,179,75,0.85)"
          : "rgba(234,76,76,0.85)";
        ctx.fillText(label, lx + 4, ly + 11);
      }
    }

    function _drawSweeps(ctx, m, sweeps, bars) {
      for (const sw of sweeps) {
        const y = m.priceToY(sw.price);
        const x = m.barToX(sw.barIdx);
        const up = sw.type === "bullSweep";

        ctx.fillStyle = up ? "rgba(54,179,75,0.75)" : "rgba(234,76,76,0.75)";
        const tipY = up ? y - 12 : y + 12;
        const d = up ? 1 : -1;

        ctx.beginPath();
        ctx.moveTo(x, tipY);
        ctx.lineTo(x - 4, tipY + d * 7);
        ctx.lineTo(x - 1.5, tipY + d * 7);
        ctx.lineTo(x - 1.5, tipY + d * 14);
        ctx.lineTo(x + 1.5, tipY + d * 14);
        ctx.lineTo(x + 1.5, tipY + d * 7);
        ctx.lineTo(x + 4, tipY + d * 7);
        ctx.closePath();
        ctx.fill();

        ctx.font = "8px Trebuchet MS, sans-serif";
        ctx.fillText("SWEEP", x + 7, tipY + 4);
      }
    }

    return { render };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: SMCPanel — settings toggle UI
  // ═══════════════════════════════════════════════════════════════════════

  const SMCPanel = (() => {
    let panelEl,
      btnEl,
      isOpen = false;

    function build() {
      const style = document.createElement("style");
      style.id = "smc-panel-styles";
      style.textContent = `
        #smc-btn {
          position:fixed; top:10px; right:260px; z-index:999998;
          font-family:'Trebuchet MS',sans-serif;
          background:var(--color-card,#262f3f);
          border:1px solid var(--color-border,#2b3543);
          border-radius:20px; padding:5px 14px;
          color:var(--color-text-blue,#4597ff);
          font-size:12px; font-weight:600; letter-spacing:.5px;
          cursor:pointer; user-select:none;
          box-shadow:0 2px 12px rgba(0,0,0,.4);
          transition:border-color .2s,box-shadow .2s;
          display:flex; align-items:center; gap:6px;
        }
        #smc-btn:hover{border-color:var(--color-text-blue,#4597ff);box-shadow:0 4px 18px rgba(69,151,255,.25)}
        #smc-btn .dot{width:7px;height:7px;border-radius:50%;background:var(--color-fill-green,#36b34b)}
        #smc-btn .dot.off{background:var(--color-icon-disabled,#647181)}

        #smc-panel{
          position:fixed;top:46px;right:260px;z-index:999997;width:250px;
          background:var(--color-background,#0f1720);
          border:1px solid var(--color-border,#2b3543);border-radius:12px;
          box-shadow:0 16px 46px rgba(0,0,0,.55);
          font-family:'Trebuchet MS',sans-serif;
          opacity:0;pointer-events:none;transform:translateY(-6px);
          transition:opacity .18s,transform .18s;overflow:hidden;
        }
        #smc-panel.open{opacity:1;pointer-events:all;transform:translateY(0)}

        .smc-hdr{padding:12px 14px 8px;border-bottom:1px solid var(--color-border,#2b3543);display:flex;justify-content:space-between;align-items:center}
        .smc-hdr-t{color:var(--color-text-default,#fff);font-size:14px;font-weight:600}
        .smc-hdr-v{color:var(--color-text-blue,#4597ff);font-size:10px}
        .smc-bd{padding:8px 14px 14px}
        .smc-r{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(43,53,67,.4)}
        .smc-r:last-child{border-bottom:none}
        .smc-rl{color:var(--color-text-secondary,#8fa2b8);font-size:13px}
        .smc-sw{position:relative;width:36px;height:20px;background:var(--color-border,#2b3543);border-radius:10px;cursor:pointer;transition:background .2s;flex-shrink:0}
        .smc-sw.on{background:var(--color-fill-blue,#3183ff)}
        .smc-sw::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .2s}
        .smc-sw.on::after{transform:translateX(16px)}
        .smc-info{margin-top:8px;padding:8px;background:var(--color-card,#262f3f);border-radius:6px;font-size:10px;color:var(--color-text-secondary,#8fa2b8);line-height:1.5}
        .smc-info b{color:var(--color-text-blue,#4597ff)}
      `;
      document.head.appendChild(style);

      btnEl = document.createElement("div");
      btnEl.id = "smc-btn";
      btnEl.innerHTML = `<div class="dot ${SMCConfig.get("enabled") ? "" : "off"}"></div><span>SMC</span>`;
      btnEl.addEventListener("click", () => {
        isOpen = !isOpen;
        panelEl.classList.toggle("open", isOpen);
      });

      const features = [
        ["enabled", "Enabled"],
        ["showStructure", "BOS / CHoCH"],
        ["showOrderBlocks", "Order Blocks"],
        ["showFVG", "Fair Value Gaps"],
        ["showPremiumDiscount", "Premium / Discount"],
        ["showEqualLevels", "Equal Highs / Lows"],
        ["showLiquiditySweeps", "Liquidity Sweeps"],
      ];

      panelEl = document.createElement("div");
      panelEl.id = "smc-panel";
      panelEl.innerHTML = `
        <div class="smc-hdr">
          <span class="smc-hdr-t">Smart Money Concepts</span>
          <span class="smc-hdr-v">v${SMC_VERSION}</span>
        </div>
        <div class="smc-bd">
          ${features
            .map(
              ([k, l]) => `
            <div class="smc-r">
              <span class="smc-rl">${l}</span>
              <div class="smc-sw ${SMCConfig.get(k) ? "on" : ""}" data-key="${k}"></div>
            </div>`,
            )
            .join("")}
          <div class="smc-info" id="smc-stats">Collecting data...</div>
        </div>
      `;

      panelEl.querySelectorAll(".smc-sw").forEach((sw) => {
        sw.addEventListener("click", () => {
          const k = sw.dataset.key;
          const v = SMCConfig.toggle(k);
          sw.classList.toggle("on", v);
          if (k === "enabled")
            btnEl.querySelector(".dot").classList.toggle("off", !v);
        });
      });

      document.addEventListener("click", (e) => {
        if (
          isOpen &&
          !panelEl.contains(e.target) &&
          !btnEl.contains(e.target)
        ) {
          isOpen = false;
          panelEl.classList.remove("open");
        }
      });

      document.body.appendChild(btnEl);
      document.body.appendChild(panelEl);
    }

    function updateStats(barCount, analysis) {
      const el = document.getElementById("smc-stats");
      if (!el) return;
      if (!analysis) {
        el.innerHTML = `<b>${barCount}</b> bars collected (need 12+)`;
        return;
      }
      el.innerHTML = `<b>${barCount}</b> bars · <b>${analysis.swings.length}</b> swings · <b>${analysis.structures.length}</b> BOS/CHoCH · <b>${analysis.orderBlocks.length}</b> OB · <b>${analysis.fvgs.length}</b> FVG`;
    }

    return { build, updateStats };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: PricePoller — read prices from market watch DOM at interval
  // ═══════════════════════════════════════════════════════════════════════

  const PricePoller = (() => {
    let _timer = null;

    function start() {
      if (_timer) return;
      _timer = setInterval(_poll, 1000);
    }

    function stop() {
      if (_timer) {
        clearInterval(_timer);
        _timer = null;
      }
    }

    function _poll() {
      const info = ChartInfo.parseTitle();
      if (!info.symbol) return;

      const price = ChartInfo.getCurrentPrice(info.symbol);
      if (price) {
        BarStore.tick(info.symbol, price, info.tfMinutes);
      }
    }

    return { start, stop };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  MODULE: App — boot and main render loop
  // ═══════════════════════════════════════════════════════════════════════

  const App = (() => {
    let _renderTimer = null;

    function boot() {
      // Wait for DOM to be ready
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _init);
      } else {
        // If DOM is already loaded, wait for the chart to render
        setTimeout(_init, 6000);
      }
    }

    function _init() {
      // Wait for chart elements to exist
      const check = setInterval(() => {
        if (document.querySelector(".chart-overlay canvas")) {
          clearInterval(check);
          _start();
        }
      }, 1000);
    }

    function _start() {
      SMCConfig.load();

      // Build UI
      SMCPanel.build();

      // Start polling prices from market watch
      PricePoller.start();

      // Start render loop
      _renderTimer = setInterval(_renderTick, SMCConfig.get("refreshMs"));

      console.log(
        `[SMC] v${SMC_VERSION} booted — polling prices from market watch`,
      );
    }

    function _renderTick() {
      if (!SMCConfig.get("enabled")) {
        Overlay.clear();
        return;
      }

      const info = ChartInfo.parseTitle();
      if (!info.symbol) return;

      const bars = BarStore.getBars(info.symbol);
      const barCount = bars.length;

      // Init overlay if needed (lazy, non-invasive)
      if (!Overlay.init()) return;

      if (barCount < 12) {
        SMCPanel.updateStats(barCount, null);
        Overlay.clear();
        return;
      }

      try {
        const analysis = SMCEngine.analyzeAll(bars, info.tfMinutes);
        Overlay.clear();
        if (analysis) {
          SMCRenderer.render(
            Overlay.getCtx(),
            Overlay.getCanvas(),
            bars,
            analysis,
          );
        }
        SMCPanel.updateStats(barCount, analysis);
      } catch (e) {
        console.warn("[SMC] render error:", e);
      }
    }

    return { boot };
  })();

  // ── GO ──────────────────────────────────────────────────────────────
  App.boot();
})();
