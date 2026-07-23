// 24/7 Cloudflare Worker ICT Discord Alert Bot with High-Res Light/Dark TradingView Screenshots
// Runs every 1 minute for free on Cloudflare Workers

const DEFAULT_WEBHOOK = "https://discord.com/api/webhooks/1529895992118214706/72e329IvsoaXVMr3zIRf5dQVXaYc3dwE3";

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

    // Save Settings API
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

    // Send Test Alert API
    if (url.pathname === "/api/test-alert" && request.method === "POST") {
      let reqBody = {};
      try { reqBody = await request.json(); } catch(e) {}
      
      const config = await getConfig(env);
      const webhookUrl = reqBody.discordWebhookUrl || config.discordWebhookUrl || env.DISCORD_WEBHOOK_URL || DEFAULT_WEBHOOK;
      const chartTheme = reqBody.chartTheme || config.chartTheme || "light";

      if (!webhookUrl) {
        return new Response(JSON.stringify({ error: "No Discord Webhook URL provided! Please enter it in the Control Panel input field." }), { status: 400 });
      }

      // Save webhook & theme to state if passed
      if (reqBody.discordWebhookUrl || reqBody.chartTheme) {
        if (reqBody.discordWebhookUrl) config.discordWebhookUrl = reqBody.discordWebhookUrl;
        if (reqBody.chartTheme) config.chartTheme = reqBody.chartTheme;
        
        if (env.ALERT_KV) {
          await env.ALERT_KV.put("SETTINGS_CONFIG", JSON.stringify(config));
        } else {
          globalThis.USER_SETTINGS = config;
        }
      }

      try {
        const goldSym = SYMBOLS[2]; // XAUUSD Gold
        const realCandles = await fetchCandles(goldSym.ticker, "15m");
        const currentPrice = realCandles && realCandles.length > 0 ? realCandles[realCandles.length - 1].close : 2415.50;
        const chartImgUrl = generateTradingViewChartUrl(goldSym.tvSymbol, "15m", chartTheme);

        await sendDiscordEmbed(webhookUrl, "🧪 Test Alert - TUF Capital TradingView Chart", goldSym, "15m", currentPrice, 350, chartImgUrl);
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // Serve GUI Admin Page
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
      const settings = await getConfig(env);
      return new Response(renderAdminHTML(settings), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" }
      });
    }

    // Manual Scan Trigger
    if (url.pathname === "/scan") {
      await scanAll(env);
      return new Response("Scan triggered manually!", { status: 200 });
    }

    return new Response("TUF Capital ICT Bot Active", { status: 200 });
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

  const parseTf = (envVal, defaultArray) => envVal ? envVal.split(",").map(s => s.trim()) : defaultArray;
  const fallbackWebhook = env.DISCORD_WEBHOOK_URL || DEFAULT_WEBHOOK;

  if (custom) {
    if (!custom.discordWebhookUrl) custom.discordWebhookUrl = fallbackWebhook;
    if (!custom.chartTheme) custom.chartTheme = "light";
    return custom;
  }

  return {
    discordWebhookUrl: fallbackWebhook,
    chartTheme: "light",
    MSS: { enabled: env.ENABLE_MSS !== "false", timeframes: parseTf(env.MSS_TIMEFRAMES, ["1h", "4h"]) },
    FVG: {
      enabled: env.ENABLE_FVG !== "false",
      timeframes: parseTf(env.FVG_TIMEFRAMES, ["15m", "1h"]),
      minPointsForex: { "5m": 50, "15m": 100, "1h": 200, "4h": 500, "1d": 1000 },
      minPointsGold: { "5m": 100, "15m": 300, "1h": 500, "4h": 1000, "1d": 2000 }
    },
    FVGFill: { enabled: env.ENABLE_FVG_FILL !== "false", timeframes: parseTf(env.FVG_FILL_TIMEFRAMES, ["15m", "1h"]) },
    OB: { enabled: env.ENABLE_OB !== "false", timeframes: parseTf(env.OB_TIMEFRAMES, ["1h", "4h"]) },
    Liquidity: { enabled: env.ENABLE_LIQUIDITY !== "false", timeframes: parseTf(env.LIQUIDITY_TIMEFRAMES, ["15m", "1h", "4h"]) }
  };
}

async function scanAll(env) {
  const CONFIG = await getConfig(env);
  const webhookUrl = CONFIG.discordWebhookUrl || env.DISCORD_WEBHOOK_URL || DEFAULT_WEBHOOK;
  if (!webhookUrl) return;

  for (const sym of SYMBOLS) {
    const timeframes = new Set();
    ["MSS", "FVG", "FVGFill", "OB", "Liquidity"].forEach(pattern => {
      if (CONFIG[pattern] && CONFIG[pattern].enabled) {
        (CONFIG[pattern].timeframes || []).forEach(tf => timeframes.add(tf));
      }
    });

    const isGold = sym.ticker === "GC=F";
    const pointMultiplier = isGold ? 100 : 100000;

    for (const tf of timeframes) {
      try {
        const candles = await fetchCandles(sym.ticker, tf);
        if (!candles || candles.length < 5) continue;

        const closedBar = candles[candles.length - 2];
        const barBefore = candles[candles.length - 3];
        const barTwoBefore = candles[candles.length - 4];
        
        const timestamp = closedBar.timestamp;
        const currentPrice = closedBar.close;
        const chartImgUrl = generateTradingViewChartUrl(sym.tvSymbol, tf, CONFIG.chartTheme || "light");

        // 1. FVG Creation & Tracking with Min Points Filter
        if (CONFIG.FVG?.enabled && CONFIG.FVG.timeframes.includes(tf)) {
          const reqMinPoints = Number(
            isGold
              ? (CONFIG.FVG.minPointsGold?.[tf] ?? 300)
              : (CONFIG.FVG.minPointsForex?.[tf] ?? 100)
          );

          // Bullish FVG
          if (closedBar.low > barTwoBefore.high) {
            const gapPrice = closedBar.low - barTwoBefore.high;
            const gapPoints = Math.round(gapPrice * pointMultiplier);

            if (gapPoints >= reqMinPoints) {
              const key = `${sym.ticker}_${tf}_BULL_FVG_${timestamp}`;
              if (!(await isAlreadyAlerted(env, key))) {
                await markAsAlerted(env, key);
                await sendDiscordEmbed(webhookUrl, "🟢 Bullish FVG Formed", sym, tf, currentPrice, gapPoints, chartImgUrl);

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
                await sendDiscordEmbed(webhookUrl, "🔴 Bearish FVG Formed", sym, tf, currentPrice, gapPoints, chartImgUrl);

                const fvgLevelKey = `${sym.ticker}_${tf}_BEAR_FVG_LEVEL`;
                activeFvgs.set(fvgLevelKey, { bottom: closedBar.high, top: barTwoBefore.low, timestamp, gapPoints });
              }
            }
          }
        }

        // 2. FVG Fill Detection
        if (CONFIG.FVGFill?.enabled && CONFIG.FVGFill.timeframes.includes(tf)) {
          const bullFvgKey = `${sym.ticker}_${tf}_BULL_FVG_LEVEL`;
          const activeBullFvg = activeFvgs.get(bullFvgKey);
          if (activeBullFvg && closedBar.timestamp > activeBullFvg.timestamp) {
            if (closedBar.low <= activeBullFvg.top) {
              const fillKey = `${sym.ticker}_${tf}_BULL_FVG_FILLED_${activeBullFvg.timestamp}`;
              if (!(await isAlreadyAlerted(env, fillKey))) {
                await markAsAlerted(env, fillKey);
                await sendDiscordEmbed(webhookUrl, "🎯 Bullish FVG Filled / Tapped", sym, tf, currentPrice, activeBullFvg.gapPoints, chartImgUrl);
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
                await sendDiscordEmbed(webhookUrl, "🎯 Bearish FVG Filled / Tapped", sym, tf, currentPrice, activeBearFvg.gapPoints, chartImgUrl);
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
              await sendDiscordEmbed(webhookUrl, "🟢 Bullish MSS Breakout", sym, tf, currentPrice, null, chartImgUrl);
            }
          }

          if (closedBar.close < swingLow && barBefore.close >= swingLow) {
            const key = `${sym.ticker}_${tf}_BEAR_MSS_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🔴 Bearish MSS Breakdown", sym, tf, currentPrice, null, chartImgUrl);
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
              await sendDiscordEmbed(webhookUrl, "💥 Buyside Liquidity Swept", sym, tf, currentPrice, null, chartImgUrl);
            }
          }

          if (closedBar.low < swingLow && closedBar.close > swingLow) {
            const key = `${sym.ticker}_${tf}_SSL_SWEEP_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "💥 Sellside Liquidity Swept", sym, tf, currentPrice, null, chartImgUrl);
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

function generateTradingViewChartUrl(tvSymbol, timeframe, theme = "light") {
  const tfMap = { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
  const interval = tfMap[timeframe] || "15";
  const widgetUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=${interval}&theme=${theme}`;
  return `https://api.microlink.io/?url=${encodeURIComponent(widgetUrl)}&screenshot=true&embed=screenshot.url`;
}

async function sendDiscordEmbed(webhookUrl, eventTitle, symbol, timeframe, price, gapPoints = null, chartImgUrl = null) {
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

  const tradingViewUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol.tvSymbol)}`;

  let titleWithPoints = eventTitle;
  if (gapPoints !== null) {
    titleWithPoints += ` (${gapPoints} Pts)`;
  }

  let desc = `**Symbol:** \`${symbol.name}\`\n**Timeframe:** \`${timeframe}\`\n**Current Price:** \`${priceFormatted}\``;
  if (gapPoints !== null) {
    const pips = (gapPoints / 10).toFixed(1);
    desc += `\n**FVG Gap Size:** \`${gapPoints} Points\` (\`${pips} Pips\`)`;
  }
  desc += `\n**Time (Dhaka):** \`${dhakaTime}\`\n\n📈 [Open Live Chart on TradingView](${tradingViewUrl})`;

  const embed = {
    title: `🚨 ${titleWithPoints}`,
    description: desc,
    color: eventTitle.includes("Bullish") || eventTitle.includes("Taken") ? 0x00E6A1 : 0xE60400,
    footer: { text: "TUF Capital" }
  };

  if (chartImgUrl) {
    embed.image = { url: chartImgUrl };
  }

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

  const forexMinPoints = settings.FVG?.minPointsForex || { "5m": 50, "15m": 100, "1h": 200, "4h": 500, "1d": 1000 };
  const goldMinPoints = settings.FVG?.minPointsGold || { "5m": 100, "15m": 300, "1h": 500, "4h": 1000, "1d": 2000 };
  const chartTheme = settings.chartTheme || "light";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TUF Capital ICT Control Panel</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; max-width: 650px; margin: auto; }
    h1 { color: #38bdf8; font-size: 24px; text-align: center; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .header { display: flex; justify-content: space-between; align-items: center; }
    .title { font-weight: bold; font-size: 18px; color: #f1f5f9; }
    .sub-title { font-size: 12px; color: #94a3b8; margin-top: 4px; }
    .section-label { font-size: 13px; font-weight: bold; color: #fbbf24; margin-top: 12px; margin-bottom: 4px; }
    .tf-group { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .btn { background: #334155; border: 1px solid #475569; color: #94a3b8; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-weight: 600; }
    .btn.active { background: #0284c7; color: #ffffff; border-color: #38bdf8; }
    .min-points-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 10px; margin-top: 8px; background: #0f172a; padding: 12px; border-radius: 8px; }
    .min-points-item { display: flex; flex-direction: column; gap: 4px; }
    .min-points-item label { font-size: 11px; font-weight: bold; color: #38bdf8; }
    .min-points-item input { background: #1e293b; border: 1px solid #475569; color: white; padding: 6px; border-radius: 6px; font-weight: bold; text-align: center; }
    .save-btn { width: 100%; background: #10b981; color: white; border: none; padding: 14px; border-radius: 10px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 15px; }
    .save-btn:hover { background: #059669; }
    .test-btn { width: 100%; background: #8b5cf6; color: white; border: none; padding: 12px; border-radius: 10px; font-size: 15px; font-weight: bold; cursor: pointer; margin-top: 10px; }
    .test-btn:hover { background: #7c3aed; }
    .webhook-input { width: 100%; box-sizing: border-box; margin-top: 8px; padding: 10px; background: #0f172a; border: 1px solid #475569; color: white; border-radius: 8px; font-size: 13px; }
    .theme-select { width: 100%; box-sizing: border-box; margin-top: 8px; padding: 10px; background: #0f172a; border: 1px solid #475569; color: white; border-radius: 8px; font-size: 13px; }
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
  <h1>🏦 TUF Capital ICT Control Panel</h1>
  <div id="status"></div>

  <div class="card">
    <div class="title">🔗 Discord Webhook URL</div>
    <div class="sub-title">Paste your Discord channel webhook URL below:</div>
    <input type="text" id="discordWebhookUrl" class="webhook-input" value="${settings.discordWebhookUrl || DEFAULT_WEBHOOK}" placeholder="https://discord.com/api/webhooks/...">
  </div>

  <div class="card">
    <div class="title">🎨 Chart Theme Preference</div>
    <div class="sub-title">Select White (Light Theme) or Dark Theme for alert screenshots:</div>
    <select id="chartTheme" class="theme-select">
      <option value="light" ${chartTheme === 'light' ? 'selected' : ''}>☀️ White Theme (Matching Your Chart)</option>
      <option value="dark" ${chartTheme === 'dark' ? 'selected' : ''}>🌙 Dark Theme</option>
    </select>
  </div>

  <button type="button" class="test-btn" onclick="sendTestAlert()">🧪 Send TUF Capital Test Alert</button>

  <form id="configForm" style="margin-top: 15px;">
    ${patterns.map(pat => {
      const pData = settings[pat] || { enabled: true, timeframes: [] };
      return `
      <div class="card">
        <div class="header">
          <div class="title">${labels[pat] || pat}</div>
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
        <div class="section-label">💱 Forex FVG Min Points (EURUSD, GBPUSD)</div>
        <div class="min-points-grid">
          ${allTfs.map(tf => `
            <div class="min-points-item">
              <label>${tf} Points</label>
              <input type="number" id="forex_fvg_min_${tf}" value="${forexMinPoints[tf] || 100}" placeholder="100">
            </div>
          `).join('')}
        </div>

        <div class="section-label">🥇 Gold FVG Min Points (XAUUSD) ($1.00 = 100 pts)</div>
        <div class="min-points-grid">
          ${allTfs.map(tf => `
            <div class="min-points-item">
              <label>${tf} Points</label>
              <input type="number" id="gold_fvg_min_${tf}" value="${goldMinPoints[tf] || 300}" placeholder="300">
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
    const defaultWebhook = "${DEFAULT_WEBHOOK}";

    // Auto restore Webhook URL & Theme from localStorage
    window.addEventListener('DOMContentLoaded', () => {
      const savedLocalWebhook = localStorage.getItem('ict_discord_webhook_url');
      const webhookInput = document.getElementById('discordWebhookUrl');
      if (savedLocalWebhook) {
        webhookInput.value = savedLocalWebhook;
        settings.discordWebhookUrl = savedLocalWebhook;
      } else if (!webhookInput.value) {
        webhookInput.value = defaultWebhook;
        settings.discordWebhookUrl = defaultWebhook;
      }

      const savedTheme = localStorage.getItem('ict_chart_theme');
      const themeInput = document.getElementById('chartTheme');
      if (savedTheme) {
        themeInput.value = savedTheme;
        settings.chartTheme = savedTheme;
      }
    });

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

    async function sendTestAlert() {
      let webhookVal = document.getElementById('discordWebhookUrl').value.trim();
      if (!webhookVal) webhookVal = defaultWebhook;

      const themeVal = document.getElementById('chartTheme').value;
      
      localStorage.setItem('ict_discord_webhook_url', webhookVal);
      localStorage.setItem('ict_chart_theme', themeVal);

      const status = document.getElementById('status');
      status.style.color = '#38bdf8';
      status.innerText = '⏳ Sending TUF Capital Test Alert to Discord...';
      
      try {
        const res = await fetch('/api/test-alert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ discordWebhookUrl: webhookVal, chartTheme: themeVal })
        });

        if (res.ok) {
          status.style.color = '#10b981';
          status.innerText = '✅ TUF Capital Alert Sent to Discord!';
        } else {
          const err = await res.json();
          status.style.color = '#ef4444';
          status.innerText = '❌ Failed: ' + (err.error || 'Check Discord Webhook URL');
        }
      } catch (err) {
        status.style.color = '#ef4444';
        status.innerText = '❌ Network Error: ' + err.message;
      }
      setTimeout(() => status.innerText = '', 5000);
    }

    document.getElementById('configForm').onsubmit = async (e) => {
      e.preventDefault();
      let webhookVal = document.getElementById('discordWebhookUrl').value.trim();
      if (!webhookVal) webhookVal = defaultWebhook;

      const themeVal = document.getElementById('chartTheme').value;
      
      settings.discordWebhookUrl = webhookVal;
      settings.chartTheme = themeVal;

      localStorage.setItem('ict_discord_webhook_url', webhookVal);
      localStorage.setItem('ict_chart_theme', themeVal);

      ['FVG', 'FVGFill', 'MSS', 'OB', 'Liquidity'].forEach(pat => {
        if (!settings[pat]) settings[pat] = { enabled: true, timeframes: [] };
        settings[pat].enabled = document.getElementById(pat + '_enabled').checked;
      });

      if (!settings.FVG.minPointsForex) settings.FVG.minPointsForex = {};
      if (!settings.FVG.minPointsGold) settings.FVG.minPointsGold = {};

      ['5m', '15m', '1h', '4h', '1d'].forEach(tf => {
        const forexVal = document.getElementById('forex_fvg_min_' + tf);
        if (forexVal) settings.FVG.minPointsForex[tf] = Number(forexVal.value);

        const goldVal = document.getElementById('gold_fvg_min_' + tf);
        if (goldVal) settings.FVG.minPointsGold[tf] = Number(goldVal.value);
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
