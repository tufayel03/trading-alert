# ⚡ 24/7 Cloudflare Worker ICT Discord Alert Bot (1-Minute Scan)

An ultra-fast, serverless ICT Market Scanner that runs **every 1 minute** on Cloudflare's global edge network completely **FREE forever**.

Monitors **EURUSD**, **GBPUSD**, and **XAUUSD (Gold)** for:
- 🟢/🔴 **Fair Value Gaps (FVG)**
- 🟢/🔴 **Market Structure Shifts (MSS)**
- 🟢/🔴 **Order Blocks (OB)**
- 💥 **Liquidity Sweeps (Buyside & Sellside)**

And sends **Discord Alerts with live dark-mode candlestick chart embeds**!

---

## 🛠️ Step-by-Step 2-Minute Deployment Guide

### Option 1: Deploy using Wrangler CLI (Recommended)

1. Open your terminal in this directory:
   ```bash
   npx wrangler login
   ```
   *(A browser window will open. Click **Allow** to log into your free Cloudflare account).*

2. Add your Discord Webhook URL secret:
   ```bash
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```
   *(Paste your Discord Webhook URL when prompted).*

3. Deploy the worker:
   ```bash
   npx wrangler deploy
   ```

**🎉 That's it! Your Cloudflare Worker is now live and will automatically run every 1 minute 24/7 forever!**

---

### Option 2: Deploy directly via Cloudflare Dashboard (No CLI needed!)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and log in.
2. Click **Workers & Pages** $\rightarrow$ **Create Application** $\rightarrow$ **Create Worker**.
3. Name it `ict-discord-worker` and click **Deploy**.
4. Click **Edit Code**.
5. Copy all content from `src/index.js` in this folder, paste it into the Cloudflare online code editor, and click **Save and Deploy**.
6. Go back to your Worker settings:
   - Go to **Settings** $\rightarrow$ **Variables** $\rightarrow$ **Environment Variables**.
   - Add Variable: Name = `DISCORD_WEBHOOK_URL`, Value = *(Your Webhook URL)*. Click **Encrypt** & **Save**.
   - Go to **Triggers** $\rightarrow$ **Cron Triggers** $\rightarrow$ Add Trigger: `* * * * *` (Every minute).

**Done!**
