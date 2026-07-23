# 🚀 24/7 Instant ICT Discord Alert Bot (Free Cloud Deployment)

An automated, cloud-based ICT (Inner Circle Trader) scanner that monitors **EURUSD**, **GBPUSD**, and **XAUUSD (Gold)** 24/7 for:
- 🟢/🔴 **Fair Value Gaps (FVG)**
- 🟢/🔴 **Market Structure Shifts (MSS)**
- 🟢/🔴 **Order Blocks (OB)**
- 💥 **Liquidity Sweeps (Buyside & Sellside)**

And sends live **Discord Alerts with dark-theme candlestick chart previews** in **real-time**!

---

## 📌 Features
- 📊 **Monitored Pairs**: **EURUSD**, **GBPUSD**, and **XAUUSD (Gold)**.
- ⚡ **INSTANT Alerts**: Continuous 30-second live loop for 0-delay notifications.
- 🖼️ **Embedded Chart Previews**: Automatically generates and attaches a dark-mode candlestick chart preview directly inside Discord.
- 🆓 **100% Free Hosting**: Ready for **Render.com** (Free Forever) or **GitHub Actions**.

---

## ⚡ Option A: Deploy on Render.com (Recommended for INSTANT Real-Time Alerts)

1. Push this folder to a new **GitHub Repository** named `ict-discord-bot`.
2. Go to [Render.com](https://render.com) and sign in with GitHub.
3. Click **New +** $\rightarrow$ Select **Web Service**.
4. Connect your `ict-discord-bot` repository.
5. Set the following settings:
   - **Name**: `ict-discord-bot`
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `python ict_bot.py`
6. Scroll down to **Environment Variables** $\rightarrow$ Add Variable:
   - **Key**: `DISCORD_WEBHOOK_URL`
   - **Value**: *(Paste your Discord Webhook URL)*
7. Click **Create Web Service**.

#### 🕒 Keep-Alive Setup (To run 24/7 with zero sleeping):
1. Copy your Render web service URL (e.g. `https://ict-discord-bot.onrender.com`).
2. Go to free [UptimeRobot.com](https://uptimerobot.com) or [cron-job.org](https://cron-job.org).
3. Add an HTTP monitor targeting your Render URL every 5 minutes.
4. **Done! Your bot now runs 24/7/365 with INSTANT Discord alerts for FREE!**

---

## 🐙 Option B: Deploy on GitHub Actions

1. Push this folder to a GitHub repository.
2. In your GitHub repo, go to **Settings** $\rightarrow$ **Secrets and variables** $\rightarrow$ **Actions**.
3. Add a secret named `DISCORD_WEBHOOK_URL` with your Discord Webhook URL.
4. Go to **Actions** tab and enable the workflow!
