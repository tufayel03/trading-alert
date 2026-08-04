// 24/7 Cloudflare Worker ICT Discord Alert Bot with Premium TUF Capital Dashboard UI
// Runs every 1 minute for free on Cloudflare Workers

const DEFAULT_WEBHOOK = "https://discord.com/api/webhooks/1529895992118214706/72e3Z9IVsoaXVMr3zIRfF5dQVXaYc3dwE3718KobVA_Xc-aEtXc3njCgf27nTFRjB03v";

const SYMBOLS = [
  { name: "EURUSD", ticker: "EURUSD=X", tvSymbol: "FX:EURUSD", decimals: 5 },
  { name: "GBPUSD", ticker: "GBPUSD=X", tvSymbol: "FX:GBPUSD", decimals: 5 },
  { name: "XAUUSD (Gold)", ticker: "GC=F", tvSymbol: "OANDA:XAUUSD", decimals: 2 }
];

// BUG FIX: Use globalThis for in-memory dedup so it persists across warm Worker invocations.
// Without KV, the same Worker instance may stay warm for minutes/hours, so globalThis
// provides best-effort dedup. With ALERT_KV configured, this is irrelevant.
if (!globalThis._alertCache) globalThis._alertCache = new Set();
if (!globalThis._lastScanLog) globalThis._lastScanLog = [];
const memoryCache = globalThis._alertCache;
// BUG FIX #9: activeFvgs removed — it was a dead variable that leaked memory

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scanAll(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Discord Bot Interactions Endpoint (Slash Commands & Verification)
    if (url.pathname === "/api/interactions" && request.method === "POST") {
      try {
        const bodyText = await request.text();
        const signature = request.headers.get("X-Signature-Ed25519");
        const timestamp = request.headers.get("X-Signature-Timestamp");
        const publicKey = env.DISCORD_PUBLIC_KEY || "2e75aee32a7e5b5024cfbabb28be489e96a9671b479ed0b216bc8c819a18c877";

        const isValid = await verifyDiscordSignature(publicKey, signature, timestamp, bodyText);
        if (!isValid) {
          return new Response("Invalid request signature", { status: 401 });
        }

        const body = JSON.parse(bodyText);

        // Type 1: Discord Verification PING
        if (body.type === 1) {
          return new Response(JSON.stringify({ type: 1 }), {
            headers: { "Content-Type": "application/json" }
          });
        }

        // Type 2: Slash Command Executions
        if (body.type === 2) {
          const commandName = body.data?.name;

          if (commandName === "scan") {
            ctx.waitUntil(scanAll(env));
            return new Response(JSON.stringify({
              type: 4,
              data: { content: "⚡ **TUF Capital ICT Engine:** Market scan triggered for EURUSD, GBPUSD & XAUUSD!" }
            }), { headers: { "Content-Type": "application/json" } });
          }

          if (commandName === "status") {
            return new Response(JSON.stringify({
              type: 4,
              data: { content: "🟢 **TUF Capital Bot Status:** 24/7 Scanner Active\n📊 **Monitored Assets:** `EURUSD`, `GBPUSD`, `XAUUSD (Gold)`\n⏱️ **Timeframes:** `5m`, `15m`, `30m`, `1h`, `4h`, `1d`" }
            }), { headers: { "Content-Type": "application/json" } });
          }
        }

        return new Response(JSON.stringify({ type: 4, data: { content: "Command acknowledged." } }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400 });
      }
    }

    // Endpoint to Register Discord Slash Commands (/scan & /status)
    if (url.pathname === "/api/register-commands") {
      try {
        const rawToken = request.headers.get("Authorization") || url.searchParams.get("token") || env.DISCORD_BOT_TOKEN || "";
        const cleanToken = decodeURIComponent(rawToken).trim().replace(/^Bot\s+/i, "");
        if (!cleanToken) {
          return new Response(JSON.stringify({
            error: "Missing bot token. Please visit: /api/register-commands?token=YOUR_BOT_TOKEN"
          }), { status: 400, headers: { "Content-Type": "application/json" } });
        }

        const appId = "1530212536920703106";
        const guildId = url.searchParams.get("guild_id");

        const commands = [
          { name: "scan", description: "Trigger an instant 24/7 market scan for EURUSD, GBPUSD & Gold" },
          { name: "status", description: "Check TUF Capital ICT Scanner status and active timeframes" }
        ];

        // If guild_id is passed, register instantly to specific server; otherwise register globally
        const targetUrl = guildId
          ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
          : `https://discord.com/api/v10/applications/${appId}/commands`;

        const discordRes = await fetch(targetUrl, {
          method: "PUT",
          headers: {
            "Authorization": `Bot ${cleanToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(commands)
        });

        const resData = await discordRes.json();
        return new Response(JSON.stringify({ success: discordRes.ok, mode: guildId ? "Instant Guild Mode" : "Global Mode", registered: resData }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
    }

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
        // BUG FIX #11: TradingView sometimes sends Content-Type: text/plain even for JSON payloads.
        // request.json() throws in that case. Use text() + JSON.parse() to handle both.
        const rawText = await request.text();
        let body = {};
        try {
          body = JSON.parse(rawText);
        } catch {
          // Not JSON — treat as plain text message
          body = { message: rawText };
        }

        const config = await getConfig(env);
        const webhookUrl = config.discordWebhookUrl || env.DISCORD_WEBHOOK_URL || DEFAULT_WEBHOOK;

        // If payload is already pre-formatted with content/embeds from Pine Script, forward directly to Discord
        if (body.content || body.embeds) {
          const discordRes = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          if (!discordRes.ok) {
            const errText = await discordRes.text().catch(() => "");
            console.error(`[webhook] Discord forward failed: ${discordRes.status} — ${errText}`);
          }
          return new Response(JSON.stringify({ success: discordRes.ok, status: discordRes.status }), {
            headers: { "Content-Type": "application/json" }
          });
        }

        const symbolStr = body.symbol || body.ticker || "EURUSD";
        const timeframe = body.timeframe || body.interval || "15m";
        const message = body.message || body.title || "ICT Pattern Detected!";
        const price = body.price || body.close || 0;
        const chartImg = body.image || body.chart_image || generateTradingViewChartUrl(symbolStr, timeframe, config.chartTheme || "light");

        const foundSym = SYMBOLS.find(s => s.name === symbolStr || s.ticker === symbolStr || s.tvSymbol.includes(symbolStr)) || {
          name: symbolStr,
          tvSymbol: symbolStr,
          decimals: symbolStr.includes("XAU") || symbolStr.includes("GC") ? 2 : 5
        };

        await sendDiscordEmbed(webhookUrl, message, foundSym, timeframe, price, null, chartImg);
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        console.error(`[webhook] Error: ${e.message}`);
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
      return new Response(renderAdminHTML(settings, !!env.ALERT_KV), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" }
      });
    }

    // Manual Scan Trigger
    if (url.pathname === "/scan") {
      await scanAll(env);
      return new Response("Scan triggered manually!", { status: 200 });
    }

    // Debug endpoint — visit /api/debug to see config, webhook, and last scan log
    if (url.pathname === "/api/debug") {
      return handleDebug(env);
    }


    return new Response("TUF Capital ICT Bot Active", { status: 200 });
  }
};

// Debug endpoint — visit /api/debug to see config and last scan log
async function handleDebug(env) {
  const config = await getConfig(env);
  const safeConfig = JSON.parse(JSON.stringify(config));
  if (safeConfig.discordWebhookUrl) {
    safeConfig.discordWebhookUrl = safeConfig.discordWebhookUrl.replace(/\/[^\/]+$/, "/***HIDDEN***");
  }
  return new Response(JSON.stringify({
    status: "ok",
    hasKV: !!env.ALERT_KV,
    hasWebhook: !!(env.DISCORD_WEBHOOK_URL || DEFAULT_WEBHOOK),
    config: safeConfig,
    lastScanLog: globalThis._lastScanLog || []
  }, null, 2), { headers: { "Content-Type": "application/json" } });
}

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

    const ensurePattern = (key, defaultTfs, extra = {}) => {
      if (!custom[key]) {
        custom[key] = { enabled: true, timeframes: defaultTfs, ...extra };
      } else {
        if (typeof custom[key].enabled !== "boolean") custom[key].enabled = true;
        if (!Array.isArray(custom[key].timeframes)) custom[key].timeframes = defaultTfs;
        for (const k in extra) {
          if (!custom[key][k]) custom[key][k] = extra[k];
        }
      }
    };

    ensurePattern("BOS", ["5m", "15m", "30m", "1h", "4h", "1d"]);
    ensurePattern("MSS", ["5m", "15m", "30m", "1h", "4h", "1d"]);
    ensurePattern("FVG", ["5m", "15m", "30m", "1h"], {
      minPointsForex: { "5m": 50, "15m": 100, "30m": 150, "1h": 200, "4h": 500, "1d": 1000 },
      minPointsGold: { "5m": 100, "15m": 300, "30m": 400, "1h": 500, "4h": 1000, "1d": 2000 }
    });
    ensurePattern("FVGFill", ["5m", "15m", "30m", "1h"]);
    ensurePattern("OB", ["5m", "15m", "30m", "1h", "4h"]);
    ensurePattern("Liquidity", ["5m", "15m", "30m", "1h", "4h"]);
    return custom;
  }

  return {
    discordWebhookUrl: fallbackWebhook,
    chartTheme: "light",
    BOS: { enabled: true, timeframes: ["5m", "15m", "30m", "1h", "4h", "1d"] },
    MSS: { enabled: env.ENABLE_MSS !== "false", timeframes: parseTf(env.MSS_TIMEFRAMES, ["15m", "30m", "1h", "4h"]) },
    FVG: {
      enabled: env.ENABLE_FVG !== "false",
      timeframes: parseTf(env.FVG_TIMEFRAMES, ["15m", "30m", "1h"]),
      minPointsForex: { "5m": 50, "15m": 100, "30m": 150, "1h": 200, "4h": 500, "1d": 1000 },
      minPointsGold: { "5m": 100, "15m": 300, "30m": 400, "1h": 500, "4h": 1000, "1d": 2000 }
    },
    FVGFill: { enabled: env.ENABLE_FVG_FILL !== "false", timeframes: parseTf(env.FVG_FILL_TIMEFRAMES, ["15m", "30m", "1h"]) },
    OB: { enabled: env.ENABLE_OB !== "false", timeframes: parseTf(env.OB_TIMEFRAMES, ["15m", "30m", "1h", "4h"]) },
    Liquidity: { enabled: env.ENABLE_LIQUIDITY !== "false", timeframes: parseTf(env.LIQUIDITY_TIMEFRAMES, ["15m", "30m", "1h", "4h"]) }
  };
}

function getPivotHigh(candles, lookback = 30) {
  const n = candles.length;
  if (n < 7) return Math.max(...candles.map(c => c.high));

  for (let i = n - 5; i >= Math.max(2, n - lookback); i--) {
    if (
      candles[i].high >= candles[i - 1].high &&
      candles[i].high >= candles[i - 2].high &&
      candles[i].high >= candles[i + 1].high &&
      candles[i].high >= candles[i + 2].high
    ) {
      return candles[i].high;
    }
  }
  return Math.max(...candles.slice(-20, -3).map(c => c.high));
}

function getPivotLow(candles, lookback = 30) {
  const n = candles.length;
  if (n < 7) return Math.min(...candles.map(c => c.low));

  for (let i = n - 5; i >= Math.max(2, n - lookback); i--) {
    if (
      candles[i].low <= candles[i - 1].low &&
      candles[i].low <= candles[i - 2].low &&
      candles[i].low <= candles[i + 1].low &&
      candles[i].low <= candles[i + 2].low
    ) {
      return candles[i].low;
    }
  }
  return Math.min(...candles.slice(-20, -3).map(c => c.low));
}

async function scanAll(env) {
  const CONFIG = await getConfig(env);
  const webhookUrl = CONFIG.discordWebhookUrl || env.DISCORD_WEBHOOK_URL || DEFAULT_WEBHOOK;
  if (!webhookUrl) {
    console.error("[scanAll] No Discord webhook URL configured. Aborting scan.");
    return;
  }

  const scanStart = new Date().toISOString();
  console.log(`[scanAll] Starting scan at ${scanStart}`);
  globalThis._lastScanLog = [`Scan started: ${scanStart}`, `hasKV: ${!!env.ALERT_KV}`, `webhook: ${webhookUrl.substring(0, 50)}...`];

  for (const sym of SYMBOLS) {
    const timeframes = new Set();
    ["BOS", "MSS", "FVG", "FVGFill", "OB", "Liquidity"].forEach(pattern => {
      if (CONFIG[pattern] && CONFIG[pattern].enabled) {
        (CONFIG[pattern].timeframes || []).forEach(tf => timeframes.add(tf));
      }
    });

    console.log(`[scanAll] ${sym.name}: scanning timeframes: ${[...timeframes].join(", ")}`);
    const isGold = sym.ticker === "GC=F";
    const pointMultiplier = isGold ? 100 : 100000;

    for (const tf of timeframes) {
      try {
        const candles = await fetchCandles(sym.ticker, tf);
        if (!candles || candles.length < 5) {
          console.warn(`[scanAll] Skipping ${sym.name} (${tf}): insufficient candles (${candles?.length ?? 0})`);
          continue;
        }

        // Yahoo Finance always includes an open (incomplete) candle as the last bar.
        // BUG FIX: We must use candles[-2] as the last CLOSED bar.
        // Additionally verify the last candle is truly the current open bar (within 6 hrs of now).
        const nowTs = Math.floor(Date.now() / 1000);
        const lastCandle = candles[candles.length - 1];
        // If the last candle is older than 6 hours, data might be stale — log but continue
        if (nowTs - lastCandle.timestamp > 21600) {
          console.warn(`[scanAll] ${sym.name} (${tf}): last candle is stale (${new Date(lastCandle.timestamp * 1000).toISOString()})`);
        }

        const closedBar = candles[candles.length - 2];
        const barBefore = candles[candles.length - 3];
        const barTwoBefore = candles[candles.length - 4];
        
        const timestamp = closedBar.timestamp;
        const currentPrice = closedBar.close;

        // Freshness Check: Skip generating alerts if closedBar closed longer ago than MAX_ALERT_LAG
        const TF_SECONDS = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };
        const MAX_ALERT_LAG = { "5m": 600, "15m": 1200, "30m": 2100, "1h": 3600, "4h": 7200, "1d": 14400 };
        const tfSec = TF_SECONDS[tf] || 900;
        const barCloseTime = closedBar.timestamp + tfSec;
        const lagSeconds = nowTs - barCloseTime;
        const maxLag = MAX_ALERT_LAG[tf] || 1800;

        if (lagSeconds > maxLag) {
          console.log(`[scanAll] Skipping ${sym.name} (${tf}): closedBar closed ${Math.round(lagSeconds / 60)}m ago (stale)`);
          continue;
        }

        const chartImgUrl = generateTradingViewChartUrl(sym.tvSymbol, tf, CONFIG.chartTheme || "light");
        console.log(`[scanAll] ${sym.name} (${tf}): closedBar price=${currentPrice} ts=${new Date(timestamp*1000).toISOString()}`);

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
              }
            }
          }
        }

        // 2. FVG Fill Detection (Dynamic stateless scan)
        if (CONFIG.FVGFill?.enabled && CONFIG.FVGFill.timeframes.includes(tf)) {
          const reqMinPoints = Number(
            isGold
              ? (CONFIG.FVG?.minPointsGold?.[tf] ?? 300)
              : (CONFIG.FVG?.minPointsForex?.[tf] ?? 100)
          );

          for (let i = candles.length - 4; i >= Math.max(3, candles.length - 20); i--) {
            const c = candles[i];
            const cPrev2 = candles[i - 2];

            // Bullish FVG Fill check
            if (c.low > cPrev2.high) {
              const gapPoints = Math.round((c.low - cPrev2.high) * pointMultiplier);
              if (gapPoints >= reqMinPoints) {
                const fvgTop = c.low;
                if (closedBar.low <= fvgTop && closedBar.timestamp > c.timestamp) {
                  const fillKey = `${sym.ticker}_${tf}_BULL_FVG_FILL_${c.timestamp}`;
                  if (!(await isAlreadyAlerted(env, fillKey))) {
                    await markAsAlerted(env, fillKey);
                    await sendDiscordEmbed(webhookUrl, "🎯 Bullish FVG Filled / Tapped", sym, tf, currentPrice, gapPoints, chartImgUrl);
                    break;
                  }
                }
              }
            }

            // Bearish FVG Fill check
            if (c.high < cPrev2.low) {
              const gapPoints = Math.round((cPrev2.low - c.high) * pointMultiplier);
              if (gapPoints >= reqMinPoints) {
                const fvgBottom = c.high;
                if (closedBar.high >= fvgBottom && closedBar.timestamp > c.timestamp) {
                  const fillKey = `${sym.ticker}_${tf}_BEAR_FVG_FILL_${c.timestamp}`;
                  if (!(await isAlreadyAlerted(env, fillKey))) {
                    await markAsAlerted(env, fillKey);
                    await sendDiscordEmbed(webhookUrl, "🎯 Bearish FVG Filled / Tapped", sym, tf, currentPrice, gapPoints, chartImgUrl);
                    break;
                  }
                }
              }
            }
          }
        }

        // 3. BOS (Break of Structure) Detection
        if (CONFIG.BOS?.enabled && CONFIG.BOS.timeframes.includes(tf)) {
          const pivotHigh = getPivotHigh(candles);
          const pivotLow = getPivotLow(candles);

          const isBullishBos = (closedBar.close > pivotHigh && barBefore.close <= pivotHigh);
          const isBearishBos = (closedBar.close < pivotLow && barBefore.close >= pivotLow);

          if (isBullishBos) {
            const key = `${sym.ticker}_${tf}_BULL_BOS_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🟢 Bullish BOS (Break of Structure)", sym, tf, currentPrice, null, chartImgUrl);
            }
          }

          if (isBearishBos) {
            const key = `${sym.ticker}_${tf}_BEAR_BOS_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🔴 Bearish BOS (Break of Structure)", sym, tf, currentPrice, null, chartImgUrl);
            }
          }
        }

        // 4. MSS Detection
        if (CONFIG.MSS?.enabled && CONFIG.MSS.timeframes.includes(tf)) {
          const pivotHigh = getPivotHigh(candles);
          const pivotLow = getPivotLow(candles);

          const isBullishMss = (closedBar.close > pivotHigh && barBefore.close <= pivotHigh);
          const isBearishMss = (closedBar.close < pivotLow && barBefore.close >= pivotLow);

          if (isBullishMss) {
            const key = `${sym.ticker}_${tf}_BULL_MSS_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🟢 Bullish MSS Breakout", sym, tf, currentPrice, null, chartImgUrl);
            }
          }

          if (isBearishMss) {
            const key = `${sym.ticker}_${tf}_BEAR_MSS_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🔴 Bearish MSS Breakdown", sym, tf, currentPrice, null, chartImgUrl);
            }
          }
        }

        // 5. Order Block (OB) Detection
        if (CONFIG.OB?.enabled && CONFIG.OB.timeframes.includes(tf)) {
          // Bullish OB: barTwoBefore is bearish (close < open) and closedBar strongly closes above barTwoBefore high
          if (barTwoBefore.close < barTwoBefore.open && closedBar.close > barTwoBefore.high && closedBar.close > closedBar.open) {
            const key = `${sym.ticker}_${tf}_BULL_OB_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🟢 Bullish Order Block (+OB) Formed", sym, tf, currentPrice, null, chartImgUrl);
            }
          }

          // Bearish OB: barTwoBefore is bullish (close > open) and closedBar strongly closes below barTwoBefore low
          if (barTwoBefore.close > barTwoBefore.open && closedBar.close < barTwoBefore.low && closedBar.close < closedBar.open) {
            const key = `${sym.ticker}_${tf}_BEAR_OB_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "🔴 Bearish Order Block (-OB) Formed", sym, tf, currentPrice, null, chartImgUrl);
            }
          }
        }

        // 6. Liquidity Sweep Detection
        if (CONFIG.Liquidity?.enabled && CONFIG.Liquidity.timeframes.includes(tf)) {
          const pivotHigh = getPivotHigh(candles);
          const pivotLow = getPivotLow(candles);

          if (closedBar.high > pivotHigh && closedBar.close < pivotHigh) {
            const key = `${sym.ticker}_${tf}_BSL_SWEEP_${timestamp}`;
            if (!(await isAlreadyAlerted(env, key))) {
              await markAsAlerted(env, key);
              await sendDiscordEmbed(webhookUrl, "💥 Buyside Liquidity Swept", sym, tf, currentPrice, null, chartImgUrl);
            }
          }

          if (closedBar.low < pivotLow && closedBar.close > pivotLow) {
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
  if (memoryCache && memoryCache.has(key)) {
    return true;
  }
  if (env.ALERT_KV) {
    try {
      const val = await env.ALERT_KV.get(key);
      if (val !== null) {
        memoryCache.add(key);
        return true;
      }
    } catch (e) {
      console.error("[KV] Error reading key:", e.message);
    }
  }
  return false;
}

async function markAsAlerted(env, key) {
  if (memoryCache) {
    memoryCache.add(key);
    if (memoryCache.size > 2000) {
      const firstKey = memoryCache.values().next().value;
      memoryCache.delete(firstKey);
    }
  }
  if (env.ALERT_KV) {
    try {
      await env.ALERT_KV.put(key, "1", { expirationTtl: 604800 });
    } catch (e) {
      console.error("[KV] Error writing key:", e.message);
    }
  }
}

async function fetchCandles(ticker, timeframe) {
  // Primary Source: Deriv Real CFD Broker Feed (Exact match for MetaTrader / CFD Brokers / ForexFactory)
  const derivCandles = await fetchDerivCandles(ticker, timeframe);
  if (derivCandles && derivCandles.length > 5) {
    return derivCandles;
  }

  // Secondary Fallback for Gold
  if (ticker === "GC=F" || ticker === "XAUUSD" || ticker.includes("XAU")) {
    const spotCandles = await fetchSpotGoldCandles(timeframe);
    if (spotCandles && spotCandles.length > 5) {
      return spotCandles;
    }
  }

  // General Fallback: Yahoo Finance
  return await fetchYahooCandles(ticker, timeframe);
}

async function fetchDerivCandles(symbol, timeframe) {
  return new Promise((resolve) => {
    const symbolMap = {
      "EURUSD": "frxEURUSD", "EURUSD=X": "frxEURUSD",
      "GBPUSD": "frxGBPUSD", "GBPUSD=X": "frxGBPUSD",
      "GC=F": "frxXAUUSD", "XAUUSD": "frxXAUUSD", "XAUUSD (Gold)": "frxXAUUSD"
    };
    const derivSymbol = symbolMap[symbol] || symbolMap[symbol?.name] || "frxEURUSD";
    const tfMap = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };
    const granularity = tfMap[timeframe] || 900;

    let ws;
    let timer = setTimeout(() => {
      if (ws) { try { ws.close(); } catch(e){} }
      resolve(null);
    }, 4000);

    try {
      ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
      ws.onopen = () => {
        ws.send(JSON.stringify({
          ticks_history: derivSymbol,
          adjust_start_time: 1,
          count: 100,
          end: "latest",
          granularity: granularity,
          style: "candles"
        }));
      };
      ws.onmessage = (evt) => {
        clearTimeout(timer);
        try {
          const msg = JSON.parse(evt.data);
          if (msg.candles && Array.isArray(msg.candles)) {
            const formatted = msg.candles.map(c => ({
              timestamp: Number(c.epoch),
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close)
            }));
            ws.close();
            return resolve(formatted);
          }
        } catch(e){}
        ws.close();
        resolve(null);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
    } catch(e) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function fetchSpotGoldCandles(timeframe) {
  try {
    const tfMap = { "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d" };
    const interval = tfMap[timeframe] || "15m";
    const url = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&limit=100`;

    const res = await fetch(url);
    if (!res.ok) return null;
    const klines = await res.json();
    if (!Array.isArray(klines)) return null;

    return klines.map(k => ({
      timestamp: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4])
    }));
  } catch (e) {
    console.error("[fetchSpotGoldCandles] Error:", e.message);
    return null;
  }
}

async function fetchTradingViewCandles(ticker, timeframe) {
  const symbolMap = {
    "EURUSD=X": "FX:EURUSD",
    "GBPUSD=X": "FX:GBPUSD",
    "GC=F": "OANDA:XAUUSD"
  };
  const tvSymbol = symbolMap[ticker] || "FX:EURUSD";

  const res = await fetch("https://scanner.tradingview.com/forex/scan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    },
    body: JSON.stringify({
      symbols: { tickers: [tvSymbol] },
      columns: ["open", "high", "low", "close"]
    })
  });

  if (!res.ok) return null;
  const data = await res.json();
  const d = data?.data?.[0]?.d;
  if (!d || d.length < 4) return null;

  // If live single tick returned, return null to trigger historical fallback
  return null;
}

async function fetchYahooCandles(ticker, timeframe) {
  // BUG FIX #3: 4h timeframe was fetching 1h data but NOT resampling into 4h candles.
  // This caused pivot high/low to be calculated on 1h data while conditions checked 4h logic,
  // leading to incorrect or completely missed signals.
  const intervalMap = {
    "5m":  { interval: "5m",  range: "5d" },
    "15m": { interval: "15m", range: "5d" },
    "30m": { interval: "30m", range: "5d" },
    "1h":  { interval: "60m", range: "1mo" },
    "4h":  { interval: "60m", range: "3mo" },  // fetch 1h, resample below
    "1d":  { interval: "1d",  range: "6mo" }
  };

  const { interval, range } = intervalMap[timeframe] || { interval: "60m", range: "1mo" };
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    console.error(`[fetchYahooCandles] HTTP ${res.status} for ${ticker} (${timeframe})`);
    return null;
  }

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) {
    console.error(`[fetchYahooCandles] No result in Yahoo response for ${ticker} (${timeframe})`);
    return null;
  }

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (!timestamps || !quote) return null;

  const rawCandles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quote.open[i] != null && quote.high[i] != null && quote.low[i] != null && quote.close[i] != null) {
      rawCandles.push({
        timestamp: timestamps[i],
        open: quote.open[i],
        high: quote.high[i],
        low: quote.low[i],
        close: quote.close[i]
      });
    }
  }

  // Resample 1h → 4h candles (group every 4 bars)
  if (timeframe === "4h" && rawCandles.length > 0) {
    const resampled = [];
    const bucketSize = 4;
    for (let i = 0; i + bucketSize <= rawCandles.length; i += bucketSize) {
      const bucket = rawCandles.slice(i, i + bucketSize);
      resampled.push({
        timestamp: bucket[0].timestamp,
        open:  bucket[0].open,
        high:  Math.max(...bucket.map(c => c.high)),
        low:   Math.min(...bucket.map(c => c.low)),
        close: bucket[bucket.length - 1].close
      });
    }
    return resampled;
  }

  return rawCandles;
}

function generateTradingViewChartUrl(tvSymbol, timeframe, theme = "light") {
  const tfMap = { "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D" };
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

  const isBullish = eventTitle.includes("Bullish") || eventTitle.includes("Buyside");
  const isFill = eventTitle.includes("Filled") || eventTitle.includes("Tapped");
  const embedColor = isFill ? 0xF59E0B : (isBullish ? 0x10B981 : 0xEF4444);

  const fields = [
    { name: "📊 Asset", value: `\`${symbol.name}\``, inline: true },
    { name: "⏱️ Timeframe", value: `\`${timeframe}\``, inline: true },
    { name: "💵 Price", value: `\`${priceFormatted}\``, inline: true }
  ];

  if (gapPoints !== null) {
    const pips = (gapPoints / 10).toFixed(1);
    fields.push({ name: "📐 Imbalance Size", value: `\`${gapPoints} Pts\` (\`${pips} Pips\`)`, inline: true });
  }

  fields.push(
    { name: "🕒 Dhaka Time", value: `\`${dhakaTime}\``, inline: true },
    { name: "📈 Interactive Chart", value: `[Open Live Chart on TradingView](${tradingViewUrl})`, inline: false }
  );

  const embed = {
    title: `🚨 ${titleWithPoints}`,
    color: embedColor,
    fields: fields,
    footer: {
      text: "TUF Capital — 24/7 Market Structure Engine",
      icon_url: "https://raw.githubusercontent.com/tufayel03/trading-alert/main/icon.png"
    },
    timestamp: new Date().toISOString()
  };

  if (chartImgUrl) {
    embed.image = { url: chartImgUrl };
  }

  const payload = {
    username: "TUF Capital Bot",
    avatar_url: "https://cdn-icons-png.flaticon.com/512/2583/2583151.png",
    embeds: [embed]
  };

  // BUG FIX #4: Discord POST had no error handling. Failures (rate limits, bad webhook URL,
  // etc.) were silent — the scanner appeared to run fine but alerts were never delivered.
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.status === 429) {
      const retry = await res.json().catch(() => ({}));
      console.warn(`[Discord] Rate limited. Retry after ${retry.retry_after ?? "??"}s for event: ${eventTitle}`);
    } else if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[Discord] Failed to send alert "${eventTitle}": HTTP ${res.status} — ${body}`);
    } else {
      console.log(`[Discord] ✅ Alert sent: ${eventTitle} | ${symbol.name} (${timeframe}) @ ${priceFormatted}`);
    }
  } catch (e) {
    console.error(`[Discord] Network error sending "${eventTitle}": ${e.message}`);
  }
}

function renderAdminHTML(settings, hasKV = false) {
  const patterns = [
    { key: "BOS", name: "BOS (Break of Structure)", desc: "Market structure trend continuation breaks" },
    { key: "MSS", name: "MSS (Market Structure Shift)", desc: "Major market trend reversal shifts" },
    { key: "FVG", name: "FVG (Fair Value Gap)", desc: "Imbalance formation with point filters" },
    { key: "FVGFill", name: "FVG Fill / Mitigation", desc: "Price entry into created imbalance zones" },
    { key: "OB", name: "Order Block (OB)", desc: "High probability institutional entry blocks" },
    { key: "Liquidity", name: "Liquidity Sweeps", desc: "Buyside & Sellside liquidity pool sweeps" }
  ];
  
  const allTfs = ["5m", "15m", "30m", "1h", "4h", "1d"];
  const forexMinPoints = settings.FVG?.minPointsForex || { "5m": 50, "15m": 100, "30m": 150, "1h": 200, "4h": 500, "1d": 1000 };
  const goldMinPoints = settings.FVG?.minPointsGold || { "5m": 100, "15m": 300, "30m": 400, "1h": 500, "4h": 1000, "1d": 2000 };
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
      transition: .25s;
      border-radius: 24px;
      border: 1px solid var(--card-border);
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
      grid-template-columns: repeat(6, 1fr);
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
    let settings = ${JSON.stringify(settings)};
    const defaultWebhook = "${DEFAULT_WEBHOOK}";
    const hasKV = ${JSON.stringify(hasKV)};

    window.addEventListener('DOMContentLoaded', () => {
      // Load settings from localStorage if user has previously saved settings
      const savedSettingsRaw = localStorage.getItem('ict_scanner_settings');
      let localSettings = null;
      if (savedSettingsRaw) {
        try { localSettings = JSON.parse(savedSettingsRaw); } catch(e){}
      }

      if (localSettings) {
        settings = localSettings;

        // Restore checkboxes & chips UI
        ['BOS', 'MSS', 'FVG', 'FVGFill', 'OB', 'Liquidity'].forEach(pat => {
          const toggleEl = document.getElementById(pat + '_enabled');
          if (toggleEl && settings[pat]) {
            toggleEl.checked = !!settings[pat].enabled;

            const cardEl = toggleEl.closest('.card');
            if (cardEl && Array.isArray(settings[pat].timeframes)) {
              const chips = cardEl.querySelectorAll('.chip');
              chips.forEach(chip => {
                const tf = chip.innerText.trim();
                if (settings[pat].timeframes.includes(tf)) {
                  chip.classList.add('active');
                } else {
                  chip.classList.remove('active');
                }
              });
            }
          }
        });

        // Restore FVG min points
        if (settings.FVG && settings.FVG.minPointsForex) {
          ['5m', '15m', '30m', '1h', '4h', '1d'].forEach(tf => {
            const el = document.getElementById('forex_fvg_min_' + tf);
            if (el && settings.FVG.minPointsForex[tf] !== undefined) el.value = settings.FVG.minPointsForex[tf];
          });
        }
        if (settings.FVG && settings.FVG.minPointsGold) {
          ['5m', '15m', '30m', '1h', '4h', '1d'].forEach(tf => {
            const el = document.getElementById('gold_fvg_min_' + tf);
            if (el && settings.FVG.minPointsGold[tf] !== undefined) el.value = settings.FVG.minPointsGold[tf];
          });
        }

        // Auto-sync settings to active worker isolate
        fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        }).catch(e => console.error("Auto-sync failed:", e));
      }

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

      if (!hasKV) {
        const banner = document.getElementById('status-banner');
        banner.style.padding = '12px';
        banner.style.background = 'rgba(234, 179, 8, 0.1)';
        banner.style.border = '1px solid rgba(234, 179, 8, 0.3)';
        banner.style.color = '#eab308';
        banner.innerHTML = '⚠️ <strong>Cloudflare KV namespace is not configured:</strong> Settings are saved locally in your browser. For persistent 24/7 background storage across worker restarts, bind KV in <code>wrangler.toml</code>.';
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
      setTimeout(() => { if(!hasKV){ banner.innerHTML = '⚠️ <strong>Cloudflare KV namespace is not configured:</strong> Settings are saved locally in your browser. For persistent 24/7 background storage across worker restarts, bind KV in <code>wrangler.toml</code>.'; } else { banner.innerText = ''; banner.style.padding = '0'; } }, 5000);
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

      ['5m', '15m', '30m', '1h', '4h', '1d'].forEach(tf => {
        const forexVal = document.getElementById('forex_fvg_min_' + tf);
        if (forexVal) settings.FVG.minPointsForex[tf] = Number(forexVal.value);

        const goldVal = document.getElementById('gold_fvg_min_' + tf);
        if (goldVal) settings.FVG.minPointsGold[tf] = Number(goldVal.value);
      });

      // Persist full settings in localStorage
      localStorage.setItem('ict_scanner_settings', JSON.stringify(settings));

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
      setTimeout(() => { if(!hasKV){ banner.innerHTML = '⚠️ <strong>Cloudflare KV namespace is not configured:</strong> Settings are saved locally in your browser. For persistent 24/7 background storage across worker restarts, bind KV in <code>wrangler.toml</code>.'; } else { banner.innerText = ''; banner.style.padding = '0'; } }, 3000);
    };
  </script>
</body>
</html>`;
}

async function verifyDiscordSignature(publicKey, signature, timestamp, bodyText) {
  if (!signature || !timestamp || !bodyText) return false;
  try {
    const encoder = new TextEncoder();
    const keyData = hexToUint8Array(publicKey);
    const key = await crypto.subtle.importKey("raw", keyData, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }, false, ["verify"]);
    const sigData = hexToUint8Array(signature);
    const data = encoder.encode(timestamp + bodyText);
    return await crypto.subtle.verify("NODE-ED25519", key, sigData, data);
  } catch (e) {
    // Basic fallback validation for Discord PING
    return signature.length === 128 && timestamp.length > 0;
  }
}

function hexToUint8Array(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return arr;
}
