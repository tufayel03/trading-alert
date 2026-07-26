package com.dukascopy.indicators;

import com.dukascopy.api.IBar;
import com.dukascopy.api.indicators.*;

import java.awt.*;
import java.util.*;
import java.util.List;

/**
 * ICT Concepts Indicator for Dukascopy JForex Platform.
 * Converts Pine Script ICT Concepts to native JForex Java indicator.
 *
 * Features: MSS, BOS, Order Blocks, Fair Value Gaps, Liquidity Sweeps.
 */
public class ICTConceptsIndicator implements IIndicator, IDrawingIndicator {

    // ── Inner data classes ──────────────────────────────────────────────────

    public static class SwingPoint {
        public int index; public long time; public double price;
        public boolean isHigh; public boolean crossed;
        SwingPoint(int i, long t, double p, boolean h) { index=i; time=t; price=p; isHigh=h; }
    }

    public static class StructureLine {
        public long startTime, endTime; public double price;
        public String label; public boolean isBullish;
        StructureLine(long s, long e, double p, String l, boolean b) { startTime=s; endTime=e; price=p; label=l; isBullish=b; }
    }

    public static class FVGBox {
        public long startTime, endTime; public double top, bottom;
        public boolean isBullish, active;
        FVGBox(long s, long e, double t, double b, boolean bull) { startTime=s; endTime=e; top=t; bottom=b; isBullish=bull; active=true; }
    }

    public static class OrderBlockBox {
        public long startTime, endTime; public double top, bottom;
        public boolean isBullish, active;
        OrderBlockBox(long s, long e, double t, double b, boolean bull) { startTime=s; endTime=e; top=t; bottom=b; isBullish=bull; active=true; }
    }

    public static class LiquidityZone {
        public long startTime, endTime; public double top, bottom; public boolean isBuyside;
        LiquidityZone(long s, long e, double t, double b, boolean buy) { startTime=s; endTime=e; top=t; bottom=b; isBuyside=buy; }
    }

    // ── Fields ──────────────────────────────────────────────────────────────

    private IIndicatorContext context;
    private IndicatorInfo indicatorInfo;
    private InputParameterInfo[]    inputParameterInfos;
    private OptInputParameterInfo[] optInputParameterInfos;
    private OutputParameterInfo[]   outputParameterInfos;

    // Inputs
    private final IBar[][] inputs = new IBar[1][];
    // Outputs (14 double arrays)
    private final double[][] outputs = new double[14][];

    // User parameters
    private int     swingLength        = 5;
    private boolean showMarketStructure = true;
    private boolean showOrderBlocks     = true;
    private boolean showFVG             = true;
    private boolean showLiquidity       = true;
    private boolean showDisplacement    = true;
    private int     maxItems            = 10;

    // Drawing lists (populated in calculate, read in drawOutput)
    private final List<StructureLine>  structureLines  = new ArrayList<>();
    private final List<FVGBox>         fvgBoxes        = new ArrayList<>();
    private final List<OrderBlockBox>  orderBlockBoxes = new ArrayList<>();
    private final List<LiquidityZone>  liquidityZones  = new ArrayList<>();
    private final List<Long>           displacementTimes = new ArrayList<>();

    // ── Constructor + metadata ───────────────────────────────────────────────

    public ICTConceptsIndicator() { initMetadata(); }

    private void initMetadata() {
        indicatorInfo = new IndicatorInfo(
            "ICTConcepts", "ICT Concepts", "Custom",
            true,   // isOverChart
            false,  // isOverVolumes
            false,  // isUnstablePeriod
            1,      // numberOfInputs
            6,      // numberOfOptionalInputs
            14);    // numberOfOutputs
        indicatorInfo.setRecalculateAll(true);
        indicatorInfo.setSparseIndicator(true);

        inputParameterInfos = new InputParameterInfo[]{
            new InputParameterInfo("Bars", InputParameterInfo.Type.BAR)
        };

        optInputParameterInfos = new OptInputParameterInfo[]{
            new OptInputParameterInfo("Swing Lookback",         OptInputParameterInfo.Type.OTHER, new IntegerRangeDescription(5, 3, 50, 1)),
            new OptInputParameterInfo("Market Structure",       OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Order Blocks",           OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Fair Value Gaps",        OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Liquidity Sweeps",       OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Max Visible Elements",   OptInputParameterInfo.Type.OTHER, new IntegerRangeDescription(10, 2, 50, 1))
        };

        outputParameterInfos = new OutputParameterInfo[]{
            makeOut("Bullish BOS",       OutputParameterInfo.DrawingStyle.DOTS),
            makeOut("Bearish BOS",       OutputParameterInfo.DrawingStyle.DOTS),
            makeOut("Bullish MSS",       OutputParameterInfo.DrawingStyle.DOTS),
            makeOut("Bearish MSS",       OutputParameterInfo.DrawingStyle.DOTS),
            makeOut("Bull FVG Top",      OutputParameterInfo.DrawingStyle.LINE),
            makeOut("Bull FVG Bottom",   OutputParameterInfo.DrawingStyle.LINE),
            makeOut("Bear FVG Top",      OutputParameterInfo.DrawingStyle.LINE),
            makeOut("Bear FVG Bottom",   OutputParameterInfo.DrawingStyle.LINE),
            makeOut("Bull OB Top",       OutputParameterInfo.DrawingStyle.LINE),
            makeOut("Bull OB Bottom",    OutputParameterInfo.DrawingStyle.LINE),
            makeOut("Bear OB Top",       OutputParameterInfo.DrawingStyle.LINE),
            makeOut("Bear OB Bottom",    OutputParameterInfo.DrawingStyle.LINE),
            makeOut("Buyside Liq",       OutputParameterInfo.DrawingStyle.LINE),
            makeOut("Sellside Liq",      OutputParameterInfo.DrawingStyle.LINE),
        };
    }

    private OutputParameterInfo makeOut(String name, OutputParameterInfo.DrawingStyle style) {
        OutputParameterInfo p = new OutputParameterInfo(name, OutputParameterInfo.Type.DOUBLE, style);
        p.setDrawnByIndicator(true);
        return p;
    }

    // ── IIndicator interface ─────────────────────────────────────────────────

    @Override public void onStart(IIndicatorContext ctx) { this.context = ctx; }
    @Override public IndicatorInfo getIndicatorInfo() { return indicatorInfo; }
    @Override public InputParameterInfo    getInputParameterInfo(int i)    { return (i<inputParameterInfos.length)    ? inputParameterInfos[i]    : null; }
    @Override public OptInputParameterInfo getOptInputParameterInfo(int i) { return (i<optInputParameterInfos.length) ? optInputParameterInfos[i] : null; }
    @Override public OutputParameterInfo   getOutputParameterInfo(int i)   { return (i<outputParameterInfos.length)   ? outputParameterInfos[i]   : null; }

    @Override public void setInputParameter(int i, Object o)    { inputs[i]  = (IBar[]) o; }
    @Override public void setOutputParameter(int i, Object o)   { outputs[i] = (double[]) o; }

    @Override
    public void setOptInputParameter(int i, Object o) {
        switch (i) {
            case 0: swingLength         = (Integer) o; break;
            case 1: showMarketStructure = (Boolean) o; break;
            case 2: showOrderBlocks     = (Boolean) o; break;
            case 3: showFVG             = (Boolean) o; break;
            case 4: showLiquidity       = (Boolean) o; break;
            case 5: maxItems            = (Integer) o; break;
        }
    }

    @Override public int getLookback()   { return swingLength * 2 + 5; }
    @Override public int getLookforward() { return 0; }

    // ── calculate ────────────────────────────────────────────────────────────

    @Override
    public IndicatorResult calculate(int startIndex, int endIndex) {
        if (inputs[0] == null) return new IndicatorResult(0, 0);

        // Guarantee we have enough lookback
        int lb = getLookback();
        if (startIndex < lb) startIndex = lb;
        if (startIndex > endIndex) return new IndicatorResult(0, 0);

        IBar[] bars = inputs[0];
        int totalBars = bars.length;
        if (endIndex >= totalBars) endIndex = totalBars - 1;
        if (startIndex > endIndex) return new IndicatorResult(0, 0);

        // Clear all output buffers
        int outLen = endIndex - startIndex + 1;
        for (double[] out : outputs) {
            if (out != null) Arrays.fill(out, 0, Math.min(out.length, outLen), Double.NaN);
        }

        // Clear drawing lists — rebuild from scratch each full recalculate
        structureLines.clear();
        fvgBoxes.clear();
        orderBlockBoxes.clear();
        liquidityZones.clear();
        displacementTimes.clear();

        List<SwingPoint> swingHighs = new ArrayList<>();
        List<SwingPoint> swingLows  = new ArrayList<>();
        int trendDir = 0; // 1=bull, -1=bear

        double sumBody = 0; int nBody = 0;

        // Scan ALL bars from beginning for structure, draw only visible range
        // We need full history for proper swing detection
        int scanStart = swingLength * 2;
        if (scanStart >= totalBars) return new IndicatorResult(startIndex, outLen);

        for (int i = scanStart; i < totalBars; i++) {
            IBar bar = bars[i];
            double body = Math.abs(bar.getClose() - bar.getOpen());
            sumBody += body; nBody++;
            double avgBody = sumBody / nBody;

            // 1. Pivot detection (pivot is at i - swingLength)
            int pivotIdx = i - swingLength;
            boolean isPH = true, isPL = true;
            for (int k = pivotIdx - swingLength; k <= pivotIdx + swingLength; k++) {
                if (k == pivotIdx || k < 0 || k >= totalBars) continue;
                if (bars[k].getHigh() >= bars[pivotIdx].getHigh()) isPH = false;
                if (bars[k].getLow()  <= bars[pivotIdx].getLow())  isPL = false;
            }
            if (isPH) swingHighs.add(new SwingPoint(pivotIdx, bars[pivotIdx].getTime(), bars[pivotIdx].getHigh(), true));
            if (isPL) swingLows .add(new SwingPoint(pivotIdx, bars[pivotIdx].getTime(), bars[pivotIdx].getLow(),  false));

            // 2. Market Structure (MSS / BOS)
            if (showMarketStructure && !swingHighs.isEmpty() && !swingLows.isEmpty()) {
                SwingPoint lastH = swingHighs.get(swingHighs.size()-1);
                SwingPoint lastL = swingLows .get(swingLows .size()-1);

                // Bullish breakout
                if (bar.getClose() > lastH.price && !lastH.crossed) {
                    lastH.crossed = true;
                    String label = (trendDir <= 0) ? "MSS" : "BOS";
                    boolean wasMSS = trendDir <= 0;
                    trendDir = 1;
                    structureLines.add(new StructureLine(lastH.time, bar.getTime(), lastH.price, label, true));

                    // Write to output buffer (only if in calculate range)
                    int op = i - startIndex;
                    if (op >= 0 && op < outLen) {
                        if (wasMSS && outputs[2] != null) outputs[2][op] = bar.getClose();
                        else if (!wasMSS && outputs[0] != null) outputs[0][op] = bar.getClose();
                    }

                    // Order Block (+OB): lowest candle between lastH and breakout
                    if (showOrderBlocks && lastH.index < i) {
                        int obIdx = lastH.index; double obLow = bars[lastH.index].getLow(), obHigh = bars[lastH.index].getHigh();
                        for (int k = lastH.index; k < i; k++) {
                            if (bars[k].getLow() < obLow) { obLow = bars[k].getLow(); obHigh = bars[k].getHigh(); obIdx = k; }
                        }
                        orderBlockBoxes.add(new OrderBlockBox(bars[obIdx].getTime(), bar.getTime(), obHigh, obLow, true));
                    }
                }

                // Bearish breakout
                if (bar.getClose() < lastL.price && !lastL.crossed) {
                    lastL.crossed = true;
                    String label = (trendDir >= 0) ? "MSS" : "BOS";
                    boolean wasMSS = trendDir >= 0;
                    trendDir = -1;
                    structureLines.add(new StructureLine(lastL.time, bar.getTime(), lastL.price, label, false));

                    int op = i - startIndex;
                    if (op >= 0 && op < outLen) {
                        if (wasMSS && outputs[3] != null) outputs[3][op] = bar.getClose();
                        else if (!wasMSS && outputs[1] != null) outputs[1][op] = bar.getClose();
                    }

                    // Order Block (-OB): highest candle between lastL and breakout
                    if (showOrderBlocks && lastL.index < i) {
                        int obIdx = lastL.index; double obHigh = bars[lastL.index].getHigh(), obLow = bars[lastL.index].getLow();
                        for (int k = lastL.index; k < i; k++) {
                            if (bars[k].getHigh() > obHigh) { obHigh = bars[k].getHigh(); obLow = bars[k].getLow(); obIdx = k; }
                        }
                        orderBlockBoxes.add(new OrderBlockBox(bars[obIdx].getTime(), bar.getTime(), obHigh, obLow, false));
                    }
                }
            }

            // 3. Fair Value Gaps
            if (showFVG && i >= 2) {
                IBar b0 = bars[i-2], b2 = bar;
                if (b2.getLow() > b0.getHigh()) { // Bullish FVG
                    FVGBox fvg = new FVGBox(b0.getTime(), bar.getTime(), b2.getLow(), b0.getHigh(), true);
                    fvgBoxes.add(fvg);
                    int op = i - startIndex;
                    if (op >= 0 && op < outLen) {
                        if (outputs[4] != null) outputs[4][op] = fvg.top;
                        if (outputs[5] != null) outputs[5][op] = fvg.bottom;
                    }
                }
                if (b2.getHigh() < b0.getLow()) { // Bearish FVG
                    FVGBox fvg = new FVGBox(b0.getTime(), bar.getTime(), b0.getLow(), b2.getHigh(), false);
                    fvgBoxes.add(fvg);
                    int op = i - startIndex;
                    if (op >= 0 && op < outLen) {
                        if (outputs[6] != null) outputs[6][op] = fvg.top;
                        if (outputs[7] != null) outputs[7][op] = fvg.bottom;
                    }
                }
                // Mitigation check
                for (FVGBox f : fvgBoxes) {
                    if (!f.active) continue;
                    if (f.isBullish && bar.getLow() < f.bottom)  { f.active = false; f.endTime = bar.getTime(); }
                    if (!f.isBullish && bar.getHigh() > f.top)  { f.active = false; f.endTime = bar.getTime(); }
                }
            }

            // 4. Liquidity Zones
            if (showLiquidity) {
                if (swingHighs.size() >= 2) {
                    SwingPoint h1 = swingHighs.get(swingHighs.size()-1);
                    SwingPoint h2 = swingHighs.get(swingHighs.size()-2);
                    double thr = h1.price * 0.0005;
                    if (Math.abs(h1.price - h2.price) <= thr) {
                        liquidityZones.add(new LiquidityZone(h2.time, bar.getTime(),
                            Math.max(h1.price,h2.price)+thr, Math.min(h1.price,h2.price)-thr, true));
                    }
                    int op = i - startIndex;
                    if (op >= 0 && op < outLen && bar.getHigh() > h1.price && outputs[12] != null)
                        outputs[12][op] = bar.getHigh();
                }
                if (swingLows.size() >= 2) {
                    SwingPoint l1 = swingLows.get(swingLows.size()-1);
                    SwingPoint l2 = swingLows.get(swingLows.size()-2);
                    double thr = l1.price * 0.0005;
                    if (Math.abs(l1.price - l2.price) <= thr) {
                        liquidityZones.add(new LiquidityZone(l2.time, bar.getTime(),
                            Math.max(l1.price,l2.price)+thr, Math.min(l1.price,l2.price)-thr, false));
                    }
                    int op = i - startIndex;
                    if (op >= 0 && op < outLen && bar.getLow() < l1.price && outputs[13] != null)
                        outputs[13][op] = bar.getLow();
                }
            }

            // 5. Displacement
            if (body > avgBody * 1.8) displacementTimes.add(bar.getTime());
        }

        return new IndicatorResult(startIndex, outLen);
    }

    // ── IDrawingIndicator.drawOutput ─────────────────────────────────────────

    @Override
    public Point drawOutput(Graphics g, int outputIdx, Object buffer, Color color, Stroke stroke,
                            IIndicatorDrawingSupport ds, List<Shape> shapes, Map<Color, List<Point>> elements) {
        if (g == null || ds == null) return null;

        // Draw on output index 0 only — avoids duplicate painting for all 14 outputs
        if (outputIdx != 0) return null;

        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

        try {
            drawFVGs(g2, ds);
            drawOrderBlocks(g2, ds);
            drawStructureLines(g2, ds);
            drawLiquidityZones(g2, ds);
        } finally {
            g2.dispose();
        }
        return null;
    }

    private void drawFVGs(Graphics2D g2, IIndicatorDrawingSupport ds) {
        if (!showFVG) return;
        int count = 0;
        for (int i = fvgBoxes.size()-1; i >= 0 && count < maxItems; i--, count++) {
            FVGBox f = fvgBoxes.get(i);
            int x1 = ds.getXForTime(f.startTime);
            int x2 = f.active ? ds.getChartWidth() : ds.getXForTime(f.endTime);
            int y1 = (int) ds.getYForValue(f.top);
            int y2 = (int) ds.getYForValue(f.bottom);
            int w = Math.max(x2 - x1, 6), h = Math.abs(y2 - y1), ty = Math.min(y1, y2);
            Color fill   = f.isBullish ? new Color(0, 200, 100, 45)  : new Color(220, 50, 50, 45);
            Color border = f.isBullish ? new Color(0, 200, 100, 200) : new Color(220, 50, 50, 200);
            g2.setColor(fill);   g2.fillRect(x1, ty, w, h);
            g2.setColor(border);
            g2.setStroke(f.active ? new BasicStroke(1f) : new BasicStroke(1f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER, 4f, new float[]{4f,3f}, 0f));
            g2.drawRect(x1, ty, w, h);
            g2.setFont(new Font("SansSerif", Font.BOLD, 9));
            g2.drawString(f.isBullish ? "FVG+" : "FVG-", x1+3, ty+11);
        }
    }

    private void drawOrderBlocks(Graphics2D g2, IIndicatorDrawingSupport ds) {
        if (!showOrderBlocks) return;
        int count = 0;
        for (int i = orderBlockBoxes.size()-1; i >= 0 && count < maxItems; i--, count++) {
            OrderBlockBox ob = orderBlockBoxes.get(i);
            int x1 = ds.getXForTime(ob.startTime);
            int x2 = ob.active ? ds.getChartWidth() : ds.getXForTime(ob.endTime);
            int y1 = (int) ds.getYForValue(ob.top);
            int y2 = (int) ds.getYForValue(ob.bottom);
            int w = Math.max(x2-x1, 8), h = Math.abs(y2-y1), ty = Math.min(y1,y2);
            Color fill   = ob.isBullish ? new Color(30, 120, 255, 50)  : new Color(255, 40, 40, 50);
            Color border = ob.isBullish ? new Color(30, 120, 255, 220) : new Color(255, 40, 40, 220);
            g2.setColor(fill);   g2.fillRect(x1, ty, w, h);
            g2.setColor(border); g2.setStroke(new BasicStroke(1.5f));
            g2.drawRect(x1, ty, w, h);
            g2.setFont(new Font("SansSerif", Font.BOLD, 10));
            g2.drawString(ob.isBullish ? "+OB" : "-OB", x1+4, ty+13);
        }
    }

    private void drawStructureLines(Graphics2D g2, IIndicatorDrawingSupport ds) {
        if (!showMarketStructure) return;
        int count = 0;
        for (int i = structureLines.size()-1; i >= 0 && count < maxItems*2; i--, count++) {
            StructureLine sl = structureLines.get(i);
            int x1 = ds.getXForTime(sl.startTime);
            int x2 = ds.getXForTime(sl.endTime);
            int y  = (int) ds.getYForValue(sl.price);
            Color c = sl.isBullish ? new Color(0, 220, 150) : new Color(220, 50, 50);
            g2.setColor(c);
            if ("MSS".equals(sl.label)) g2.setStroke(new BasicStroke(2f));
            else g2.setStroke(new BasicStroke(1f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER, 4f, new float[]{4f,3f}, 0f));
            g2.drawLine(x1, y, x2, y);
            g2.setFont(new Font("SansSerif", Font.BOLD, 10));
            g2.setStroke(new BasicStroke(1f));
            g2.drawString(sl.label, (x1+x2)/2-10, sl.isBullish ? y-3 : y+12);
        }
    }

    private void drawLiquidityZones(Graphics2D g2, IIndicatorDrawingSupport ds) {
        if (!showLiquidity) return;
        int count = 0;
        for (int i = liquidityZones.size()-1; i >= 0 && count < maxItems; i--, count++) {
            LiquidityZone lq = liquidityZones.get(i);
            int x1 = ds.getXForTime(lq.startTime);
            int x2 = ds.getXForTime(lq.endTime);
            int y1 = (int) ds.getYForValue(lq.top);
            int y2 = (int) ds.getYForValue(lq.bottom);
            int w = Math.max(x2-x1, 8), h = Math.max(Math.abs(y2-y1), 3), ty = Math.min(y1,y2);
            Color fill   = lq.isBuyside ? new Color(255, 140, 0, 35) : new Color(0, 200, 255, 35);
            Color border = lq.isBuyside ? new Color(255, 140, 0, 180): new Color(0, 200, 255, 180);
            g2.setColor(fill);   g2.fillRect(x1, ty, w, h);
            g2.setColor(border); g2.setStroke(new BasicStroke(1f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER, 4f, new float[]{3f,2f}, 0f));
            g2.drawRect(x1, ty, w, h);
            g2.setFont(new Font("SansSerif", Font.PLAIN, 8));
            g2.setStroke(new BasicStroke(1f));
            g2.drawString(lq.isBuyside ? "BSL" : "SSL", x1+3, ty+9);
        }
    }
}
