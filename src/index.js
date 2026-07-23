// 24/7 Cloudflare Worker ICT Discord Alert Bot
// Runs every 1 minute for free on Cloudflare Workers

const SYMBOLS = [
  { name: "EURUSD", ticker: "EURUSD=X", tvSymbol: "FX_IDC:EURUSD" },
  { name: "GBPUSD", ticker: "GBPUSD=X", tvSymbol: "FX_IDC:GBPUSD" },
  { name: "XAUUSD (Gold)", ticker: "GC=F", tvSymbol: "OANDA:XAUUSD" }
];

const CONFIG = {
  MSS: { enabled: true, timeframes: ["1h", "4h"] },
  FVG: { enabled: true, timeframes: ["15m", "1h"] },
  OB: { enabled: true, timeframes: ["1h", "4h"] },
  Liquidity: { enabled: true, timeframes: ["15m", "1h", "4h"] }
};

// In-memory state cache
const alertedKeys = new Set();

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scanAll(env));
  },

  async fetch(request, env, ctx) {
    await scanAll(env);
    return new Response("ICT Cloudflare Worker Scanner executed successfully!", { status: 200 });
  }
};

async function scanAll(env) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("No DISCORD_WEBHOOK_URL configured in Cloudflare Worker environment.");
    return;
  }

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

        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const prev2 = candles[candles.length - 3];
        const timestamp = last.timestamp;
        const currentPrice = last.close;

        // 1. FVG Detection
        if (CONFIG.FVG.enabled && CONFIG.FVG.timeframes.includes(tf)) {
          // Bullish FVG: Low[i] > High[i-2]
          if (last.low > prev2.high) {
            const key = `${sym.ticker}_${tf}_BULL_FVG_${timestamp}`;
            if (!alertedKeys.has(key)) {
              alertedKeys.add(key);
              await sendDiscordEmbed(webhookUrl, "🟢 Bullish FVG Formed", sym, tf, currentPrice);
            }
          }
          // Bearish FVG: High[i] < Low[i-2]
          if (last.high < prev2.low) {
            const key = `${sym.ticker}_${tf}_BEAR_FVG_${timestamp}`;
            if (!alertedKeys.has(key)) {
              alertedKeys.add(key);
              await sendDiscordEmbed(webhookUrl, "🔴 Bearish FVG Formed", sym, tf, currentPrice);
            }
          }
        }

        // 2. MSS Detection
        if (CONFIG.MSS.enabled && CONFIG.MSS.timeframes.includes(tf)) {
          const recentHighs = candles.slice(-10, -2).map(c => c.high);
          const recentLows = candles.slice(-10, -2).map(c => c.low);
          const swingHigh = Math.max(...recentHighs);
          const swingLow = Math.min(...recentLows);

          // Bullish MSS
          if (last.close > swingHigh && prev.close <= swingHigh) {
            const key = `${sym.ticker}_${tf}_BULL_MSS_${timestamp}`;
            if (!alertedKeys.has(key)) {
              alertedKeys.add(key);
              await sendDiscordEmbed(webhookUrl, "🟢 Bullish MSS Breakout", sym, tf, currentPrice);
            }
          }

          // Bearish MSS
          if (last.close < swingLow && prev.close >= swingLow) {
            const key = `${sym.ticker}_${tf}_BEAR_MSS_${timestamp}`;
            if (!alertedKeys.has(key)) {
              alertedKeys.add(key);
              await sendDiscordEmbed(webhookUrl, "🔴 Bearish MSS Breakdown", sym, tf, currentPrice);
            }
          }
        }

        // 3. Liquidity Sweep Detection
        if (CONFIG.Liquidity.enabled && CONFIG.Liquidity.timeframes.includes(tf)) {
          const recentHighs = candles.slice(-15, -2).map(c => c.high);
          const recentLows = candles.slice(-15, -2).map(c => c.low);
          const swingHigh = Math.max(...recentHighs);
          const swingLow = Math.min(...recentLows);

          if (last.high > swingHigh && last.close < swingHigh) {
            const key = `${sym.ticker}_${tf}_BSL_SWEEP_${timestamp}`;
            if (!alertedKeys.has(key)) {
              alertedKeys.add(key);
              await sendDiscordEmbed(webhookUrl, "💥 Buyside Liquidity Swept", sym, tf, currentPrice);
            }
          }

          if (last.low < swingLow && last.close > swingLow) {
            const key = `${sym.ticker}_${tf}_SSL_SWEEP_${timestamp}`;
            if (!alertedKeys.has(key)) {
              alertedKeys.add(key);
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

async function fetchCandles(ticker, timeframe) {
  const intervalMap = {
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
  const chartImgUrl = `https://api.chart-img.com/v2/tradingview/advanced-chart?symbol=${encodeURIComponent(symbol.tvSymbol)}&interval=${timeframe}&theme=dark`;

  const embed = {
    title: `🚨 ${eventTitle}`,
    description: `**Symbol:** \`${symbol.name}\`\n**Timeframe:** \`${timeframe}\`\n**Current Price:** \`${price.toFixed(4)}\`\n**Time:** \`${new Date().toISOString().replace('T', ' ').substring(0, 16)} UTC\``,
    color: eventTitle.includes("Bullish") || eventTitle.includes("Taken") ? 0x00E6A1 : 0xE60400,
    image: { url: chartImgUrl },
    footer: { text: "Cloudflare Worker 1-Min ICT Scanner" }
  };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] })
  });
}
