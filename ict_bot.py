import os
import json
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone
import requests
import pandas as pd
import numpy as np
import yfinance as yf
import mplfinance as mpf

STATE_FILE = "alert_state.json"
CONFIG_FILE = "config.json"

# Lightweight Keep-Alive HTTP Health Server for Render 24/7 Uptime
class HealthCheckHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ICT Discord Bot is running 24/7!")

def start_health_server():
    port = int(os.environ.get("PORT", 8080))
    server = HTTPServer(("0.0.0.0", port), HealthCheckHandler)
    print(f"🌐 Keep-Alive Web Server started on port {port}")
    server.serve_forever()

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
    else:
        config = {
            "discord_webhook_url": "ENV_DISCORD_WEBHOOK_URL",
            "symbols": [
                {"name": "EURUSD", "ticker": "EURUSD=X"},
                {"name": "GBPUSD", "ticker": "GBPUSD=X"},
                {"name": "XAUUSD (Gold)", "ticker": "GC=F"}
            ],
            "settings": {
                "BOS": {"enabled": True, "timeframes": ["5m", "15m", "30m", "1h", "4h", "1d"]},
                "MSS": {"enabled": True, "timeframes": ["5m", "15m", "30m", "1h", "4h", "1d"]},
                "FVG": {"enabled": True, "timeframes": ["5m", "15m", "30m", "1h", "4h", "1d"]},
                "OB": {"enabled": True, "timeframes": ["5m", "15m", "30m", "1h", "4h", "1d"]},
                "Liquidity": {"enabled": True, "timeframes": ["5m", "15m", "30m", "1h", "4h", "1d"]}
            }
        }
    
    env_url = os.environ.get("DISCORD_WEBHOOK_URL")
    if env_url:
        config["discord_webhook_url"] = env_url
        
    return config

def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_state(state):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        print(f"Error saving state: {e}")

def fetch_candle_data(ticker, timeframe):
    """Fetches candlestick data for the specified timeframe."""
    tf_map = {
        "5m": ("5m", "5d"),
        "15m": ("15m", "7d"),
        "30m": ("30m", "7d"),
        "1h": ("60m", "1mo"),
        "4h": ("60m", "3mo"),
        "1d": ("1d", "6mo")
    }
    
    interval, period = tf_map.get(timeframe, ("60m", "1mo"))
    df = yf.download(ticker, period=period, interval=interval, progress=False)
    
    if df.empty:
        return None

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df = df[['Open', 'High', 'Low', 'Close', 'Volume']].dropna()

    if timeframe == "4h":
        df = df.resample('4h').agg({
            'Open': 'first',
            'High': 'max',
            'Low': 'min',
            'Close': 'last',
            'Volume': 'sum'
        }).dropna()

    return df

def generate_chart_image(df, title, filename="chart.png"):
    """Generates a dark-mode candlestick chart image."""
    recent_df = df.tail(40)
    
    mc = mpf.make_marketcolors(
        up='#00e6a1', down='#e60400',
        edge='inherit', wick='inherit',
        volume='#2157f3'
    )
    style = mpf.make_mpf_style(
        base_mpf_style='nightclouds',
        marketcolors=mc,
        gridstyle=':',
        facecolor='#131722',
        figcolor='#131722'
    )
    
    mpf.plot(
        recent_df,
        type='candle',
        style=style,
        title=dict(title=title, color='#ffffff', fontsize=14),
        savefig=dict(fname=filename, dpi=120, bbox_inches='tight'),
        volume=False
    )
    return filename

def send_discord_alert(webhook_url, event_title, symbol_name, timeframe, price, chart_file):
    """Sends a rich embed message with attached chart preview to Discord."""
    if not webhook_url or webhook_url == "ENV_DISCORD_WEBHOOK_URL":
        print(f"⚠️ [ALERT TRIGGERED] {event_title} on {symbol_name} ({timeframe}) at price {price:.2f} (Paste Webhook URL in config.json or environment!)")
        return

    embed = {
        "title": f"🚨 {event_title}",
        "description": f"**Symbol:** `{symbol_name}`\n**Timeframe:** `{timeframe}`\n**Current Price:** `{price:.4f}`\n**Time:** `{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}`",
        "color": 65280 if "Bullish" in event_title or "Taken" in event_title else 16711680,
        "image": {"url": "attachment://chart.png"},
        "footer": {"text": "ICT Concepts 24/7 Scanner"}
    }
    
    payload = {"embeds": [embed]}
    
    try:
        with open(chart_file, "rb") as f:
            files = {
                "payload_json": (None, json.dumps(payload), "application/json"),
                "file": ("chart.png", f, "image/png")
            }
            res = requests.post(webhook_url, files=files)
            if res.status_code in [200, 204]:
                print(f"✅ Discord alert sent: {event_title} on {symbol_name} ({timeframe})")
            else:
                print(f"❌ Discord alert failed: {res.status_code} - {res.text}")
    except Exception as e:
        print(f"Error posting alert to Discord: {e}")

def scan_symbol(symbol_info, config, state):
    name = symbol_info["name"]
    ticker = symbol_info["ticker"]
    settings = config["settings"]
    webhook_url = config["discord_webhook_url"]

    all_tfs = set()
    for pattern, pdata in settings.items():
        if pdata.get("enabled"):
            all_tfs.update(pdata.get("timeframes", []))

    for tf in all_tfs:
        try:
            df = fetch_candle_data(ticker, tf)
            if df is None or len(df) < 5:
                continue

            latest_idx = df.index[-1]
            price = df['Close'].iloc[-1]
            timestamp_str = str(latest_idx)

            # 1. FVG Detection
            if settings.get("FVG", {}).get("enabled") and tf in settings["FVG"].get("timeframes", []):
                low_curr = df['Low'].iloc[-1]
                high_prev2 = df['High'].iloc[-3]
                if low_curr > high_prev2:
                    alert_key = f"{ticker}_{tf}_BULL_FVG_{timestamp_str}"
                    if not state.get(alert_key):
                        chart = generate_chart_image(df, f"🟢 Bullish FVG - {name} ({tf})")
                        send_discord_alert(webhook_url, "🟢 Bullish FVG Formed", name, tf, price, chart)
                        state[alert_key] = True

                high_curr = df['High'].iloc[-1]
                low_prev2 = df['Low'].iloc[-3]
                if high_curr < low_prev2:
                    alert_key = f"{ticker}_{tf}_BEAR_FVG_{timestamp_str}"
                    if not state.get(alert_key):
                        chart = generate_chart_image(df, f"🔴 Bearish FVG - {name} ({tf})")
                        send_discord_alert(webhook_url, "🔴 Bearish FVG Formed", name, tf, price, chart)
                        state[alert_key] = True

            # 2. BOS Detection
            if settings.get("BOS", {}).get("enabled") and tf in settings["BOS"].get("timeframes", []):
                highs = df['High']
                lows = df['Low']
                closes = df['Close']
                
                swing_high = highs.iloc[-15:-3].max()
                swing_low = lows.iloc[-15:-3].min()

                if closes.iloc[-1] > swing_high and closes.iloc[-2] <= swing_high:
                    alert_key = f"{ticker}_{tf}_BULL_BOS_{timestamp_str}"
                    if not state.get(alert_key):
                        chart = generate_chart_image(df, f"🟢 Bullish BOS - {name} ({tf})")
                        send_discord_alert(webhook_url, "🟢 Bullish BOS (Break of Structure)", name, tf, price, chart)
                        state[alert_key] = True

                if closes.iloc[-1] < swing_low and closes.iloc[-2] >= swing_low:
                    alert_key = f"{ticker}_{tf}_BEAR_BOS_{timestamp_str}"
                    if not state.get(alert_key):
                        chart = generate_chart_image(df, f"🔴 Bearish BOS - {name} ({tf})")
                        send_discord_alert(webhook_url, "🔴 Bearish BOS (Break of Structure)", name, tf, price, chart)
                        state[alert_key] = True

            # 3. MSS Detection
            if settings.get("MSS", {}).get("enabled") and tf in settings["MSS"].get("timeframes", []):
                highs = df['High']
                lows = df['Low']
                closes = df['Close']
                
                swing_high = highs.iloc[-15:-3].max()
                swing_low = lows.iloc[-15:-3].min()

                if closes.iloc[-1] > swing_high and closes.iloc[-2] <= swing_high:
                    alert_key = f"{ticker}_{tf}_BULL_MSS_{timestamp_str}"
                    if not state.get(alert_key):
                        chart = generate_chart_image(df, f"🟢 Bullish MSS - {name} ({tf})")
                        send_discord_alert(webhook_url, "🟢 Bullish MSS Breakout", name, tf, price, chart)
                        state[alert_key] = True

                if closes.iloc[-1] < swing_low and closes.iloc[-2] >= swing_low:
                    alert_key = f"{ticker}_{tf}_BEAR_MSS_{timestamp_str}"
                    if not state.get(alert_key):
                        chart = generate_chart_image(df, f"🔴 Bearish MSS - {name} ({tf})")
                        send_discord_alert(webhook_url, "🔴 Bearish MSS Breakdown", name, tf, price, chart)
                        state[alert_key] = True

            # 3. Liquidity Sweep Detection
            if settings.get("Liquidity", {}).get("enabled") and tf in settings["Liquidity"].get("timeframes", []):
                swing_high = df['High'].iloc[-15:-2].max()
                swing_low = df['Low'].iloc[-15:-2].min()

                if df['High'].iloc[-1] > swing_high and df['Close'].iloc[-1] < swing_high:
                    alert_key = f"{ticker}_{tf}_BSL_SWEEP_{timestamp_str}"
                    if not state.get(alert_key):
                        chart = generate_chart_image(df, f"💥 Buyside Liquidity Swept - {name} ({tf})")
                        send_discord_alert(webhook_url, "💥 Buyside Liquidity Swept", name, tf, price, chart)
                        state[alert_key] = True

                if df['Low'].iloc[-1] < swing_low and df['Close'].iloc[-1] > swing_low:
                    alert_key = f"{ticker}_{tf}_SSL_SWEEP_{timestamp_str}"
                    if not state.get(alert_key):
                        chart = generate_chart_image(df, f"💥 Sellside Liquidity Swept - {name} ({tf})")
                        send_discord_alert(webhook_url, "💥 Sellside Liquidity Swept", name, tf, price, chart)
                        state[alert_key] = True

            # 5. Order Block (OB) Detection
            if settings.get("OB", {}).get("enabled") and tf in settings["OB"].get("timeframes", []):
                open_2b = df['Open'].iloc[-3]
                close_2b = df['Close'].iloc[-3]
                high_2b = df['High'].iloc[-3]
                low_2b = df['Low'].iloc[-3]

                curr_open = df['Open'].iloc[-1]
                curr_close = df['Close'].iloc[-1]

                if close_2b < open_2b and curr_close > high_2b and curr_close > curr_open:
                    alert_key = f"{ticker}_{tf}_BULL_OB_{timestamp_str}"
                    if not state.get(alert_key):
                        chart = generate_chart_image(df, f"🟢 Bullish OB - {name} ({tf})")
                        send_discord_alert(webhook_url, "🟢 Bullish Order Block (+OB) Formed", name, tf, price, chart)
                        state[alert_key] = True

                if close_2b > open_2b and curr_close < low_2b and curr_close < curr_open:
                    alert_key = f"{ticker}_{tf}_BEAR_OB_{timestamp_str}"
                    if not state.get(alert_key):
                        chart = generate_chart_image(df, f"🔴 Bearish OB - {name} ({tf})")
                        send_discord_alert(webhook_url, "🔴 Bearish Order Block (-OB) Formed", name, tf, price, chart)
                        state[alert_key] = True

            # 6. FVG Fill Detection
            if settings.get("FVGFill", {}).get("enabled") and tf in settings["FVGFill"].get("timeframes", []):
                for i in range(len(df) - 4, max(2, len(df) - 15), -1):
                    low_c = df['Low'].iloc[i]
                    high_prev2 = df['High'].iloc[i - 2]
                    if low_c > high_prev2:
                        if df['Low'].iloc[-1] <= low_c:
                            alert_key = f"{ticker}_{tf}_BULL_FVG_FILL_{str(df.index[i])}"
                            if not state.get(alert_key):
                                chart = generate_chart_image(df, f"🎯 Bullish FVG Filled - {name} ({tf})")
                                send_discord_alert(webhook_url, "🎯 Bullish FVG Filled / Tapped", name, tf, price, chart)
                                state[alert_key] = True
                                break

                    high_c = df['High'].iloc[i]
                    low_prev2 = df['Low'].iloc[i - 2]
                    if high_c < low_prev2:
                        if df['High'].iloc[-1] >= high_c:
                            alert_key = f"{ticker}_{tf}_BEAR_FVG_FILL_{str(df.index[i])}"
                            if not state.get(alert_key):
                                chart = generate_chart_image(df, f"🎯 Bearish FVG Filled - {name} ({tf})")
                                send_discord_alert(webhook_url, "🎯 Bearish FVG Filled / Tapped", name, tf, price, chart)
                                state[alert_key] = True
                                break

        except Exception as e:
            print(f"Error scanning {name} ({tf}): {e}")

def run_once():
    config = load_config()
    state = load_state()
    for symbol in config["symbols"]:
        scan_symbol(symbol, config, state)
    save_state(state)

def main():
    print("🚀 Starting 24/7 ICT Scanner for EURUSD, GBPUSD, and XAUUSD...")
    
    # Start Keep-Alive HTTP health server in background thread for Render
    server_thread = threading.Thread(target=start_health_server, daemon=True)
    server_thread.start()

    # Check mode: Continuous loop (for Render/Server) or Single run (for GitHub Actions)
    continuous_mode = os.environ.get("CONTINUOUS_MODE", "true").lower() == "true"

    if continuous_mode:
        print("🔁 Continuous 24/7 Real-Time Loop Active (Scanning every 30 seconds)...")
        while True:
            try:
                run_once()
            except Exception as e:
                print(f"Loop iteration error: {e}")
            time.sleep(30)
    else:
        print("⏱️ Single Scan Mode Active.")
        run_once()

if __name__ == "__main__":
    main()
