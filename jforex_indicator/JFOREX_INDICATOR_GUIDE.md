# ICT Concepts Indicator for Dukascopy JForex Platform

This JForex indicator converts the **ICT Concepts Pine Script (v5)** indicator into a native Java custom indicator (`IIndicator` & `IDrawingIndicator`) for Dukascopy JForex 3 / JForex 4.

---

## 🚀 Features Converted from Pine Script

1. **Market Structure (BOS & MSS)**
   - **MSS (Market Structure Shift)**: Highlights trend direction reversals when price breaks past key swing highs/lows.
   - **BOS (Break of Structure)**: Identifies continuation trend breakouts.
   - Draws labeled horizontal lines on the chart (`BOS` dashed, `MSS` solid).

2. **Order Blocks (+OB & -OB)**
   - **Bullish Order Block (+OB)**: Identifies institutional buying zones prior to upward expansions.
   - **Bearish Order Block (-OB)**: Identifies institutional selling zones prior to downward expansions.
   - **Breakers**: Dynamic tracking when price penetrates or breaks order block boundaries.

3. **Fair Value Gaps (FVG)**
   - Translucent shaded gap boxes (Green for Bullish FVG, Red for Bearish FVG).
   - Real-time mitigation tracking: automatically changes to dashed outline when partially or fully filled by price action.

4. **Liquidity Sweeps (Buyside & Sellside)**
   - Identifies equal highs (Buyside Liquidity) and equal lows (Sellside Liquidity).
   - Generates signals when liquidity is swept/taken.

5. **Volume Imbalances (VI) & Displacement Signals**
   - Detects institutional displacement candles (candles with body sizes significantly larger than the average range).
   - Plots markers on displacement bars.

6. **Indicator Output Streams (for JForex Automated Strategies)**
   - Returns 14 output streams (BOS, MSS, FVG Top/Bottom, OB Top/Bottom, Liquidity) accessible via JForex API for automated trading strategies (`IStrategy`).

---

## 📁 Files Included

- **`jforex_indicator/ICTConceptsIndicator.java`**: Source code of the custom indicator.
- **`jforex_indicator/ICTConceptsIndicator.jfx`**: Pre-compiled JForex `.jfx` indicator package ready for instant loading in JForex.

---

## 🛠 How to Install & Use in JForex

### Method 1: Loading `ICTConceptsIndicator.jfx` (Compiled Indicator File)
1. Open **JForex 4 Platform**.
2. Open the **Navigator** pane on the left or press `Ctrl + I` (Indicators).
3. Right-click **Indicators** or **Custom Indicators** -> Click **Add Indicator...**
4. Click **Open File / Add Custom** and select `/home/tufayel/Documents/trading script/jforex_indicator/ICTConceptsIndicator.jfx` (or from `/home/tufayel/JForex4/Indicators/ICTConceptsIndicator.jfx`).
5. Click **Apply / Attach to Chart**.

### Method 2: Loading `ICTConceptsIndicator.java` (Source File)
1. In JForex, go to **Tools -> Custom Indicators** or right-click on chart -> **Add Indicator**.
2. Click **Add File** and select `/home/tufayel/Documents/trading script/jforex_indicator/ICTConceptsIndicator.java`.
3. JForex will automatically compile the indicator and open the parameter settings window.

---

## ⚙️ Configurable Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `Swing Lookback` | Integer | `5` | Pivot lookback window for swing highs/lows |
| `Show Market Structure` | Boolean | `true` | Toggle MSS and BOS lines |
| `Show Order Blocks` | Boolean | `true` | Toggle Bullish & Bearish Order Blocks |
| `Show Fair Value Gaps` | Boolean | `true` | Toggle FVG boxes & mitigation tracking |
| `Show Liquidity Sweeps` | Boolean | `true` | Toggle Buyside & Sellside Liquidity zones |
| `Show Displacement` | Boolean | `true` | Highlight institutional displacement bars |
| `Max Visible Elements` | Integer | `10` | Maximum visible visual elements per type on chart |

---

## 💡 Accessing Signals in JForex Automated Strategies (`IStrategy`)

You can call this indicator programmatically inside your JForex Java Strategy:

```java
IIndicator ictIndicator = context.getIndicatorsProvider().getIndicator("ICTConcepts");
Object[] outputs = context.getIndicatorsProvider().calculateIndicator(
    instrument, period, new OfferSide[]{OfferSide.BID}, "ICTConcepts",
    new IIndicators.AppliedPrice[]{IIndicators.AppliedPrice.CLOSE},
    new Object[]{5, true, true, true, true, true, true, 10}, 1
);

double bullBosSignal = ((double[]) outputs[0])[0];
if (!Double.isNaN(bullBosSignal)) {
    // Bullish BOS Triggered! Place Buy Order...
}
```
