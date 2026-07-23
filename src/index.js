// 24/7 Cloudflare Worker ICT Discord Alert Bot (Environment Configurable)
// Runs every 1 minute for free on Cloudflare Workers

const SYMBOLS = [
  { name: "EURUSD", ticker: "EURUSD=X", tvSymbol: "FX:EURUSD", decimals: 5 },
  { name: "GBPUSD", ticker: "GBPUSD=X", tvSymbol: "FX:GBPUSD", decimals: 5 },
  { name: "XAUUSD (Gold)", ticker: "GC=F", tvSymbol: "OANDA:XAUUSD", decimals: 2 }
];

const memoryCache = new Set();

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scanAll(env));
  },

  async fetch(request, env, ctx) {
    await scanAll(env);
    return new Response("ICT Cloudflare Worker Scanner executed successfully!", { status: 200 });
  }
};

function getConfig(env) {
  const parseTf = (envVal, defaultArray) => {
    if (!envVal) return defaultArray;
    return envVal.split(",").map(s => s.trim());
  };

  return {
    MSS: {
      enabled: env.ENABLE_MSS !== "false",
      timeframes: parseTf(env.MSS_TIMEFRAMES, ["1h", "4h"])
    },
    FVG: {
      enabled: env.ENABLE_FVG !== "false",
      timeframes: parseTf(env.FVG_TIMEFRAMES, ["15m", "1h"])
    },
    OB: {
      enabled: env.ENABLE_OB !== "false",
      timeframes: parseTf(env.OB_TIMEFRAMES, ["1h", "4h"])
    },
    Liquidity: {
      enabled: env.ENABLE_LIQUIDITY !== "false",
      timeframes: parseTf(env.LIQUIDITY_TIMEFRAMES, ["15m", "1h", "4h"])
    }
  };
}

async function scanAll(env) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("No DISCORD_WEBHOOK_URL configured in Cloudflare Worker environment.");
    return;
  }

  const CONFIG = getConfig(env);

  for (const sym of SYMBOLS) {
    const timeframes = new Set([
      ...CONFIG.MSS.timeframes,
      ...CONFIG.FVG.timeframes,
      ...CONFIG.OB.timeframes,
      ...CONFIG.Liquidity.timeframes
    ]);

    for (const tf of timeframes) {
      try {
        const candles = await fetchCandles(sym.ticker, tf);
        if (!candles || candles.length < 5) continue;

        const closedBar = candles[candles.length - 2];
        const barBefore = candles[candles.length - 3];
        const barTwoBefore = candles[candles.length - 4];
        
        const timestamp = closedBar.timestamp;
        const currentPrice = closedBar.close;

        // 1. FVG Detection
        if (CONFIG.FVG.enabled && CONFIG.FVG.timeframes.includes(tf)) {
          if (closedBar.low > barTwoBefore.high) {
            const key = `${sym.ticker}_${tf}_BULL_FVG_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🟢 Bullish FVG Formed", sym, tf, currentPrice);
            }
          }
          if (closedBar.high < barTwoBefore.low) {
            const key = `${sym.ticker}_${tf}_BEAR_FVG_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🔴 Bearish FVG Formed", sym, tf, currentPrice);
            }
          }
        }

        // 2. MSS Detection
        if (CONFIG.MSS.enabled && CONFIG.MSS.timeframes.includes(tf)) {
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

        // 3. Liquidity Sweep Detection
        if (CONFIG.Liquidity.enabled && CONFIG.Liquidity.timeframes.includes(tf)) {
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

async function sendDiscordEmbed(webhookUrl, eventTitle, symbol, timeframe, price) {
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

  const embed = {
    title: `🚨 ${eventTitle}`,
    description: `**Symbol:** \`${symbol.name}\`\n**Timeframe:** \`${timeframe}\`\n**Current Price:** \`${priceFormatted}\`\n**Time (Dhaka):** \`${dhakaTime}\`\n\n📈 [Open Live Chart on TradingView](${tradingViewUrl})`,
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
