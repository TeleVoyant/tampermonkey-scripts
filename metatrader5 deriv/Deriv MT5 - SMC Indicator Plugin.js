// ==UserScript==
// @name         Deriv MT5 — SMC Indicator Plugin
// @namespace    http://mt5-real01-web-svg.deriv.com/
// @icon         https://play-lh.googleusercontent.com/65e0HntWSHuxvon8vp-Vai1gOMXQxBr0YhqDcZkAg9ligsqkJNuPnJgmbMcWii3TsA=w240-h480
// @version      1.0
// @description  Smart Money Concepts overlay: Market Structure (BOS/CHoCH), Order Blocks, Fair Value Gaps, Premium/Discount zones, Equal Highs/Lows, Liquidity Sweeps. Extracts OHLC from WASM-rendered canvas via pixel analysis.
// @author       github.com/TeleVoyant
// @match        http://mt5-real01-web-svg.deriv.com/*
// @match        https://mt5-real01-web-svg.deriv.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

/**
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  SMC Indicator Plugin  v1.0  — Smart Money Concepts                   │
 * │                                                                       │
 * │  Architecture:                                                        │
 * │    CanvasExtractor  — pixel-scan OHLC from WASM-rendered chart        │
 * │    PriceAxis        — parse price scale from right-side axis labels   │
 * │    TimeAxis         — parse timeframe from chart title                │
 * │    SMCEngine        — core algorithms:                                │
 * │       • SwingDetector     — swing HH/HL/LH/LL                         │
 * │       • StructureLabeler  — BOS / CHoCH                               │
 * │       • OrderBlocks       — bullish/bearish OB detection              │
 * │       • FairValueGaps     — imbalance zones (FVG)                     │
 * │       • PremiumDiscount   — equilibrium + zones                       │
 * │       • EqualLevels       — equal highs / equal lows                  │
 * │       • LiquiditySweeps   — stop-hunt detection                       │
 * │    SMCRenderer      — draw all markings on overlay canvas             │
 * │    SMCPanel         — settings UI (toggle features, adjust params)    │
 * │    SMCPlugin        — ChartOverlay plugin interface                   │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * DATA EXTRACTION STRATEGY:
 * The MT5 Web Terminal renders its chart via a C++/WASM engine. No JS-accessible
 * OHLC data store exists. We extract candle data by:
 *   1. Reading the chart canvas pixels via getImageData()
 *   2. Detecting candlestick body boundaries by color (green=bullish, red=bearish)
 *   3. Detecting wick lines for High/Low
 *   4. Reading the price axis (right margin) to build a pixel-Y → price mapping
 *   5. Reading chart title for symbol + timeframe
 *
 * The extraction runs on a configurable interval (default 2s) and feeds the
 * SMC algorithms, whose output is drawn on the transparent overlay canvas.
 */

(function () {
  "use strict";

  if (window.location.hostname !== "mt5-real01-web-svg.deriv.com") return;

  // ═══════════════════════════════════════════════════════════════════════
  //  CONSTANTS
  // ═══════════════════════════════════════════════════════════════════════

  const SMC_VERSION = "1.0";
  const STORAGE_KEY = "smc_config_v1";

  // Timeframe → minutes mapping (matches MT5 internal period values)
  const TF_MAP = {
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

  // Adaptive swing lookback per timeframe category
  const SWING_LOOKBACK = {
    scalp: 5, // M1, M5
    intra: 5, // M15, M30
    swing: 5, // H1, H4
    pos: 3, // D1, W1, MN
  };

  function getTFCategory(tfMinutes) {
    if (tfMinutes <= 5) return "scalp";
    if (tfMinutes <= 30) return "intra";
    if (tfMinutes <= 240) return "swing";
    return "pos";
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  CONFIG
  // ═══════════════════════════════════════════════════════════════════════

  const SMCConfig = (() => {
    const DEFAULTS = {
      enabled: true,
      scanIntervalMs: 2000,
      swingLookback: 5,

      // Feature toggles
      showStructure: true, // BOS / CHoCH labels
      showOrderBlocks: true, // OB zones
      showFVG: true, // Fair Value Gaps
      showPremiumDiscount: true, // Premium/Discount zones
      showEqualLevels: true, // Equal highs/lows
      showLiquiditySweeps: true, // Liquidity sweep markers

      // Visual
      obMaxDisplay: 5, // Max order blocks to display
      fvgMinSize: 0.0003, // Min FVG size as fraction of price
      equalLevelTolerance: 0.0005, // Tolerance for "equal" detection

      // Colors (will be derived from theme but these are defaults)
      bullColor: "rgba(54, 179, 75, 0.85)",
      bearColor: "rgba(234, 76, 76, 0.85)",
      bullBg: "rgba(54, 179, 75, 0.12)",
      bearBg: "rgba(234, 76, 76, 0.12)",
      fvgBullBg: "rgba(54, 179, 75, 0.08)",
      fvgBearBg: "rgba(234, 76, 76, 0.08)",
      pdPremiumBg: "rgba(234, 76, 76, 0.06)",
      pdDiscountBg: "rgba(54, 179, 75, 0.06)",
      pdEqLine: "rgba(128, 128, 128, 0.4)",
      labelFont: "bold 10px Trebuchet MS, sans-serif",
      zoneFont: "9px Trebuchet MS, sans-serif",
    };

    let _cfg = { ...DEFAULTS };

    function load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) _cfg = { ...DEFAULTS, ...JSON.parse(raw) };
      } catch {
        /* ignore */
      }
    }

    function save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(_cfg));
      } catch {
        /* */
      }
    }

    function get(k) {
      return _cfg[k];
    }

    function set(k, v) {
      if (k in DEFAULTS) {
        _cfg[k] = v;
        save();
        return true;
      }
      return false;
    }

    function toggle(k) {
      if (typeof _cfg[k] === "boolean") {
        _cfg[k] = !_cfg[k];
        save();
        return _cfg[k];
      }
      return null;
    }

    function all() {
      return { ..._cfg };
    }

    return { load, save, get, set, toggle, all, DEFAULTS };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  CANVAS EXTRACTOR — read OHLC from WASM-rendered chart pixels
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extracts candlestick OHLC data from the chart canvas by analyzing pixel colors.
   *
   * MT5 Web Terminal default candlestick colors (dark theme):
   *   Bullish body: white (#FFFFFF or near-white)
   *   Bearish body: filled with background or specific color
   *   Wicks: thin vertical lines (1-2px wide)
   *
   * The chart has:
   *   - Right margin (~56px) for price axis labels
   *   - Bottom margin for time axis labels
   *   - Top area for chart title info
   *
   * We scan vertical columns to find candle positions, then extract body/wick bounds.
   */
  const CanvasExtractor = (() => {
    // Chart area margins (estimated from HTML inspection)
    const RIGHT_MARGIN = 56;
    const BOTTOM_MARGIN = 20;
    const TOP_MARGIN = 0;

    /**
     * Extract price axis mapping from the chart canvas.
     * The right margin contains price labels rendered as text.
     * We scan the price axis area to find labeled price levels.
     *
     * Returns { topPrice, bottomPrice, chartTop, chartBottom }
     * representing the price range visible on the chart.
     */
    function extractPriceAxis(canvas) {
      // We read the chart-info element for price range hints
      // The price axis labels are rendered ON the canvas by WASM
      // We need to detect them from pixel patterns

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;

      const w = canvas.width;
      const h = canvas.height;

      // The chart area is w - RIGHT_MARGIN wide, h - BOTTOM_MARGIN tall
      const chartRight = w - RIGHT_MARGIN;
      const chartBottom = h - BOTTOM_MARGIN;

      // Scan the price axis column (right margin) for text pixels
      // Price labels are rendered in a specific color (the chart text color)
      // In dark mode: typically white/light gray text
      // We look for horizontal clusters of non-background pixels

      const axisX = chartRight + 5; // A few px into the axis area
      const axisData = ctx.getImageData(
        chartRight,
        0,
        RIGHT_MARGIN,
        chartBottom,
      );

      // Find rows that have text (non-background pixels in the axis area)
      const textRows = [];
      const bgColor = _getBackgroundColor(canvas);

      for (let y = 10; y < chartBottom - 10; y++) {
        let textPixels = 0;
        for (let x = 2; x < RIGHT_MARGIN - 2; x++) {
          const idx = (y * RIGHT_MARGIN + x) * 4;
          const r = axisData.data[idx];
          const g = axisData.data[idx + 1];
          const b = axisData.data[idx + 2];
          // Check if pixel is text (significantly different from background)
          if (_isTextPixel(r, g, b, bgColor)) {
            textPixels++;
          }
        }
        if (textPixels > 3) {
          textRows.push(y);
        }
      }

      // Group adjacent text rows into label positions (each label is ~10-12px tall)
      const labelPositions = _groupAdjacentRows(textRows, 3);

      // We know the price labels are evenly spaced on the Y axis
      // The top label = highest visible price, bottom label = lowest
      // We can't OCR the actual values, but we can infer from the chart

      return {
        chartLeft: 0,
        chartRight,
        chartTop: TOP_MARGIN,
        chartBottom,
        labelYPositions: labelPositions,
        labelCount: labelPositions.length,
      };
    }

    function _getBackgroundColor(canvas) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      // Sample a pixel from the middle of the chart background
      const data = ctx.getImageData(10, 10, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2] };
    }

    function _isTextPixel(r, g, b, bg) {
      const dr = Math.abs(r - bg.r);
      const dg = Math.abs(g - bg.g);
      const db = Math.abs(b - bg.b);
      return dr + dg + db > 80; // Significant color difference
    }

    function _groupAdjacentRows(rows, gap) {
      if (rows.length === 0) return [];
      const groups = [];
      let start = rows[0];
      let end = rows[0];
      for (let i = 1; i < rows.length; i++) {
        if (rows[i] - end <= gap) {
          end = rows[i];
        } else {
          groups.push(Math.floor((start + end) / 2));
          start = rows[i];
          end = rows[i];
        }
      }
      groups.push(Math.floor((start + end) / 2));
      return groups;
    }

    /**
     * Scan the chart canvas to extract candlestick positions and body boundaries.
     *
     * Strategy:
     *  1. Scan each X column in the chart area
     *  2. For each column, analyze the vertical pixel pattern
     *  3. Detect candle bodies (wide colored blocks) and wicks (thin lines)
     *  4. Group columns into individual candles
     *
     * Returns: Array of { x, bodyTop, bodyBottom, wickHigh, wickLow, bullish }
     */
    function extractCandles(canvas) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return [];

      const w = canvas.width;
      const h = canvas.height;
      const chartRight = w - RIGHT_MARGIN;
      const chartBottom = h - BOTTOM_MARGIN;
      const chartHeight = chartBottom - TOP_MARGIN;

      // Get full chart area image data
      const imgData = ctx.getImageData(0, TOP_MARGIN, chartRight, chartHeight);
      const bg = _getBackgroundColor(canvas);

      // Detect which colors represent bullish and bearish candles
      // MT5 dark theme: bullish = white/light body, bearish = dark filled or specific color
      // We detect by scanning for the most common non-background, non-grid colors

      const columns = []; // { x, segments: [{ top, bottom, color }] }

      // Scan every column to find vertical colored segments
      for (let x = 5; x < chartRight - 5; x++) {
        const segs = _scanColumn(imgData, x, chartHeight, chartRight, bg);
        if (segs.length > 0) {
          columns.push({ x, segments: segs });
        }
      }

      // Group adjacent columns with similar segment patterns into candles
      const candles = _groupColumnsIntoCandles(columns, chartHeight);

      return candles;
    }

    /**
     * Scan a single column for colored segments (non-background, non-grid pixels).
     */
    function _scanColumn(imgData, x, height, width, bg) {
      const segments = [];
      let inSegment = false;
      let segStart = 0;
      let segColorSum = { r: 0, g: 0, b: 0, count: 0 };

      for (let y = 0; y < height; y++) {
        const idx = (y * width + x) * 4;
        const r = imgData.data[idx];
        const g = imgData.data[idx + 1];
        const b = imgData.data[idx + 2];
        const a = imgData.data[idx + 3];

        const isCandle = _isCandlePixel(r, g, b, bg);

        if (isCandle && !inSegment) {
          inSegment = true;
          segStart = y;
          segColorSum = { r, g, b, count: 1 };
        } else if (isCandle && inSegment) {
          segColorSum.r += r;
          segColorSum.g += g;
          segColorSum.b += b;
          segColorSum.count++;
        } else if (!isCandle && inSegment) {
          inSegment = false;
          const len = y - segStart;
          if (len >= 1) {
            segments.push({
              top: segStart,
              bottom: y - 1,
              length: len,
              avgColor: {
                r: Math.round(segColorSum.r / segColorSum.count),
                g: Math.round(segColorSum.g / segColorSum.count),
                b: Math.round(segColorSum.b / segColorSum.count),
              },
            });
          }
        }
      }

      if (inSegment) {
        segments.push({
          top: segStart,
          bottom: height - 1,
          length: height - segStart,
          avgColor: {
            r: Math.round(segColorSum.r / segColorSum.count),
            g: Math.round(segColorSum.g / segColorSum.count),
            b: Math.round(segColorSum.b / segColorSum.count),
          },
        });
      }

      return segments;
    }

    /**
     * Determine if a pixel belongs to a candlestick (not background, not grid line).
     */
    function _isCandlePixel(r, g, b, bg) {
      // Background difference
      const dr = Math.abs(r - bg.r);
      const dg = Math.abs(g - bg.g);
      const db = Math.abs(b - bg.b);
      const totalDiff = dr + dg + db;

      if (totalDiff < 30) return false; // Too close to background

      // Filter out grid lines (typically gray/subtle)
      const gray =
        Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && totalDiff < 60;
      if (gray) return false;

      // Filter out price level lines (dashed, typically one color)
      // These are typically very thin (1px) horizontal lines spanning the full width

      return true;
    }

    /**
     * Classify a candle color as bullish or bearish.
     * MT5 dark theme: bullish bodies are lighter, bearish are darker/redder.
     */
    function _classifyColor(avgColor, bg) {
      const brightness = (avgColor.r + avgColor.g + avgColor.b) / 3;
      const bgBrightness = (bg.r + bg.g + bg.b) / 3;

      // Check if it's reddish (bearish)
      if (avgColor.r > avgColor.g + 30 && avgColor.r > avgColor.b + 30) {
        return "bear";
      }
      // Check if it's greenish (bullish in some themes)
      if (avgColor.g > avgColor.r + 30 && avgColor.g > avgColor.b + 20) {
        return "bull";
      }
      // White/light = bullish body outline, dark = bearish fill
      if (brightness > bgBrightness + 40) {
        return "bull";
      }
      return "bear";
    }

    /**
     * Group adjacent column scans into discrete candle objects.
     */
    function _groupColumnsIntoCandles(columns, chartHeight) {
      if (columns.length === 0) return [];

      const candles = [];
      let currentGroup = [columns[0]];

      for (let i = 1; i < columns.length; i++) {
        const prev = columns[i - 1];
        const curr = columns[i];

        // Adjacent columns (gap <= 1) with similar segments belong to same candle
        if (
          curr.x - prev.x <= 2 &&
          _segmentsSimilar(prev.segments, curr.segments)
        ) {
          currentGroup.push(curr);
        } else {
          if (currentGroup.length >= 1) {
            const candle = _resolveCandle(currentGroup, chartHeight);
            if (candle) candles.push(candle);
          }
          currentGroup = [curr];
        }
      }

      if (currentGroup.length >= 1) {
        const candle = _resolveCandle(currentGroup, chartHeight);
        if (candle) candles.push(candle);
      }

      return candles;
    }

    function _segmentsSimilar(a, b) {
      if (a.length === 0 || b.length === 0) return false;
      // Compare the dominant segment
      const aDom = a.reduce((p, c) => (c.length > p.length ? c : p), a[0]);
      const bDom = b.reduce((p, c) => (c.length > p.length ? c : p), b[0]);
      return (
        Math.abs(aDom.top - bDom.top) < 5 &&
        Math.abs(aDom.bottom - bDom.bottom) < 5
      );
    }

    function _resolveCandle(group, chartHeight) {
      // Find the widest segment pattern — that's the body
      // The thinnest (1-2 col wide) segments are wicks

      const xCenter = Math.floor((group[0].x + group[group.length - 1].x) / 2);
      const width = group.length;

      // Aggregate all segments across columns
      let minTop = chartHeight;
      let maxBottom = 0;
      let bodyTop = chartHeight;
      let bodyBottom = 0;

      // The body is the segment that appears in the most columns
      // Wicks are segments that only appear in 1-2 columns (the center ones)

      for (const col of group) {
        for (const seg of col.segments) {
          if (seg.top < minTop) minTop = seg.top;
          if (seg.bottom > maxBottom) maxBottom = seg.bottom;

          // Body: the thickest segment (appears across most columns)
          if (seg.length > 2) {
            if (seg.top < bodyTop) bodyTop = seg.top;
            if (seg.bottom > bodyBottom) bodyBottom = seg.bottom;
          }
        }
      }

      if (bodyTop >= bodyBottom) {
        bodyTop = minTop;
        bodyBottom = maxBottom;
      }

      // Determine bull/bear from the dominant color of the body
      const midCol = group[Math.floor(group.length / 2)];
      const bodySegs = midCol.segments.filter((s) => s.length > 2);
      const mainSeg = bodySegs.length > 0 ? bodySegs[0] : midCol.segments[0];
      if (!mainSeg) return null;

      return {
        x: xCenter,
        width,
        wickHigh: minTop, // Pixel Y (top = high price, remember Y is inverted)
        wickLow: maxBottom, // Pixel Y (bottom = low price)
        bodyTop, // Body top pixel Y
        bodyBottom, // Body bottom pixel Y
        bullish:
          mainSeg.avgColor.g > mainSeg.avgColor.r || // green-ish
          (mainSeg.avgColor.r > 200 &&
            mainSeg.avgColor.g > 200 &&
            mainSeg.avgColor.b > 200), // white
        color: mainSeg.avgColor,
      };
    }

    return { extractCandles, extractPriceAxis };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  CHART INFO — parse symbol, timeframe, and price mapping from DOM
  // ═══════════════════════════════════════════════════════════════════════

  const ChartInfo = (() => {
    /**
     * Parse the chart title to extract symbol and timeframe.
     * Title format: "XAUUSD, H1:  Gold vs US Dollar"
     * Located in .title div inside .chart-info
     */
    function parseTitle() {
      const titleEl = document.querySelector(".chart-info .title");
      if (!titleEl) return { symbol: "Unknown", tf: "H1", tfMinutes: 60 };

      const text = titleEl.textContent || "";
      // Extract "SYMBOL, TF:" pattern
      const match = text.match(
        /([A-Za-z0-9.]+),\s*(M1|M5|M15|M30|H1|H4|D1|W1|MN)\s*:/,
      );
      if (match) {
        const symbol = match[1];
        const tf = match[2];
        return { symbol, tf, tfMinutes: TF_MAP[tf] || 60 };
      }

      return { symbol: "Unknown", tf: "H1", tfMinutes: 60 };
    }

    /**
     * Build a price mapping function from the chart canvas.
     * Since we can't OCR the actual price labels from the WASM canvas,
     * we use the market watch table to get the current price and the
     * chart's pixel dimensions to create an approximate mapping.
     *
     * Returns a mapping object { priceToY, yToPrice, priceRange }
     */
    function buildPriceMapping(canvas) {
      const symbol = parseTitle().symbol;

      // Get current bid/ask from the market watch table
      const currentPrice = _getCurrentPrice(symbol);
      if (!currentPrice) return null;

      const h = canvas.height;
      const chartBottom = h - 20; // Bottom margin
      const chartHeight = chartBottom;

      // The current price is typically near the right edge of the chart
      // We need to estimate the visible price range
      // Use the canvas height and a price-per-pixel estimate

      // Scan the right price axis for label positions
      const axisInfo = CanvasExtractor.extractPriceAxis(canvas);
      if (!axisInfo || axisInfo.labelCount < 2) return null;

      // The labels are evenly spaced in price
      // If we can detect N labels spanning M pixels, each label interval
      // represents the same price increment.
      // We'll estimate the price range based on the chart height and
      // typical price-per-pixel for this symbol.

      // For now, use a heuristic: the visible range is ~2% of current price
      // for H1, scaled by timeframe
      const tfInfo = parseTitle();
      const rangeFactor = _getRangeFactor(tfInfo.tfMinutes, symbol);
      const visibleRange = currentPrice * rangeFactor;

      const topPrice = currentPrice + visibleRange / 2;
      const bottomPrice = currentPrice - visibleRange / 2;

      const pixelsPerPrice = chartHeight / visibleRange;

      return {
        topPrice,
        bottomPrice,
        chartHeight,
        pixelsPerPrice,
        priceToY: (price) => Math.round((topPrice - price) * pixelsPerPrice),
        yToPrice: (y) => topPrice - y / pixelsPerPrice,
        currentPrice,
      };
    }

    /**
     * Get current price from market watch table.
     * Uses [title] attribute on table cells — stable selectors.
     */
    function _getCurrentPrice(symbol) {
      const rows = document.querySelectorAll(".market-watch tr.item");
      for (const row of rows) {
        const nameCell = row.querySelector("td:first-child");
        if (!nameCell) continue;
        const rowSymbol = (
          nameCell.getAttribute("title") ||
          nameCell.textContent ||
          ""
        ).trim();
        if (rowSymbol === symbol || rowSymbol.includes(symbol)) {
          // Get bid price (2nd column)
          const bidCell = row.querySelector("td:nth-child(2) .price");
          if (bidCell) {
            const price = parseFloat(bidCell.textContent.replace(/\s/g, ""));
            if (!isNaN(price)) return price;
          }
        }
      }
      return null;
    }

    function _getRangeFactor(tfMinutes, symbol) {
      // Estimate the visible price range as a fraction of current price
      // based on timeframe and symbol volatility
      const base = symbol.includes("XAU")
        ? 0.015
        : symbol.includes("BTC")
          ? 0.05
          : symbol.includes("Vol") ||
              symbol.includes("Jump") ||
              symbol.includes("Boom") ||
              symbol.includes("Crash")
            ? 0.03
            : 0.005; // Forex

      // Scale by timeframe
      if (tfMinutes <= 5) return base * 0.3;
      if (tfMinutes <= 30) return base * 0.6;
      if (tfMinutes <= 60) return base;
      if (tfMinutes <= 240) return base * 2;
      if (tfMinutes <= 1440) return base * 4;
      return base * 8;
    }

    return { parseTitle, buildPriceMapping };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  SMC ENGINE — Smart Money Concepts algorithms
  // ═══════════════════════════════════════════════════════════════════════

  const SMCEngine = (() => {
    /**
     * Convert pixel-space candles to normalized OHLC bars.
     * @param {Array} rawCandles  From CanvasExtractor
     * @param {Object} priceMap   From ChartInfo.buildPriceMapping
     * @returns {Array<{idx, x, open, high, low, close, bullish}>}
     */
    function normalizeCandles(rawCandles, priceMap) {
      if (!rawCandles || !priceMap) return [];

      return rawCandles.map((c, i) => {
        const high = priceMap.yToPrice(c.wickHigh);
        const low = priceMap.yToPrice(c.wickLow);

        let open, close;
        if (c.bullish) {
          // Bullish: close > open, body top = close, body bottom = open
          close = priceMap.yToPrice(c.bodyTop);
          open = priceMap.yToPrice(c.bodyBottom);
        } else {
          // Bearish: open > close, body top = open, body bottom = close
          open = priceMap.yToPrice(c.bodyTop);
          close = priceMap.yToPrice(c.bodyBottom);
        }

        return {
          idx: i,
          x: c.x,
          width: c.width,
          open,
          high,
          low,
          close,
          bullish: c.bullish,
          // Keep pixel coords for rendering
          px: {
            wickHigh: c.wickHigh,
            wickLow: c.wickLow,
            bodyTop: c.bodyTop,
            bodyBottom: c.bodyBottom,
          },
        };
      });
    }

    // ── Swing Detection ─────────────────────────────────────────────────

    /**
     * Detect swing highs and swing lows.
     * A swing high: bar[i].high > high of `lookback` bars on both sides.
     * A swing low:  bar[i].low  < low  of `lookback` bars on both sides.
     */
    function detectSwings(bars, lookback = 5) {
      const swings = [];

      for (let i = lookback; i < bars.length - lookback; i++) {
        let isSwingHigh = true;
        let isSwingLow = true;

        for (let j = 1; j <= lookback; j++) {
          if (
            bars[i].high <= bars[i - j].high ||
            bars[i].high <= bars[i + j].high
          ) {
            isSwingHigh = false;
          }
          if (
            bars[i].low >= bars[i - j].low ||
            bars[i].low >= bars[i + j].low
          ) {
            isSwingLow = false;
          }
        }

        if (isSwingHigh) {
          swings.push({
            idx: i,
            type: "high",
            price: bars[i].high,
            bar: bars[i],
          });
        }
        if (isSwingLow) {
          swings.push({
            idx: i,
            type: "low",
            price: bars[i].low,
            bar: bars[i],
          });
        }
      }

      return swings.sort((a, b) => a.idx - b.idx);
    }

    // ── Market Structure (BOS / CHoCH) ──────────────────────────────────

    /**
     * Detect Break of Structure (BOS) and Change of Character (CHoCH).
     *
     * BOS: price breaks a swing point in the direction of the trend (continuation).
     * CHoCH: price breaks a swing point against the trend (reversal signal).
     *
     * @param {Array} bars
     * @param {Array} swings
     * @returns {Array<{idx, type: "BOS"|"CHoCH", direction: "bull"|"bear", price, fromSwing, toBar}>}
     */
    function detectStructure(bars, swings) {
      const structures = [];
      if (swings.length < 3) return structures;

      let trend = "unknown"; // "bull" | "bear" | "unknown"
      let lastSwingHigh = null;
      let lastSwingLow = null;

      for (const swing of swings) {
        if (swing.type === "high") {
          if (lastSwingHigh && swing.price > lastSwingHigh.price) {
            // Higher high — confirms bullish structure
            if (trend === "bull") {
              structures.push({
                type: "BOS",
                direction: "bull",
                price: lastSwingHigh.price,
                fromSwing: lastSwingHigh,
                atBar: swing.bar,
                idx: swing.idx,
              });
            } else if (trend === "bear") {
              structures.push({
                type: "CHoCH",
                direction: "bull",
                price: lastSwingHigh.price,
                fromSwing: lastSwingHigh,
                atBar: swing.bar,
                idx: swing.idx,
              });
              trend = "bull";
            } else {
              trend = "bull";
            }
          } else if (lastSwingHigh && swing.price < lastSwingHigh.price) {
            // Lower high
          }
          lastSwingHigh = swing;
        } else if (swing.type === "low") {
          if (lastSwingLow && swing.price < lastSwingLow.price) {
            // Lower low — confirms bearish structure
            if (trend === "bear") {
              structures.push({
                type: "BOS",
                direction: "bear",
                price: lastSwingLow.price,
                fromSwing: lastSwingLow,
                atBar: swing.bar,
                idx: swing.idx,
              });
            } else if (trend === "bull") {
              structures.push({
                type: "CHoCH",
                direction: "bear",
                price: lastSwingLow.price,
                fromSwing: lastSwingLow,
                atBar: swing.bar,
                idx: swing.idx,
              });
              trend = "bear";
            } else {
              trend = "bear";
            }
          }
          lastSwingLow = swing;
        }
      }

      return structures;
    }

    // ── Order Blocks ────────────────────────────────────────────────────

    /**
     * Detect order blocks.
     *
     * Bullish OB: The last bearish candle before a strong bullish move
     * that breaks a swing high. Zone = [low, high] of that bearish candle.
     *
     * Bearish OB: The last bullish candle before a strong bearish move
     * that breaks a swing low. Zone = [low, high] of that bullish candle.
     */
    function detectOrderBlocks(bars, structures) {
      const obs = [];

      for (const struct of structures) {
        if (struct.type !== "BOS" && struct.type !== "CHoCH") continue;

        const breakIdx = struct.idx;
        if (breakIdx < 3) continue;

        if (struct.direction === "bull") {
          // Find the last bearish candle before the break
          for (let i = breakIdx - 1; i >= Math.max(0, breakIdx - 10); i--) {
            if (!bars[i].bullish) {
              obs.push({
                type: "bull",
                top: bars[i].high,
                bottom: bars[i].low,
                startIdx: i,
                startX: bars[i].x,
                bar: bars[i],
                mitigated: false,
              });
              break;
            }
          }
        } else {
          // Find the last bullish candle before the break
          for (let i = breakIdx - 1; i >= Math.max(0, breakIdx - 10); i--) {
            if (bars[i].bullish) {
              obs.push({
                type: "bear",
                top: bars[i].high,
                bottom: bars[i].low,
                startIdx: i,
                startX: bars[i].x,
                bar: bars[i],
                mitigated: false,
              });
              break;
            }
          }
        }
      }

      // Check mitigation: if price has returned to the OB zone
      for (const ob of obs) {
        for (let i = ob.startIdx + 1; i < bars.length; i++) {
          if (ob.type === "bull" && bars[i].low <= ob.bottom) {
            ob.mitigated = true;
            break;
          }
          if (ob.type === "bear" && bars[i].high >= ob.top) {
            ob.mitigated = true;
            break;
          }
        }
      }

      // Return only unmitigated, limit to maxDisplay
      const max = SMCConfig.get("obMaxDisplay");
      return obs.filter((o) => !o.mitigated).slice(-max);
    }

    // ── Fair Value Gaps (FVG / Imbalances) ──────────────────────────────

    /**
     * Detect Fair Value Gaps (3-candle imbalance patterns).
     *
     * Bullish FVG: bar[i-1].high < bar[i+1].low
     *   → gap between bar[i-1] high and bar[i+1] low
     *
     * Bearish FVG: bar[i-1].low > bar[i+1].high
     *   → gap between bar[i+1] high and bar[i-1] low
     */
    function detectFVG(bars) {
      const fvgs = [];
      const minSize = SMCConfig.get("fvgMinSize");

      for (let i = 1; i < bars.length - 1; i++) {
        const prev = bars[i - 1];
        const curr = bars[i];
        const next = bars[i + 1];

        // Bullish FVG
        if (next.low > prev.high) {
          const gapSize = next.low - prev.high;
          const relSize = gapSize / curr.close;
          if (relSize >= minSize) {
            fvgs.push({
              type: "bull",
              top: next.low,
              bottom: prev.high,
              idx: i,
              x: curr.x,
              filled: false,
            });
          }
        }

        // Bearish FVG
        if (prev.low > next.high) {
          const gapSize = prev.low - next.high;
          const relSize = gapSize / curr.close;
          if (relSize >= minSize) {
            fvgs.push({
              type: "bear",
              top: prev.low,
              bottom: next.high,
              idx: i,
              x: curr.x,
              filled: false,
            });
          }
        }
      }

      // Check if FVG has been filled (price returned into the gap)
      for (const fvg of fvgs) {
        for (let i = fvg.idx + 2; i < bars.length; i++) {
          if (fvg.type === "bull" && bars[i].low <= fvg.bottom) {
            fvg.filled = true;
            break;
          }
          if (fvg.type === "bear" && bars[i].high >= fvg.top) {
            fvg.filled = true;
            break;
          }
        }
      }

      return fvgs.filter((f) => !f.filled);
    }

    // ── Premium / Discount Zones ────────────────────────────────────────

    /**
     * Calculate Premium/Discount zones from the current swing range.
     * Premium = upper half (above equilibrium) — sell zone
     * Discount = lower half (below equilibrium) — buy zone
     *
     * Uses the most recent significant swing high and swing low.
     */
    function calcPremiumDiscount(swings) {
      if (swings.length < 2) return null;

      // Find the most recent swing high and swing low
      const recentHighs = swings.filter((s) => s.type === "high");
      const recentLows = swings.filter((s) => s.type === "low");

      if (recentHighs.length === 0 || recentLows.length === 0) return null;

      const swingHigh = recentHighs[recentHighs.length - 1].price;
      const swingLow = recentLows[recentLows.length - 1].price;

      if (swingHigh <= swingLow) return null;

      const equilibrium = (swingHigh + swingLow) / 2;

      return {
        high: swingHigh,
        low: swingLow,
        equilibrium,
        premium: { top: swingHigh, bottom: equilibrium },
        discount: { top: equilibrium, bottom: swingLow },
      };
    }

    // ── Equal Highs / Equal Lows ────────────────────────────────────────

    /**
     * Detect equal highs and equal lows (potential liquidity targets).
     * Two swing points at approximately the same price level.
     */
    function detectEqualLevels(swings) {
      const equals = [];
      const tol = SMCConfig.get("equalLevelTolerance");

      const highs = swings.filter((s) => s.type === "high");
      const lows = swings.filter((s) => s.type === "low");

      // Check equal highs
      for (let i = 0; i < highs.length; i++) {
        for (let j = i + 1; j < highs.length; j++) {
          const diff = Math.abs(highs[i].price - highs[j].price);
          const avg = (highs[i].price + highs[j].price) / 2;
          if (diff / avg < tol) {
            equals.push({
              type: "equalHigh",
              price: avg,
              points: [highs[i], highs[j]],
            });
          }
        }
      }

      // Check equal lows
      for (let i = 0; i < lows.length; i++) {
        for (let j = i + 1; j < lows.length; j++) {
          const diff = Math.abs(lows[i].price - lows[j].price);
          const avg = (lows[i].price + lows[j].price) / 2;
          if (diff / avg < tol) {
            equals.push({
              type: "equalLow",
              price: avg,
              points: [lows[i], lows[j]],
            });
          }
        }
      }

      return equals;
    }

    // ── Liquidity Sweeps ────────────────────────────────────────────────

    /**
     * Detect liquidity sweeps (stop hunts).
     * A sweep occurs when price briefly pierces a swing level then reverses.
     *
     * Bullish sweep: price dips below a swing low then closes above it.
     * Bearish sweep: price spikes above a swing high then closes below it.
     */
    function detectLiquiditySweeps(bars, swings) {
      const sweeps = [];

      for (const swing of swings) {
        const afterBars = bars.slice(swing.idx + 1, swing.idx + 6);

        if (swing.type === "low") {
          // Look for a bar that wicks below the swing low but closes above
          for (const bar of afterBars) {
            if (bar.low < swing.price && bar.close > swing.price) {
              sweeps.push({
                type: "bullSweep",
                price: swing.price,
                sweepBar: bar,
                swingPoint: swing,
              });
              break;
            }
          }
        } else if (swing.type === "high") {
          for (const bar of afterBars) {
            if (bar.high > swing.price && bar.close < swing.price) {
              sweeps.push({
                type: "bearSweep",
                price: swing.price,
                sweepBar: bar,
                swingPoint: swing,
              });
              break;
            }
          }
        }
      }

      return sweeps;
    }

    // ── Full Analysis ───────────────────────────────────────────────────

    /**
     * Run complete SMC analysis on normalized bars.
     * @param {Array} bars - Normalized OHLC bars
     * @param {number} tfMinutes - Current timeframe in minutes
     * @returns {Object} All detected SMC elements
     */
    function analyze(bars, tfMinutes) {
      if (!bars || bars.length < 10) return null;

      const cat = getTFCategory(tfMinutes);
      const lookback = SWING_LOOKBACK[cat];

      const swings = detectSwings(bars, lookback);
      const structures = detectStructure(bars, swings);
      const orderBlocks = SMCConfig.get("showOrderBlocks")
        ? detectOrderBlocks(bars, structures)
        : [];
      const fvgs = SMCConfig.get("showFVG") ? detectFVG(bars) : [];
      const premiumDiscount = SMCConfig.get("showPremiumDiscount")
        ? calcPremiumDiscount(swings)
        : null;
      const equalLevels = SMCConfig.get("showEqualLevels")
        ? detectEqualLevels(swings)
        : [];
      const sweeps = SMCConfig.get("showLiquiditySweeps")
        ? detectLiquiditySweeps(bars, swings)
        : [];

      return {
        swings,
        structures,
        orderBlocks,
        fvgs,
        premiumDiscount,
        equalLevels,
        sweeps,
        barCount: bars.length,
        timeframe: tfMinutes,
      };
    }

    return {
      normalizeCandles,
      detectSwings,
      detectStructure,
      detectOrderBlocks,
      detectFVG,
      calcPremiumDiscount,
      detectEqualLevels,
      detectLiquiditySweeps,
      analyze,
    };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  SMC RENDERER — draw SMC markings on the overlay canvas
  // ═══════════════════════════════════════════════════════════════════════

  const SMCRenderer = (() => {
    /**
     * Render all SMC elements onto the overlay canvas context.
     */
    function render(ctx, w, h, analysis, bars, priceMap) {
      if (!analysis || !bars || bars.length === 0 || !priceMap) return;

      const cfg = SMCConfig.all();

      // Draw in back-to-front order for proper layering
      if (cfg.showPremiumDiscount && analysis.premiumDiscount) {
        _drawPremiumDiscount(ctx, w, analysis.premiumDiscount, priceMap, cfg);
      }
      if (cfg.showFVG) {
        _drawFVGs(ctx, w, analysis.fvgs, bars, priceMap, cfg);
      }
      if (cfg.showOrderBlocks) {
        _drawOrderBlocks(ctx, w, analysis.orderBlocks, bars, priceMap, cfg);
      }
      if (cfg.showEqualLevels) {
        _drawEqualLevels(ctx, w, analysis.equalLevels, bars, priceMap, cfg);
      }
      if (cfg.showStructure) {
        _drawStructure(
          ctx,
          analysis.structures,
          analysis.swings,
          bars,
          priceMap,
          cfg,
        );
      }
      if (cfg.showLiquiditySweeps) {
        _drawSweeps(ctx, analysis.sweeps, priceMap, cfg);
      }
    }

    // ── Premium / Discount Zones ────────────────────────────────────────

    function _drawPremiumDiscount(ctx, canvasWidth, pd, pm, cfg) {
      const eqY = pm.priceToY(pd.equilibrium);
      const topY = pm.priceToY(pd.high);
      const botY = pm.priceToY(pd.low);
      const chartRight = canvasWidth - 56;

      // Premium zone (upper half)
      ctx.fillStyle = cfg.pdPremiumBg;
      ctx.fillRect(0, topY, chartRight, eqY - topY);

      // Discount zone (lower half)
      ctx.fillStyle = cfg.pdDiscountBg;
      ctx.fillRect(0, eqY, chartRight, botY - eqY);

      // Equilibrium line
      ctx.strokeStyle = cfg.pdEqLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, eqY);
      ctx.lineTo(chartRight, eqY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Labels
      ctx.font = cfg.zoneFont;
      ctx.fillStyle = "rgba(234,76,76,0.6)";
      ctx.fillText("PREMIUM", 8, topY + 14);
      ctx.fillStyle = "rgba(128,128,128,0.6)";
      ctx.fillText("EQ", 8, eqY - 4);
      ctx.fillStyle = "rgba(54,179,75,0.6)";
      ctx.fillText("DISCOUNT", 8, botY - 6);
    }

    // ── Fair Value Gaps ─────────────────────────────────────────────────

    function _drawFVGs(ctx, canvasWidth, fvgs, bars, pm, cfg) {
      const chartRight = canvasWidth - 56;

      for (const fvg of fvgs) {
        const topY = pm.priceToY(fvg.top);
        const botY = pm.priceToY(fvg.bottom);
        const startX = fvg.x;

        ctx.fillStyle = fvg.type === "bull" ? cfg.fvgBullBg : cfg.fvgBearBg;
        ctx.fillRect(startX, topY, chartRight - startX, botY - topY);

        // Subtle border
        ctx.strokeStyle =
          fvg.type === "bull" ? "rgba(54,179,75,0.25)" : "rgba(234,76,76,0.25)";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(startX, topY, chartRight - startX, botY - topY);

        // Label
        ctx.font = "8px Trebuchet MS, sans-serif";
        ctx.fillStyle =
          fvg.type === "bull" ? "rgba(54,179,75,0.5)" : "rgba(234,76,76,0.5)";
        ctx.fillText("FVG", startX + 3, topY + 10);
      }
    }

    // ── Order Blocks ────────────────────────────────────────────────────

    function _drawOrderBlocks(ctx, canvasWidth, obs, bars, pm, cfg) {
      const chartRight = canvasWidth - 56;

      for (const ob of obs) {
        const topY = pm.priceToY(ob.top);
        const botY = pm.priceToY(ob.bottom);
        const startX = ob.startX;

        // Zone fill
        ctx.fillStyle = ob.type === "bull" ? cfg.bullBg : cfg.bearBg;
        ctx.fillRect(startX, topY, chartRight - startX, botY - topY);

        // Left border accent
        ctx.fillStyle = ob.type === "bull" ? cfg.bullColor : cfg.bearColor;
        ctx.fillRect(startX, topY, 3, botY - topY);

        // Top and bottom lines
        ctx.strokeStyle =
          ob.type === "bull" ? "rgba(54,179,75,0.35)" : "rgba(234,76,76,0.35)";
        ctx.lineWidth = 0.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(startX, topY);
        ctx.lineTo(chartRight, topY);
        ctx.moveTo(startX, botY);
        ctx.lineTo(chartRight, botY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label
        ctx.font = cfg.labelFont;
        ctx.fillStyle = ob.type === "bull" ? cfg.bullColor : cfg.bearColor;
        const label = ob.type === "bull" ? "OB" : "OB";
        ctx.fillText(label, startX + 6, topY + 12);
      }
    }

    // ── Equal Highs / Lows ──────────────────────────────────────────────

    function _drawEqualLevels(ctx, canvasWidth, equals, bars, pm, cfg) {
      const chartRight = canvasWidth - 56;

      for (const eq of equals) {
        const y = pm.priceToY(eq.price);
        const x1 = eq.points[0].bar.x;
        const x2 = eq.points[1].bar.x;

        ctx.strokeStyle =
          eq.type === "equalHigh"
            ? "rgba(234,76,76,0.5)"
            : "rgba(54,179,75,0.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(chartRight, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Tick marks at each swing point
        for (const pt of eq.points) {
          ctx.fillStyle =
            eq.type === "equalHigh"
              ? "rgba(234,76,76,0.7)"
              : "rgba(54,179,75,0.7)";
          ctx.beginPath();
          ctx.arc(pt.bar.x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }

        // Label
        ctx.font = "8px Trebuchet MS, sans-serif";
        ctx.fillStyle =
          eq.type === "equalHigh"
            ? "rgba(234,76,76,0.6)"
            : "rgba(54,179,75,0.6)";
        const lbl = eq.type === "equalHigh" ? "EQH" : "EQL";
        ctx.fillText(lbl, x2 + 6, y - 4);
      }
    }

    // ── Market Structure (BOS / CHoCH) ──────────────────────────────────

    function _drawStructure(ctx, structures, swings, bars, pm, cfg) {
      if (!cfg.showStructure) return;

      // Draw swing points
      for (const sw of swings) {
        const bar = sw.bar;
        const x = bar.x;
        const y = pm.priceToY(sw.price);

        ctx.fillStyle =
          sw.type === "high" ? "rgba(234,76,76,0.6)" : "rgba(54,179,75,0.6)";

        // Small diamond marker
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 4, y);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 4, y);
        ctx.closePath();
        ctx.fill();
      }

      // Draw BOS / CHoCH labels
      for (const s of structures) {
        const y = pm.priceToY(s.price);
        const x = s.atBar.x;

        // Horizontal line from the broken swing level
        const fromX = s.fromSwing.bar.x;
        ctx.strokeStyle =
          s.direction === "bull"
            ? "rgba(54,179,75,0.5)"
            : "rgba(234,76,76,0.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(fromX, y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label box
        const label = s.type;
        const labelWidth = ctx.measureText(label).width + 8;
        const labelHeight = 14;
        const lx = (fromX + x) / 2 - labelWidth / 2;
        const ly = s.direction === "bull" ? y - labelHeight - 2 : y + 2;

        // Background
        ctx.fillStyle =
          s.type === "CHoCH"
            ? s.direction === "bull"
              ? "rgba(54,179,75,0.2)"
              : "rgba(234,76,76,0.2)"
            : s.direction === "bull"
              ? "rgba(54,179,75,0.1)"
              : "rgba(234,76,76,0.1)";
        ctx.fillRect(lx, ly, labelWidth, labelHeight);

        // Border
        ctx.strokeStyle =
          s.direction === "bull"
            ? "rgba(54,179,75,0.4)"
            : "rgba(234,76,76,0.4)";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(lx, ly, labelWidth, labelHeight);

        // Text
        ctx.font = cfg.labelFont;
        ctx.fillStyle = s.direction === "bull" ? cfg.bullColor : cfg.bearColor;
        ctx.fillText(label, lx + 4, ly + 11);
      }
    }

    // ── Liquidity Sweeps ────────────────────────────────────────────────

    function _drawSweeps(ctx, sweeps, pm, cfg) {
      for (const sw of sweeps) {
        const y = pm.priceToY(sw.price);
        const x = sw.sweepBar.x;

        // Arrow marker
        ctx.fillStyle =
          sw.type === "bullSweep"
            ? "rgba(54,179,75,0.8)"
            : "rgba(234,76,76,0.8)";

        const dir = sw.type === "bullSweep" ? 1 : -1; // 1 = up arrow, -1 = down arrow
        const tipY = y + dir * -12;

        ctx.beginPath();
        ctx.moveTo(x, tipY);
        ctx.lineTo(x - 5, tipY + dir * 8);
        ctx.lineTo(x - 2, tipY + dir * 8);
        ctx.lineTo(x - 2, tipY + dir * 16);
        ctx.lineTo(x + 2, tipY + dir * 16);
        ctx.lineTo(x + 2, tipY + dir * 8);
        ctx.lineTo(x + 5, tipY + dir * 8);
        ctx.closePath();
        ctx.fill();

        // Label
        ctx.font = "8px Trebuchet MS, sans-serif";
        ctx.fillStyle =
          sw.type === "bullSweep"
            ? "rgba(54,179,75,0.7)"
            : "rgba(234,76,76,0.7)";
        ctx.fillText("SWEEP", x + 8, tipY + 4);
      }
    }

    return { render };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  SMC PANEL — Settings toggle UI
  // ═══════════════════════════════════════════════════════════════════════

  const SMCPanel = (() => {
    let panelEl = null;
    let btnEl = null;
    let isOpen = false;

    function build() {
      // Inject styles
      const style = document.createElement("style");
      style.id = "smc-styles";
      style.textContent = `
        #smc-toggle-btn {
          position: fixed; top: 10px; right: 300px; z-index: 999998;
          font-family: 'Trebuchet MS', sans-serif;
          background: var(--color-card, #262f3f);
          border: 1px solid var(--color-border, #2b3543);
          border-radius: 20px; padding: 5px 14px;
          color: var(--color-text-blue, #4597ff);
          font-size: 12px; font-weight: 600; letter-spacing: 0.5px;
          cursor: pointer; user-select: none;
          box-shadow: 0 2px 12px rgba(0,0,0,0.4);
          transition: border-color 0.2s, box-shadow 0.2s;
          display: flex; align-items: center; gap: 6px;
        }
        #smc-toggle-btn:hover {
          border-color: var(--color-text-blue, #4597ff);
          box-shadow: 0 4px 18px rgba(69,151,255,0.25);
        }
        #smc-toggle-btn .smc-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: var(--color-fill-green, #36b34b);
        }
        #smc-toggle-btn .smc-dot.off { background: var(--color-icon-disabled, #647181); }

        #smc-panel {
          position: fixed; top: 46px; right: 260px; z-index: 999997;
          width: 260px;
          background: var(--color-background, #0f1720);
          border: 1px solid var(--color-border, #2b3543);
          border-radius: 12px; padding: 0;
          box-shadow: 0 16px 46px rgba(0,0,0,0.55);
          font-family: 'Trebuchet MS', sans-serif;
          opacity: 0; pointer-events: none; transform: translateY(-6px);
          transition: opacity 0.18s, transform 0.18s;
          overflow: hidden;
        }
        #smc-panel.open {
          opacity: 1; pointer-events: all; transform: translateY(0);
        }

        .smc-header {
          padding: 12px 14px 8px;
          border-bottom: 1px solid var(--color-border, #2b3543);
          display: flex; justify-content: space-between; align-items: center;
        }
        .smc-header-title {
          color: var(--color-text-default, #fff); font-size: 14px; font-weight: 600;
        }
        .smc-header-version {
          color: var(--color-text-blue, #4597ff); font-size: 10px;
        }

        .smc-body { padding: 8px 14px 14px; }

        .smc-row {
          display: flex; justify-content: space-between; align-items: center;
          padding: 6px 0;
          border-bottom: 1px solid rgba(43,53,67,0.4);
        }
        .smc-row:last-child { border-bottom: none; }
        .smc-row-label {
          color: var(--color-text-secondary, #8fa2b8); font-size: 13px;
        }

        .smc-switch {
          position: relative; width: 36px; height: 20px;
          background: var(--color-border, #2b3543);
          border-radius: 10px; cursor: pointer; transition: background 0.2s;
        }
        .smc-switch.on { background: var(--color-fill-blue, #3183ff); }
        .smc-switch::after {
          content: ''; position: absolute; top: 2px; left: 2px;
          width: 16px; height: 16px; border-radius: 50%;
          background: #fff; transition: transform 0.2s;
        }
        .smc-switch.on::after { transform: translateX(16px); }

        .smc-info {
          margin-top: 8px; padding: 8px;
          background: var(--color-card, #262f3f);
          border-radius: 6px; font-size: 10px;
          color: var(--color-text-secondary, #8fa2b8);
          line-height: 1.5;
        }
        .smc-info .smc-stat {
          color: var(--color-text-blue, #4597ff); font-weight: 600;
        }
      `;
      document.head.appendChild(style);

      // Toggle button
      btnEl = document.createElement("div");
      btnEl.id = "smc-toggle-btn";
      btnEl.innerHTML = `
        <div class="smc-dot ${SMCConfig.get("enabled") ? "" : "off"}"></div>
        <span>SMC</span>
      `;
      btnEl.addEventListener("click", () => {
        isOpen = !isOpen;
        panelEl.classList.toggle("open", isOpen);
      });

      // Panel
      panelEl = document.createElement("div");
      panelEl.id = "smc-panel";

      const features = [
        { key: "enabled", label: "Enabled" },
        { key: "showStructure", label: "BOS / CHoCH" },
        { key: "showOrderBlocks", label: "Order Blocks" },
        { key: "showFVG", label: "Fair Value Gaps" },
        { key: "showPremiumDiscount", label: "Premium / Discount" },
        { key: "showEqualLevels", label: "Equal Highs/Lows" },
        { key: "showLiquiditySweeps", label: "Liquidity Sweeps" },
      ];

      panelEl.innerHTML = `
        <div class="smc-header">
          <span class="smc-header-title">Smart Money Concepts</span>
          <span class="smc-header-version">v${SMC_VERSION}</span>
        </div>
        <div class="smc-body">
          ${features
            .map(
              (f) => `
            <div class="smc-row">
              <span class="smc-row-label">${f.label}</span>
              <div class="smc-switch ${SMCConfig.get(f.key) ? "on" : ""}"
                   data-key="${f.key}"></div>
            </div>
          `,
            )
            .join("")}
          <div class="smc-info" id="smc-stats">
            <span class="smc-stat">—</span> bars detected
          </div>
        </div>
      `;

      // Switch click handlers
      panelEl.querySelectorAll(".smc-switch").forEach((sw) => {
        sw.addEventListener("click", () => {
          const key = sw.dataset.key;
          const newVal = SMCConfig.toggle(key);
          sw.classList.toggle("on", newVal);
          if (key === "enabled") {
            btnEl.querySelector(".smc-dot").classList.toggle("off", !newVal);
          }
        });
      });

      // Close on outside click
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

    function updateStats(analysis) {
      const el = document.getElementById("smc-stats");
      if (!el || !analysis) return;
      el.innerHTML = `
        <span class="smc-stat">${analysis.barCount}</span> bars
        · <span class="smc-stat">${analysis.swings.length}</span> swings
        · <span class="smc-stat">${analysis.structures.length}</span> BOS/CHoCH
        · <span class="smc-stat">${analysis.orderBlocks.length}</span> OB
        · <span class="smc-stat">${analysis.fvgs.length}</span> FVG
      `;
    }

    return { build, updateStats };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  SMC PLUGIN — integrates with ChartOverlay from the main script
  // ═══════════════════════════════════════════════════════════════════════

  const SMCPlugin = (() => {
    let _overlayCanvas = null;
    let _ctx = null;
    let _scanTimer = null;
    let _lastAnalysis = null;
    let _lastBars = null;
    let _lastPriceMap = null;
    let _initialized = false;

    function init() {
      if (_initialized) return;

      SMCConfig.load();
      SMCPanel.build();

      // Create or find the overlay canvas
      _setupOverlay();

      if (_overlayCanvas && _ctx) {
        _initialized = true;
        _startScanLoop();
        console.log("[SMC] Plugin initialized");
      } else {
        // Retry
        setTimeout(init, 3000);
      }
    }

    function _setupOverlay() {
      // Check if the main script's overlay exists
      let existing = document.getElementById("pdiff-chart-overlay");
      if (existing) {
        // Share the same overlay canvas
        _overlayCanvas = existing;
        _ctx = _overlayCanvas.getContext("2d");
        return;
      }

      // Create our own overlay
      const chartOverlay = document.querySelector(".chart-overlay");
      if (!chartOverlay) return;

      const hostCanvas = chartOverlay.querySelector("canvas");
      if (!hostCanvas) return;

      _overlayCanvas = document.createElement("canvas");
      _overlayCanvas.id = "smc-chart-overlay";
      _overlayCanvas.style.cssText = `
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
        pointer-events: none;
        z-index: 3;
      `;

      chartOverlay.style.position = "relative";
      chartOverlay.appendChild(_overlayCanvas);

      _syncSize(hostCanvas);

      // Resize observer
      new ResizeObserver(() => _syncSize(hostCanvas)).observe(chartOverlay);

      _ctx = _overlayCanvas.getContext("2d");
    }

    function _syncSize(hostCanvas) {
      if (!_overlayCanvas || !hostCanvas) return;
      _overlayCanvas.width = hostCanvas.width;
      _overlayCanvas.height = hostCanvas.height;
    }

    function _startScanLoop() {
      if (_scanTimer) clearInterval(_scanTimer);

      function tick() {
        if (!SMCConfig.get("enabled")) {
          _clearOverlay();
          return;
        }
        _runAnalysis();
      }

      tick(); // Run immediately
      _scanTimer = setInterval(tick, SMCConfig.get("scanIntervalMs"));
    }

    function _clearOverlay() {
      if (_ctx && _overlayCanvas) {
        _ctx.clearRect(0, 0, _overlayCanvas.width, _overlayCanvas.height);
      }
    }

    function _runAnalysis() {
      const chartOverlay = document.querySelector(".chart-overlay");
      if (!chartOverlay) return;

      const hostCanvas = chartOverlay.querySelector("canvas");
      if (!hostCanvas) return;

      // Sync size
      _syncSize(hostCanvas);

      try {
        // 1. Extract candle data from pixels
        const rawCandles = CanvasExtractor.extractCandles(hostCanvas);
        if (rawCandles.length < 5) return;

        // 2. Build price mapping
        const priceMap = ChartInfo.buildPriceMapping(hostCanvas);
        if (!priceMap) return;

        // 3. Normalize candles to OHLC
        const bars = SMCEngine.normalizeCandles(rawCandles, priceMap);
        if (bars.length < 10) return;

        // 4. Get timeframe
        const { tfMinutes } = ChartInfo.parseTitle();

        // 5. Run SMC analysis
        const analysis = SMCEngine.analyze(bars, tfMinutes);
        if (!analysis) return;

        _lastAnalysis = analysis;
        _lastBars = bars;
        _lastPriceMap = priceMap;

        // 6. Render on overlay
        _clearOverlay();
        SMCRenderer.render(
          _ctx,
          _overlayCanvas.width,
          _overlayCanvas.height,
          analysis,
          bars,
          priceMap,
        );

        // 7. Update stats panel
        SMCPanel.updateStats(analysis);
      } catch (e) {
        console.warn("[SMC] Analysis error:", e);
      }
    }

    function destroy() {
      if (_scanTimer) clearInterval(_scanTimer);
      if (
        _overlayCanvas &&
        _overlayCanvas.id === "smc-chart-overlay" &&
        _overlayCanvas.parentNode
      ) {
        _overlayCanvas.parentNode.removeChild(_overlayCanvas);
      }
      _initialized = false;
    }

    return { init, destroy };
  })();

  // ═══════════════════════════════════════════════════════════════════════
  //  BOOT
  // ═══════════════════════════════════════════════════════════════════════

  // Wait for the chart to fully load before initializing
  setTimeout(() => {
    SMCPlugin.init();
  }, 8000);
})();
