// 24/7 Cloudflare Worker ICT Discord Alert Bot with Premium TUF Capital Dashboard UI
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

    // Direct Webhook Endpoint for TradingView Native Alerts
    if (url.pathname === "/api/webhook" && request.method === "POST") {
      try {
        const body = await request.json();
        const config = await getConfig(env);
        const webhookUrl = config.discordWebhookUrl || DEFAULT_WEBHOOK;

        const symbol = body.symbol || "XAUUSD";
        const timeframe = body.timeframe || "15m";
        const message = body.message || "ICT Pattern Detected!";
        const chartImg = body.image || body.chart_image || generateTradingViewChartUrl("OANDA:XAUUSD", timeframe, config.chartTheme || "light");

        await sendDiscordEmbed(webhookUrl, message, { name: symbol, tvSymbol: symbol, decimals: 2 }, timeframe, body.price || 4045.0, null, chartImg);
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
        const currentPrice = realCandles && realCandles.length > 0 ? realCandles[realCandles.length - 1].close : 4047.50;
        const chartImgUrl = generateTradingViewChartUrl(goldSym.tvSymbol, "15m", chartTheme);

        await sendDiscordEmbed(webhookUrl, "🟢 Bullish BOS (Break of Structure)", goldSym, "15m", currentPrice, null, chartImgUrl);
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
    if (!custom.BOS) custom.BOS = { enabled: true, timeframes: ["15m", "1h", "4h"] };
    return custom;
  }

  return {
    discordWebhookUrl: fallbackWebhook,
    chartTheme: "light",
    BOS: { enabled: true, timeframes: ["15m", "1h", "4h"] },
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
    ["BOS", "MSS", "FVG", "FVGFill", "OB", "Liquidity"].forEach(pattern => {
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

        // 3. BOS (Break of Structure) Detection
        if (CONFIG.BOS?.enabled && CONFIG.BOS.timeframes.includes(tf)) {
          const recentHighs = candles.slice(-10, -2).map(c => c.high);
          const recentLows = candles.slice(-10, -2).map(c => c.low);
          const swingHigh = Math.max(...recentHighs);
          const swingLow = Math.min(...recentLows);

          if (closedBar.close > swingHigh && barBefore.close <= swingHigh) {
            const key = `${sym.ticker}_${tf}_BULL_BOS_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🟢 Bullish BOS (Break of Structure)", sym, tf, currentPrice, null, chartImgUrl);
            }
          }

          if (closedBar.close < swingLow && barBefore.close >= swingLow) {
            const key = `${sym.ticker}_${tf}_BEAR_BOS_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🔴 Bearish BOS (Break of Structure)", sym, tf, currentPrice, null, chartImgUrl);
            }
          }
        }

        // 4. MSS Detection
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

        // 5. Liquidity Sweep Detection
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
  const widgetUrl = `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=${interval}&theme=${theme}&hide_volume=true`;
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
  const patterns = [
    { key: "BOS", name: "BOS (Break of Structure)", desc: "Market structure trend continuation breaks" },
    { key: "MSS", name: "MSS (Market Structure Shift)", desc: "Major market trend reversal shifts" },
    { key: "FVG", name: "FVG (Fair Value Gap)", desc: "Imbalance formation with point filters" },
    { key: "FVGFill", name: "FVG Fill / Mitigation", desc: "Price entry into created imbalance zones" },
    { key: "OB", name: "Order Block (OB)", desc: "High probability institutional entry blocks" },
    { key: "Liquidity", name: "Liquidity Sweeps", desc: "Buyside & Sellside liquidity pool sweeps" }
  ];
  
  const allTfs = ["5m", "15m", "1h", "4h", "1d"];
  const forexMinPoints = settings.FVG?.minPointsForex || { "5m": 50, "15m": 100, "1h": 200, "4h": 500, "1d": 1000 };
  const goldMinPoints = settings.FVG?.minPointsGold || { "5m": 100, "15m": 300, "1h": 500, "4h": 1000, "1d": 2000 };
  const chartTheme = settings.chartTheme || "light";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TUF Capital — ICT Market Scanner</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #07090e;
      --card-bg: #0e131f;
      --card-border: rgba(255, 255, 255, 0.07);
      --card-hover: rgba(255, 255, 255, 0.11);
      --accent-blue: #0284c7;
      --accent-cyan: #38bdf8;
      --accent-green: #10b981;
      --accent-purple: #6366f1;
      --text-main: #f8fafc;
      --text-muted: #64748b;
      --text-sub: #94a3b8;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; }

    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(at 15% 15%, rgba(14, 165, 233, 0.08) 0px, transparent 50%),
        radial-gradient(at 85% 85%, rgba(99, 102, 241, 0.08) 0px, transparent 50%);
      color: var(--text-main);
      min-height: 100vh;
      padding-bottom: 60px;
    }

    /* Navbar */
    .navbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 18px 40px;
      background: rgba(14, 19, 31, 0.85);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--card-border);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-logo {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, #0284c7, #6366f1);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 18px;
      color: #fff;
      box-shadow: 0 0 15px rgba(2, 132, 199, 0.4);
    }

    .brand-title {
      font-weight: 800;
      font-size: 18px;
      letter-spacing: -0.4px;
      color: #fff;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.2);
      color: var(--accent-green);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
    }

    .pulse {
      width: 8px;
      height: 8px;
      background-color: var(--accent-green);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--accent-green);
      animation: pulseAnim 2s infinite;
    }

    @keyframes pulseAnim {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(1.2); }
      100% { opacity: 1; transform: scale(1); }
    }

    /* Layout Container */
    .container {
      max-width: 1400px;
      margin: 30px auto 0;
      padding: 0 30px;
    }

    #status-banner {
      margin-bottom: 20px;
      border-radius: 12px;
      font-weight: 700;
      font-size: 14px;
      text-align: center;
      transition: all 0.3s;
    }

    /* Global Settings Hero Bar */
    .hero-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 28px;
      display: grid;
      grid-template-columns: 2fr 1fr 1.2fr;
      gap: 20px;
      align-items: end;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }

    @media (max-width: 950px) {
      .hero-card { grid-template-columns: 1fr; }
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .form-label {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-sub);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .input-field, .select-field {
      width: 100%;
      background: #070a12;
      border: 1px solid var(--card-border);
      color: #fff;
      padding: 12px 16px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      outline: none;
      transition: border-color 0.2s;
    }

    .input-field:focus, .select-field:focus {
      border-color: var(--accent-cyan);
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.2);
    }

    .test-btn {
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      color: #fff;
      border: none;
      padding: 13px 20px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);
      transition: transform 0.15s, box-shadow 0.15s;
    }

    .test-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.45);
    }

    /* Pattern Cards Grid */
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 22px;
    }

    @media (max-width: 1150px) { .grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 750px) { .grid { grid-template-columns: 1fr; } }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 22px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: border-color 0.2s, box-shadow 0.2s;
      position: relative;
    }

    .card:hover {
      border-color: var(--card-hover);
      box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
    }

    .card.span-full {
      grid-column: span 3;
    }

    @media (max-width: 1150px) { .card.span-full { grid-column: span 2; } }
    @media (max-width: 750px) { .card.span-full { grid-column: span 1; } }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 14px;
    }

    .card-title {
      font-size: 15px;
      font-weight: 700;
      color: #fff;
    }

    .card-desc {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
      font-weight: 500;
    }

    /* Modern Toggle Switch */
    .switch {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
      flex-shrink: 0;
    }

    .switch input { opacity: 0; width: 0; height: 0; }

    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #1e293b;
      border: 1px solid var(--card-border);
      transition: .25s;
      border-radius: 24px;
    }

    .slider:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background-color: #64748b;
      transition: .25s;
      border-radius: 50%;
    }

    input:checked + .slider {
      background: linear-gradient(135deg, #10b981, #059669);
      border-color: #10b981;
    }

    input:checked + .slider:before {
      transform: translateX(20px);
      background-color: #fff;
    }

    /* Timeframe Selector Chips */
    .tf-chips {
      display: flex;
      gap: 6px;
      margin-top: 14px;
    }

    .chip {
      flex: 1;
      background: #070a12;
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 8px 0;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }

    .chip:hover {
      border-color: rgba(255, 255, 255, 0.2);
      color: #fff;
    }

    .chip.active {
      background: rgba(2, 132, 199, 0.15);
      border-color: var(--accent-cyan);
      color: var(--accent-cyan);
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.25);
    }

    /* FVG Min Points Panel */
    .points-panel {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px dashed var(--card-border);
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }

    @media (max-width: 750px) { .points-panel { grid-template-columns: 1fr; } }

    .points-section-title {
      font-size: 12px;
      font-weight: 700;
      color: #fbbf24;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .points-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 8px;
    }

    .points-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }

    .points-box span {
      font-size: 10px;
      font-weight: 700;
      color: var(--accent-cyan);
    }

    .points-box input {
      width: 100%;
      background: #070a12;
      border: 1px solid var(--card-border);
      color: #fff;
      padding: 7px 4px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      text-align: center;
      outline: none;
    }

    .points-box input:focus {
      border-color: var(--accent-cyan);
    }

    /* Save Bar */
    .save-bar {
      margin-top: 32px;
      display: flex;
      justify-content: flex-end;
    }

    .save-btn {
      background: linear-gradient(135deg, #10b981, #047857);
      color: #fff;
      border: none;
      padding: 16px 36px;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(16, 185, 129, 0.35);
      transition: transform 0.15s, box-shadow 0.15s;
    }

    .save-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 25px rgba(16, 185, 129, 0.5);
    }
  </style>
</head>
<body>

  <nav class="navbar">
    <div class="brand">
      <div class="brand-logo">T</div>
      <div class="brand-title">TUF Capital <span style="font-size: 12px; font-weight: 600; color: var(--text-muted);">| ICT Scanner Engine</span></div>
    </div>
    <div class="status-badge">
      <div class="pulse"></div>
      <span>24/7 Scanner Active</span>
    </div>
  </nav>

  <div class="container">
    <div id="status-banner"></div>

    <div class="hero-card">
      <div class="form-group">
        <div class="form-label">🔗 Discord Channel Webhook URL</div>
        <input type="text" id="discordWebhookUrl" class="input-field" value="${settings.discordWebhookUrl || DEFAULT_WEBHOOK}" placeholder="https://discord.com/api/webhooks/...">
      </div>

      <div class="form-group">
        <div class="form-label">🎨 Alert Chart Theme</div>
        <select id="chartTheme" class="select-field">
          <option value="light" ${chartTheme === 'light' ? 'selected' : ''}>☀️ White Theme (Clean)</option>
          <option value="dark" ${chartTheme === 'dark' ? 'selected' : ''}>🌙 Dark Theme (Clean)</option>
        </select>
      </div>

      <button type="button" class="test-btn" onclick="sendTestAlert()">
        ⚡ Send Test Alert to Discord
      </button>
    </div>

    <form id="configForm">
      <div class="grid">
        ${patterns.map(pat => {
          const pData = settings[pat.key] || { enabled: true, timeframes: [] };
          const isFvg = pat.key === 'FVG';
          return `
          <div class="card ${isFvg ? 'span-full' : ''}">
            <div>
              <div class="card-header">
                <div>
                  <div class="card-title">${pat.name}</div>
                  <div class="card-desc">${pat.desc}</div>
                </div>
                <label class="switch">
                  <input type="checkbox" id="${pat.key}_enabled" ${pData.enabled ? "checked" : ""}>
                  <span class="slider"></span>
                </label>
              </div>

              <div class="tf-chips">
                ${allTfs.map(tf => `
                  <div class="chip ${pData.timeframes.includes(tf) ? "active" : ""}" onclick="toggleTf('${pat.key}', '${tf}', this)">${tf}</div>
                `).join('')}
              </div>
            </div>

            ${isFvg ? `
            <div class="points-panel">
              <div>
                <div class="points-section-title">💱 Forex FVG Minimum Points (EURUSD, GBPUSD)</div>
                <div class="points-grid">
                  ${allTfs.map(tf => `
                    <div class="points-box">
                      <span>${tf}</span>
                      <input type="number" id="forex_fvg_min_${tf}" value="${forexMinPoints[tf] || 100}">
                    </div>
                  `).join('')}
                </div>
              </div>

              <div>
                <div class="points-section-title">🥇 Gold FVG Minimum Points (XAUUSD) ($1 = 100 pts)</div>
                <div class="points-grid">
                  ${allTfs.map(tf => `
                    <div class="points-box">
                      <span>${tf}</span>
                      <input type="number" id="gold_fvg_min_${tf}" value="${goldMinPoints[tf] || 300}">
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
            ` : ''}

          </div>`;
        }).join('')}
      </div>

      <div class="save-bar">
        <button type="submit" class="save-btn">💾 Save All Scanner Settings</button>
      </div>
    </form>
  </div>

  <script>
    const settings = ${JSON.stringify(settings)};
    const defaultWebhook = "${DEFAULT_WEBHOOK}";

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

    function toggleTf(pattern, tf, el) {
      if (!settings[pattern]) settings[pattern] = { enabled: true, timeframes: [] };
      if (!settings[pattern].timeframes) settings[pattern].timeframes = [];
      const idx = settings[pattern].timeframes.indexOf(tf);
      if (idx > -1) {
        settings[pattern].timeframes.splice(idx, 1);
        el.classList.remove('active');
      } else {
        settings[pattern].timeframes.push(tf);
        el.classList.add('active');
      }
    }

    async function sendTestAlert() {
      let webhookVal = document.getElementById('discordWebhookUrl').value.trim();
      if (!webhookVal) webhookVal = defaultWebhook;

      const themeVal = document.getElementById('chartTheme').value;
      
      localStorage.setItem('ict_discord_webhook_url', webhookVal);
      localStorage.setItem('ict_chart_theme', themeVal);

      const banner = document.getElementById('status-banner');
      banner.style.padding = '12px';
      banner.style.background = 'rgba(56, 189, 248, 0.1)';
      banner.style.border = '1px solid rgba(56, 189, 248, 0.3)';
      banner.style.color = '#38bdf8';
      banner.innerText = '⏳ Triggering TUF Capital Test Alert to Discord...';
      
      try {
        const res = await fetch('/api/test-alert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ discordWebhookUrl: webhookVal, chartTheme: themeVal })
        });

        if (res.ok) {
          banner.style.background = 'rgba(16, 185, 129, 0.1)';
          banner.style.border = '1px solid rgba(16, 185, 129, 0.3)';
          banner.style.color = '#10b981';
          banner.innerText = '✅ Test Alert Delivered Successfully to Discord!';
        } else {
          const err = await res.json();
          banner.style.background = 'rgba(239, 68, 68, 0.1)';
          banner.style.border = '1px solid rgba(239, 68, 68, 0.3)';
          banner.style.color = '#ef4444';
          banner.innerText = '❌ Delivery Failed: ' + (err.error || 'Check Discord Webhook URL');
        }
      } catch (err) {
        banner.style.background = 'rgba(239, 68, 68, 0.1)';
        banner.style.border = '1px solid rgba(239, 68, 68, 0.3)';
        banner.style.color = '#ef4444';
        banner.innerText = '❌ Network Error: ' + err.message;
      }
      setTimeout(() => { banner.innerText = ''; banner.style.padding = '0'; }, 5000);
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

      ['BOS', 'MSS', 'FVG', 'FVGFill', 'OB', 'Liquidity'].forEach(pat => {
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

      const banner = document.getElementById('status-banner');
      banner.style.padding = '12px';
      if (res.ok) {
        banner.style.background = 'rgba(16, 185, 129, 0.1)';
        banner.style.border = '1px solid rgba(16, 185, 129, 0.3)';
        banner.style.color = '#10b981';
        banner.innerText = '✅ All Settings Saved & Synchronized!';
      } else {
        banner.style.background = 'rgba(239, 68, 68, 0.1)';
        banner.style.border = '1px solid rgba(239, 68, 68, 0.3)';
        banner.style.color = '#ef4444';
        banner.innerText = '❌ Error saving settings!';
      }
      setTimeout(() => { banner.innerText = ''; banner.style.padding = '0'; }, 3000);
    };
  </script>
</body>
</html>`;
}
