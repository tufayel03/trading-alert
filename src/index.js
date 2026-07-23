// 24/7 Cloudflare Worker ICT Discord Alert Bot with Custom Per-Timeframe FVG Min Points & GUI Control
// Runs every 1 minute for free on Cloudflare Workers

const SYMBOLS = [
  { name: "EURUSD", ticker: "EURUSD=X", tvSymbol: "FX:EURUSD", decimals: 5 },
  { name: "GBPUSD", ticker: "GBPUSD=X", tvSymbol: "FX:GBPUSD", decimals: 5 },
  { name: "XAUUSD (Gold)", ticker: "GC=F", tvSymbol: "OANDA:XAUUSD", decimals: 2 }
];

const memoryCache = new Set();
const activeFvgs = new Map();

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scanAll(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/settings" && request.method === "POST") {
      try {
        const body = await request.json();
        if (env.ALERT_KV) {
          await env.ALERT_KV.put("SETTINGS_CONFIG", JSON.stringify(body));
        } else {
          globalThis.USER_SETTINGS = body;
        }
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400 });
      }
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
      const settings = await getConfig(env);
      return new Response(renderAdminHTML(settings), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (url.pathname === "/scan") {
      await scanAll(env);
      return new Response("Scan triggered manually!", { status: 200 });
    }

    return new Response("ICT Cloudflare Bot Active", { status: 200 });
  }
};

async function getConfig(env) {
  let custom = null;
  if (env.ALERT_KV) {
    const raw = await env.ALERT_KV.get("SETTINGS_CONFIG");
    if (raw) custom = JSON.parse(raw);
  } else if (globalThis.USER_SETTINGS) {
    custom = globalThis.USER_SETTINGS;
  }

  if (custom) return custom;

  const parseTf = (envVal, defaultArray) => envVal ? envVal.split(",").map(s => s.trim()) : defaultArray;

  return {
    MSS: { enabled: env.ENABLE_MSS !== "false", timeframes: parseTf(env.MSS_TIMEFRAMES, ["1h", "4h"]) },
    FVG: {
      enabled: env.ENABLE_FVG !== "false",
      timeframes: parseTf(env.FVG_TIMEFRAMES, ["15m", "1h"]),
      minPoints: { "5m": 50, "15m": 200, "1h": 500, "4h": 1000, "1d": 2000 }
    },
    FVGFill: { enabled: env.ENABLE_FVG_FILL !== "false", timeframes: parseTf(env.FVG_FILL_TIMEFRAMES, ["15m", "1h"]) },
    OB: { enabled: env.ENABLE_OB !== "false", timeframes: parseTf(env.OB_TIMEFRAMES, ["1h", "4h"]) },
    Liquidity: { enabled: env.ENABLE_LIQUIDITY !== "false", timeframes: parseTf(env.LIQUIDITY_TIMEFRAMES, ["15m", "1h", "4h"]) }
  };
}

async function scanAll(env) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const CONFIG = await getConfig(env);

  for (const sym of SYMBOLS) {
    const timeframes = new Set();
    ["MSS", "FVG", "FVGFill", "OB", "Liquidity"].forEach(pattern => {
      if (CONFIG[pattern] && CONFIG[pattern].enabled) {
        (CONFIG[pattern].timeframes || []).forEach(tf => timeframes.add(tf));
      }
    });

    const pointMultiplier = sym.decimals === 5 ? 100000 : 100;

    for (const tf of timeframes) {
      try {
        const candles = await fetchCandles(sym.ticker, tf);
        if (!candles || candles.length < 5) continue;

        const closedBar = candles[candles.length - 2];
        const barBefore = candles[candles.length - 3];
        const barTwoBefore = candles[candles.length - 4];
        
        const timestamp = closedBar.timestamp;
        const currentPrice = closedBar.close;

        // 1. FVG Creation & Tracking with Custom Min Points Threshold
        if (CONFIG.FVG?.enabled && CONFIG.FVG.timeframes.includes(tf)) {
          const reqMinPoints = Number(CONFIG.FVG.minPoints?.[tf] || 0);

          // Bullish FVG
          if (closedBar.low > barTwoBefore.high) {
            const gapPrice = closedBar.low - barTwoBefore.high;
            const gapPoints = Math.round(gapPrice * pointMultiplier);

            if (gapPoints >= reqMinPoints) {
              const key = `${sym.ticker}_${tf}_BULL_FVG_${timestamp}`;
              if (!(await isAlreadyAlerted(env, key))) {
                await markAsAlerted(env, key);
                await sendDiscordEmbed(webhookUrl, "🟢 Bullish FVG Formed", sym, tf, currentPrice, gapPoints);

                const fvgLevelKey = `${sym.ticker}_${tf}_BULL_FVG_LEVEL`;
                activeFvgs.set(fvgLevelKey, { top: closedBar.low, bottom: barTwoBefore.high, timestamp, gapPoints });
              }
            }
          }

          // Bearish FVG
          if (closedBar.high < barTwoBefore.low) {
            const gapPrice = barTwoBefore.low - closedBar.high;
            const gapPoints = Math.round(gapPrice * pointMultiplier);

            if (gapPoints >= reqMinPoints) {
              const key = `${sym.ticker}_${tf}_BEAR_FVG_${timestamp}`;
              if (!(await isAlreadyAlerted(env, key))) {
                await markAsAlerted(env, key);
                await sendDiscordEmbed(webhookUrl, "🔴 Bearish FVG Formed", sym, tf, currentPrice, gapPoints);

                const fvgLevelKey = `${sym.ticker}_${tf}_BEAR_FVG_LEVEL`;
                activeFvgs.set(fvgLevelKey, { bottom: closedBar.high, top: barTwoBefore.low, timestamp, gapPoints });
              }
            }
          }
        }

        // 2. FVG Fill / Mitigation Detection
        if (CONFIG.FVGFill?.enabled && CONFIG.FVGFill.timeframes.includes(tf)) {
          const bullFvgKey = `${sym.ticker}_${tf}_BULL_FVG_LEVEL`;
          const activeBullFvg = activeFvgs.get(bullFvgKey);
          if (activeBullFvg && closedBar.timestamp > activeBullFvg.timestamp) {
            if (closedBar.low <= activeBullFvg.top) {
              const fillKey = `${sym.ticker}_${tf}_BULL_FVG_FILLED_${activeBullFvg.timestamp}`;
              if (!(await isAlreadyAlerted(env, fillKey))) {
                await markAsAlerted(env, fillKey);
                await sendDiscordEmbed(webhookUrl, "🎯 Bullish FVG Filled / Tapped", sym, tf, currentPrice, activeBullFvg.gapPoints);
                activeFvgs.delete(bullFvgKey);
              }
            }
          }

          const bearFvgKey = `${sym.ticker}_${tf}_BEAR_FVG_LEVEL`;
          const activeBearFvg = activeFvgs.get(bearFvgKey);
          if (activeBearFvg && closedBar.timestamp > activeBearFvg.timestamp) {
            if (closedBar.high >= activeBearFvg.bottom) {
              const fillKey = `${sym.ticker}_${tf}_BEAR_FVG_FILLED_${activeBearFvg.timestamp}`;
              if (!(await isAlreadyAlerted(env, fillKey))) {
                await markAsAlerted(env, fillKey);
                await sendDiscordEmbed(webhookUrl, "🎯 Bearish FVG Filled / Tapped", sym, tf, currentPrice, activeBearFvg.gapPoints);
                activeFvgs.delete(bearFvgKey);
              }
            }
          }
        }

        // 3. MSS Detection
        if (CONFIG.MSS?.enabled && CONFIG.MSS.timeframes.includes(tf)) {
          const recentHighs = candles.slice(-12, -3).map(c => c.high);
          const recentLows = candles.slice(-12, -3).map(c => c.low);
          const swingHigh = Math.max(...recentHighs);
          const swingLow = Math.min(...recentLows);

          if (closedBar.close > swingHigh && barBefore.close <= swingHigh) {
            const key = `${sym.ticker}_${tf}_BULL_MSS_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🟢 Bullish MSS Breakout", sym, tf, currentPrice);
            }
          }

          if (closedBar.close < swingLow && barBefore.close >= swingLow) {
            const key = `${sym.ticker}_${tf}_BEAR_MSS_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🔴 Bearish MSS Breakdown", sym, tf, currentPrice);
            }
          }
        }

        // 4. Liquidity Sweep Detection
        if (CONFIG.Liquidity?.enabled && CONFIG.Liquidity.timeframes.includes(tf)) {
          const recentHighs = candles.slice(-15, -3).map(c => c.high);
          const recentLows = candles.slice(-15, -3).map(c => c.low);
          const swingHigh = Math.max(...recentHighs);
          const swingLow = Math.min(...recentLows);

          if (closedBar.high > swingHigh && closedBar.close < swingHigh) {
            const key = `${sym.ticker}_${tf}_BSL_SWEEP_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "💥 Buyside Liquidity Swept", sym, tf, currentPrice);
            }
          }

          if (closedBar.low < swingLow && closedBar.close > swingLow) {
            const key = `${sym.ticker}_${tf}_SSL_SWEEP_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "💥 Sellside Liquidity Swept", sym, tf, currentPrice);
            }
          }
        }

      } catch (err) {
        console.error(`Error scanning ${sym.name} (${tf}):`, err);
      }
    }
  }
}

async function isAlreadyAlerted(env, key) {
  if (env.ALERT_KV) {
    const val = await env.ALERT_KV.get(key);
    return val !== null;
  }
  return memoryCache.has(key);
}

async function markAsAlerted(env, key) {
  if (env.ALERT_KV) {
    await env.ALERT_KV.put(key, "1", { expirationTtl: 604800 });
  }
  memoryCache.add(key);
}

async function fetchCandles(ticker, timeframe) {
  const intervalMap = {
    "5m": { interval: "5m", range: "5d" },
    "15m": { interval: "15m", range: "5d" },
    "1h": { interval: "60m", range: "1mo" },
    "4h": { interval: "60m", range: "3mo" },
    "1d": { interval: "1d", range: "6mo" }
  };

  const { interval, range } = intervalMap[timeframe] || { interval: "60m", range: "1mo" };
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (!timestamps || !quote) return null;

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quote.open[i] != null && quote.high[i] != null && quote.low[i] != null && quote.close[i] != null) {
      candles.push({
        timestamp: timestamps[i],
        open: quote.open[i],
        high: quote.high[i],
        low: quote.low[i],
        close: quote.close[i]
      });
    }
  }

  return candles;
}

async function sendDiscordEmbed(webhookUrl, eventTitle, symbol, timeframe, price, gapPoints = null) {
  const priceFormatted = price.toFixed(symbol.decimals || 4);

  const dhakaTime = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });

  const chartImgUrl = `https://api.chart-img.com/v1/tradingview/advanced-chart?symbol=${encodeURIComponent(symbol.tvSymbol)}&interval=${timeframe}&theme=dark`;
  const tradingViewUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol.tvSymbol)}`;

  let desc = `**Symbol:** \`${symbol.name}\`\n**Timeframe:** \`${timeframe}\`\n**Current Price:** \`${priceFormatted}\``;
  if (gapPoints !== null) {
    const pips = (gapPoints / 10).toFixed(1);
    desc += `\n**FVG Gap Size:** \`${gapPoints} Points\` (\`${pips} Pips\`)`;
  }
  desc += `\n**Time (Dhaka):** \`${dhakaTime}\`\n\n📈 [Open Live Chart on TradingView](${tradingViewUrl})`;

  const embed = {
    title: `🚨 ${eventTitle}`,
    description: desc,
    color: eventTitle.includes("Bullish") || eventTitle.includes("Taken") ? 0x00E6A1 : 0xE60400,
    image: { url: chartImgUrl },
    footer: { text: "Cloudflare Worker ICT Scanner (Dhaka Time)" }
  };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] })
  });
}

function renderAdminHTML(settings) {
  const patterns = ["FVG", "FVGFill", "MSS", "OB", "Liquidity"];
  const labels = { FVG: "FVG Formed", FVGFill: "FVG Filled / Mitigated", MSS: "MSS Shift", OB: "Order Block", Liquidity: "Liquidity Sweep" };
  const allTfs = ["5m", "15m", "1h", "4h", "1d"];

  const fvgMinPoints = settings.FVG?.minPoints || { "5m": 50, "15m": 200, "1h": 500, "4h": 1000, "1d": 2000 };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ICT Bot Control Panel</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; max-width: 650px; margin: auto; }
    h1 { color: #38bdf8; font-size: 24px; text-align: center; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .header { display: flex; justify-content: space-between; align-items: center; }
    .title { font-weight: bold; font-size: 18px; color: #f1f5f9; }
    .sub-title { font-size: 13px; color: #94a3b8; margin-top: 4px; }
    .tf-group { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .btn { background: #334155; border: 1px solid #475569; color: #94a3b8; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-weight: 600; }
    .btn.active { background: #0284c7; color: #ffffff; border-color: #38bdf8; }
    .min-points-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 10px; margin-top: 14px; background: #0f172a; padding: 12px; border-radius: 8px; }
    .min-points-item { display: flex; flex-direction: column; gap: 4px; }
    .min-points-item label { font-size: 12px; font-weight: bold; color: #38bdf8; }
    .min-points-item input { background: #1e293b; border: 1px solid #475569; color: white; padding: 6px; border-radius: 6px; font-weight: bold; text-align: center; }
    .save-btn { width: 100%; background: #10b981; color: white; border: none; padding: 14px; border-radius: 10px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 20px; }
    .save-btn:hover { background: #059669; }
    .switch { position: relative; display: inline-block; width: 44px; height: 24px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #475569; transition: .3s; border-radius: 24px; }
    .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%; }
    input:checked + .slider { background-color: #10b981; }
    input:checked + .slider:before { transform: translateX(20px); }
    #status { text-align: center; margin-top: 10px; font-weight: bold; }
  </style>
</head>
<body>
  <h1>🎛️ ICT Alert Control Panel</h1>
  <div id="status"></div>
  <form id="configForm">
    ${patterns.map(pat => {
      const pData = settings[pat] || { enabled: true, timeframes: [] };
      return `
      <div class="card">
        <div class="header">
          <div>
            <div class="title">${labels[pat] || pat}</div>
            ${pat === 'FVG' ? '<div class="sub-title">Set Minimum FVG Size in Points for each timeframe below:</div>' : ''}
          </div>
          <label class="switch">
            <input type="checkbox" id="${pat}_enabled" ${pData.enabled ? "checked" : ""}>
            <span class="slider"></span>
          </label>
        </div>
        <div class="tf-group">
          ${allTfs.map(tf => `
            <button type="button" class="btn ${pData.timeframes.includes(tf) ? "active" : ""}" onclick="toggleTf('${pat}', '${tf}', this)">${tf}</button>
          `).join('')}
        </div>

        ${pat === 'FVG' ? `
        <div class="min-points-grid">
          ${allTfs.map(tf => `
            <div class="min-points-item">
              <label>${tf} Min Points</label>
              <input type="number" id="fvg_min_${tf}" value="${fvgMinPoints[tf] || 200}" placeholder="200">
            </div>
          `).join('')}
        </div>
        ` : ''}

      </div>`;
    }).join('')}
    <button type="submit" class="save-btn">💾 Save Settings Instant</button>
  </form>

  <script>
    const settings = ${JSON.stringify(settings)};

    function toggleTf(pattern, tf, btn) {
      if (!settings[pattern]) settings[pattern] = { enabled: true, timeframes: [] };
      if (!settings[pattern].timeframes) settings[pattern].timeframes = [];
      const idx = settings[pattern].timeframes.indexOf(tf);
      if (idx > -1) {
        settings[pattern].timeframes.splice(idx, 1);
        btn.classList.remove('active');
      } else {
        settings[pattern].timeframes.push(tf);
        btn.classList.add('active');
      }
    }

    document.getElementById('configForm').onsubmit = async (e) => {
      e.preventDefault();
      ['FVG', 'FVGFill', 'MSS', 'OB', 'Liquidity'].forEach(pat => {
        if (!settings[pat]) settings[pat] = { enabled: true, timeframes: [] };
        settings[pat].enabled = document.getElementById(pat + '_enabled').checked;
      });

      if (!settings.FVG.minPoints) settings.FVG.minPoints = {};
      ['5m', '15m', '1h', '4h', '1d'].forEach(tf => {
        const val = document.getElementById('fvg_min_' + tf);
        if (val) settings.FVG.minPoints[tf] = Number(val.value);
      });

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });

      const status = document.getElementById('status');
      if (res.ok) {
        status.style.color = '#10b981';
        status.innerText = '✅ Settings Saved Instantly!';
      } else {
        status.style.color = '#ef4444';
        status.innerText = '❌ Error saving settings!';
      }
      setTimeout(() => status.innerText = '', 3000);
    };
  </script>
</body>
</html>`;
}
