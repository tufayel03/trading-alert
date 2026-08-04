package jforex;

import com.dukascopy.api.IBar;
import com.dukascopy.api.indicators.*;
import java.awt.*;
import java.util.*;
import java.util.List;

public class ICTConcept implements IIndicator, IDrawingIndicator {

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

    private IIndicatorContext context;
    private IndicatorInfo indicatorInfo;
    private InputParameterInfo[] inputParameterInfos;
    private OptInputParameterInfo[] optInputParameterInfos;
    private OutputParameterInfo[] outputParameterInfos;

    private final IBar[][] inputs = new IBar[1][];
    private final Object[] outputs = new Object[14];

    private int     swingLength         = 5;
    private boolean showMarketStructure = true;
    private boolean showOrderBlocks     = true;
    private boolean showFVG             = true;
    private boolean showLiquidity       = true;
    private boolean showDisplacement    = true;
    private int     maxItems            = 10;

    private final List<StructureLine>  structureLines    = new ArrayList<>();
    private final List<FVGBox>         fvgBoxes          = new ArrayList<>();
    private final List<OrderBlockBox>  orderBlockBoxes   = new ArrayList<>();
    private final List<LiquidityZone>  liquidityZones    = new ArrayList<>();
    private final List<Long>           displacementTimes = new ArrayList<>();

    // FIX #2: Remove constructor initialization — JForex requires initialization in onStart()
    // The constructor is now empty (default constructor is fine).

    @Override
    public void onStart(IIndicatorContext context) {  // FIX #2: All setup goes here
        this.context = context;

        indicatorInfo = new IndicatorInfo("ICTConcepts", "ICT Concepts", "Custom", true, false, false, 1, 7, 14);
        indicatorInfo.setRecalculateAll(true);

        inputParameterInfos = new InputParameterInfo[] {
            new InputParameterInfo("Bars", InputParameterInfo.Type.BAR)
        };

        optInputParameterInfos = new OptInputParameterInfo[] {
            new OptInputParameterInfo("Swing Lookback",         OptInputParameterInfo.Type.OTHER, new IntegerRangeDescription(5, 3, 50, 1)),
            new OptInputParameterInfo("Market Structure",       OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Order Blocks",           OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Fair Value Gaps",        OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Liquidity Sweeps",       OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Show Displacement",      OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Max Visible Elements",   OptInputParameterInfo.Type.OTHER, new IntegerRangeDescription(10, 2, 50, 1))
        };

        outputParameterInfos = new OutputParameterInfo[] {
            // CRITICAL: outputs[0] MUST be LINE (not NONE) — JForex only calls drawOutput() when DrawingStyle != NONE.
            // setDrawnByIndicator(true) means WE handle the rendering, so no spurious line appears.
            new OutputParameterInfo("Trigger Output",   OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.LINE),
            new OutputParameterInfo("Bullish BOS",      OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bearish BOS",      OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bullish MSS",      OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bearish MSS",      OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bull FVG Top",     OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bull FVG Bottom",  OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bear FVG Top",     OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bear FVG Bottom",  OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bull OB Top",      OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bull OB Bottom",   OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bear OB Top",      OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Bear OB Bottom",   OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE),
            new OutputParameterInfo("Buyside Liq",      OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.NONE)
        };

        // FIX #3: Only output[0] needs drawOutput gate; all outputs are drawn-by-indicator
        for (OutputParameterInfo p : outputParameterInfos) {
            p.setDrawnByIndicator(true);
        }
    }

    @Override
    public IndicatorResult calculate(int startIndex, int endIndex) {
        if (inputs[0] == null) return new IndicatorResult(0, 0, 0);

        if (startIndex - getLookback() < 0) {
            startIndex = getLookback();
        }
        if (startIndex > endIndex) {
            return new IndicatorResult(0, 0, 0);
        }

        for (int i = 0; i < outputs.length; i++) {
            if (outputs[i] != null) {
                Arrays.fill((double[]) outputs[i], Double.NaN);
            }
        }

        IBar[] bars = inputs[0];
        int totalBars = bars.length;
        if (endIndex >= totalBars) endIndex = totalBars - 1;
        if (startIndex > endIndex) return new IndicatorResult(0, 0, 0);

        int outLen = endIndex - startIndex + 1;

        // Fill trigger output with close prices so JForex always calls drawOutput
        if (outputs[0] != null) {
            for (int k = 0; k < outLen; k++) {
                int barIdx = startIndex + k;
                if (barIdx >= 0 && barIdx < totalBars) {
                    ((double[]) outputs[0])[k] = bars[barIdx].getClose();
                }
            }
        }

        structureLines.clear();
        fvgBoxes.clear();
        orderBlockBoxes.clear();
        liquidityZones.clear();
        displacementTimes.clear();

        List<SwingPoint> swingHighs = new ArrayList<>();
        List<SwingPoint> swingLows  = new ArrayList<>();
        int trendDir = 0;
        double sumBody = 0; int nBody = 0;

        int scanStart = swingLength * 2;
        if (scanStart >= totalBars) return new IndicatorResult(startIndex, outLen, endIndex);

        for (int i = scanStart; i <= endIndex; i++) {
            IBar bar = bars[i];
            double body = Math.abs(bar.getClose() - bar.getOpen());
            sumBody += body; nBody++;
            double avgBody = sumBody / nBody;

            int pivotIdx = i - swingLength;
            boolean isPH = true, isPL = true;
            for (int k = pivotIdx - swingLength; k <= pivotIdx + swingLength; k++) {
                if (k == pivotIdx || k < 0 || k >= totalBars) continue;
                if (bars[k].getHigh() >= bars[pivotIdx].getHigh()) isPH = false;
                if (bars[k].getLow()  <= bars[pivotIdx].getLow())  isPL = false;
            }
            if (isPH) swingHighs.add(new SwingPoint(pivotIdx, bars[pivotIdx].getTime(), bars[pivotIdx].getHigh(), true));
            if (isPL) swingLows .add(new SwingPoint(pivotIdx, bars[pivotIdx].getTime(), bars[pivotIdx].getLow(),  false));

            // --- Market Structure (BOS / MSS) ---
            if (showMarketStructure && !swingHighs.isEmpty() && !swingLows.isEmpty()) {
                SwingPoint lastH = swingHighs.get(swingHighs.size()-1);
                SwingPoint lastL = swingLows .get(swingLows .size()-1);

                if (bar.getClose() > lastH.price && !lastH.crossed) {
                    lastH.crossed = true;
                    String label = (trendDir <= 0) ? "MSS" : "BOS";
                    boolean wasMSS = trendDir <= 0;
                    trendDir = 1;
                    structureLines.add(new StructureLine(lastH.time, bar.getTime(), lastH.price, label, true));

                    int op = i - startIndex;
                    if (op >= 0 && op < outLen) {
                        if (wasMSS && outputs[3] != null) ((double[])outputs[3])[op] = bar.getClose();
                        else if (!wasMSS && outputs[1] != null) ((double[])outputs[1])[op] = bar.getClose();
                    }
                }

                if (bar.getClose() < lastL.price && !lastL.crossed) {
                    lastL.crossed = true;
                    String label = (trendDir >= 0) ? "MSS" : "BOS";
                    boolean wasMSS = trendDir >= 0;
                    trendDir = -1;
                    structureLines.add(new StructureLine(lastL.time, bar.getTime(), lastL.price, label, false));

                    int op = i - startIndex;
                    if (op >= 0 && op < outLen) {
                        if (wasMSS && outputs[4] != null) ((double[])outputs[4])[op] = bar.getClose();
                        else if (!wasMSS && outputs[2] != null) ((double[])outputs[2])[op] = bar.getClose();
                    }
                }
            }

            // --- Fair Value Gaps (FVG) ---
            if (showFVG && i >= 2) {
                IBar b0 = bars[i-2], b2 = bar;
                if (b2.getLow() > b0.getHigh()) {
                    FVGBox fvg = new FVGBox(b0.getTime(), bar.getTime(), b2.getLow(), b0.getHigh(), true);
                    fvgBoxes.add(fvg);
                    int op = i - startIndex;
                    if (op >= 0 && op < outLen) {
                        if (outputs[5] != null) ((double[])outputs[5])[op] = fvg.top;
                        if (outputs[6] != null) ((double[])outputs[6])[op] = fvg.bottom;
                    }
                }
                if (b2.getHigh() < b0.getLow()) {
                    FVGBox fvg = new FVGBox(b0.getTime(), bar.getTime(), b0.getLow(), b2.getHigh(), false);
                    fvgBoxes.add(fvg);
                    int op = i - startIndex;
                    if (op >= 0 && op < outLen) {
                        if (outputs[7] != null) ((double[])outputs[7])[op] = fvg.top;
                        if (outputs[8] != null) ((double[])outputs[8])[op] = fvg.bottom;
                    }
                }
                for (FVGBox f : fvgBoxes) {
                    if (!f.active) continue;
                    if (f.isBullish  && bar.getLow()  < f.bottom) { f.active = false; f.endTime = bar.getTime(); }
                    if (!f.isBullish && bar.getHigh() > f.top)    { f.active = false; f.endTime = bar.getTime(); }
                }
            }

            // --- Order Blocks (OB) ---  FIX #5: was completely missing!
            if (showOrderBlocks && i >= 1) {
                IBar prev = bars[i - 1];
                boolean prevBearish = prev.getClose() < prev.getOpen();
                boolean prevBullish = prev.getClose() > prev.getOpen();

                // Bullish OB: last bar was bearish, current bullish impulse breaks above it (in uptrend)
                if (trendDir > 0 && prevBearish && bar.getClose() > prev.getHigh()) {
                    OrderBlockBox ob = new OrderBlockBox(
                        prev.getTime(), bar.getTime(),
                        prev.getHigh(), prev.getLow(), true);
                    orderBlockBoxes.add(ob);
                    int op = i - startIndex;
                    if (op >= 0 && op < outLen) {
                        if (outputs[9]  != null) ((double[])outputs[9])[op]  = ob.top;
                        if (outputs[10] != null) ((double[])outputs[10])[op] = ob.bottom;
                    }
                }

                // Bearish OB: last bar was bullish, current bearish impulse breaks below it (in downtrend)
                if (trendDir < 0 && prevBullish && bar.getClose() < prev.getLow()) {
                    OrderBlockBox ob = new OrderBlockBox(
                        prev.getTime(), bar.getTime(),
                        prev.getHigh(), prev.getLow(), false);
                    orderBlockBoxes.add(ob);
                    int op = i - startIndex;
                    if (op >= 0 && op < outLen) {
                        if (outputs[11] != null) ((double[])outputs[11])[op] = ob.top;
                        if (outputs[12] != null) ((double[])outputs[12])[op] = ob.bottom;
                    }
                }

                // Invalidate broken OBs
                for (OrderBlockBox ob : orderBlockBoxes) {
                    if (!ob.active) continue;
                    if (ob.isBullish  && bar.getLow()  < ob.bottom) { ob.active = false; ob.endTime = bar.getTime(); }
                    if (!ob.isBullish && bar.getHigh() > ob.top)    { ob.active = false; ob.endTime = bar.getTime(); }
                }
            }

            // --- Liquidity Zones ---
            if (showLiquidity) {
                if (swingHighs.size() >= 2) {
                    SwingPoint h1 = swingHighs.get(swingHighs.size()-1);
                    SwingPoint h2 = swingHighs.get(swingHighs.size()-2);
                    double thr = h1.price * 0.0005;
                    if (Math.abs(h1.price - h2.price) <= thr) {
                        liquidityZones.add(new LiquidityZone(h2.time, bar.getTime(),
                            Math.max(h1.price,h2.price)+thr, Math.min(h1.price,h2.price)-thr, true));
                        int op = i - startIndex;
                        if (op >= 0 && op < outLen) {
                            if (outputs[13] != null) ((double[])outputs[13])[op] = Math.max(h1.price, h2.price) + thr;
                        }
                    }
                }
                if (swingLows.size() >= 2) {
                    SwingPoint l1 = swingLows.get(swingLows.size()-1);
                    SwingPoint l2 = swingLows.get(swingLows.size()-2);
                    double thr = l1.price * 0.0005;
                    if (Math.abs(l1.price - l2.price) <= thr) {
                        liquidityZones.add(new LiquidityZone(l2.time, bar.getTime(),
                            Math.max(l1.price,l2.price)+thr, Math.min(l1.price,l2.price)-thr, false));
                    }
                }
            }

            // --- Displacement ---
            if (showDisplacement && body > avgBody * 1.8) displacementTimes.add(bar.getTime());
        }

        return new IndicatorResult(startIndex, outLen, endIndex);
    }

    @Override public IndicatorInfo getIndicatorInfo() { return indicatorInfo; }

    @Override public InputParameterInfo getInputParameterInfo(int index) {
        if (index < inputParameterInfos.length) return inputParameterInfos[index];
        return null;
    }

    @Override public OptInputParameterInfo getOptInputParameterInfo(int index) {
        if (index < optInputParameterInfos.length) return optInputParameterInfos[index];
        return null;
    }

    @Override public OutputParameterInfo getOutputParameterInfo(int index) {
        if (index < outputParameterInfos.length) return outputParameterInfos[index];
        return null;
    }

    @Override public void setInputParameter(int index, Object array) {
        inputs[index] = (IBar[]) array;
    }

    @Override public void setOptInputParameter(int index, Object value) {
        if (value == null) return;
        switch (index) {
            case 0: swingLength         = (Integer) value; break;
            case 1: showMarketStructure = (Boolean) value; break;
            case 2: showOrderBlocks     = (Boolean) value; break;
            case 3: showFVG             = (Boolean) value; break;
            case 4: showLiquidity       = (Boolean) value; break;
            case 5: showDisplacement    = (Boolean) value; break;
            case 6: maxItems            = (Integer) value; break;
        }
    }

    @Override public void setOutputParameter(int index, Object array) {
        outputs[index] = array;
    }

    @Override public int getLookback()    { return swingLength * 2 + 5; }
    @Override public int getLookforward() { return 0; }

    // FIX #3: drawOutput is called once per outputIdx (0..13).
    // We do ALL custom drawing only in the outputIdx==0 pass to avoid duplicate rendering.
    @Override
    public Point drawOutput(Graphics g, int outputIdx, Object values, Color color, Stroke stroke,
                            IIndicatorDrawingSupport ds, List<Shape> shapes, Map<Color, List<Point>> handles) {
        if (g == null || ds == null) return null;
        if (outputIdx != 0) return null;  // All drawing in one pass only

        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

        try {
            drawStructureLines(g2, ds);
            drawFVGs(g2, ds);
            drawOrderBlocks(g2, ds);
            drawLiquidityZones(g2, ds);
            drawDisplacements(g2, ds);
        } catch (Exception e) {
            // Silently swallow rendering exceptions to prevent indicator crash
        } finally {
            g2.dispose();
        }
        return null;
    }

    private void drawFVGs(Graphics2D g2, IIndicatorDrawingSupport ds) {
        if (!showFVG) return;
        int chartW = ds.getChartWidth();
        int count = 0;
        for (int i = fvgBoxes.size()-1; i >= 0 && count < maxItems; i--, count++) {
            FVGBox f = fvgBoxes.get(i);
            int x1 = ds.getXForTime(f.startTime);
            int x2 = f.active ? chartW : ds.getXForTime(f.endTime);
            double yd1 = ds.getYForValue(f.top),  yd2 = ds.getYForValue(f.bottom);
            if (Double.isNaN(yd1) || Double.isNaN(yd2) || yd1 == Integer.MIN_VALUE || yd2 == Integer.MIN_VALUE) continue;
            int y1 = (int) yd1, y2 = (int) yd2;

            if (x1 == Integer.MIN_VALUE || x1 < 0) x1 = 0;
            if (x2 == Integer.MIN_VALUE) x2 = chartW;
            if (x1 > chartW || x2 < -500) continue;

            int w  = Math.max(x2 - x1, 6);
            int h  = Math.max(Math.abs(y2 - y1), 2);
            int ty = Math.min(y1, y2);

            Color fill   = f.isBullish ? new Color(0, 200, 100, 45)  : new Color(220, 50, 50, 45);
            Color border = f.isBullish ? new Color(0, 200, 100, 200) : new Color(220, 50, 50, 200);

            g2.setColor(fill);   g2.fillRect(x1, ty, w, h);
            g2.setColor(border);
            g2.setStroke(f.active
                ? new BasicStroke(1f)
                : new BasicStroke(1f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER, 4f, new float[]{4f,3f}, 0f));
            g2.drawRect(x1, ty, w, h);
            g2.setFont(new Font("SansSerif", Font.BOLD, 9));
            g2.drawString(f.isBullish ? "FVG+" : "FVG-", Math.max(x1+3, 5), ty+11);
        }
    }

    private void drawOrderBlocks(Graphics2D g2, IIndicatorDrawingSupport ds) {
        if (!showOrderBlocks) return;
        int chartW = ds.getChartWidth();
        int count = 0;
        for (int i = orderBlockBoxes.size()-1; i >= 0 && count < maxItems; i--, count++) {
            OrderBlockBox ob = orderBlockBoxes.get(i);
            int x1 = ds.getXForTime(ob.startTime);
            int x2 = ob.active ? chartW : ds.getXForTime(ob.endTime);
            double yd1 = ds.getYForValue(ob.top), yd2 = ds.getYForValue(ob.bottom);
            if (Double.isNaN(yd1) || Double.isNaN(yd2) || yd1 == Integer.MIN_VALUE || yd2 == Integer.MIN_VALUE) continue;
            int y1 = (int) yd1, y2 = (int) yd2;

            if (x1 == Integer.MIN_VALUE || x1 < 0) x1 = 0;
            if (x2 == Integer.MIN_VALUE) x2 = chartW;
            if (x1 > chartW || x2 < -500) continue;

            int w  = Math.max(x2-x1, 8);
            int h  = Math.max(Math.abs(y2-y1), 2);
            int ty = Math.min(y1, y2);

            Color fill   = ob.isBullish ? new Color(30, 120, 255, 50)  : new Color(255, 40, 40, 50);
            Color border = ob.isBullish ? new Color(30, 120, 255, 220) : new Color(255, 40, 40, 220);

            g2.setColor(fill);   g2.fillRect(x1, ty, w, h);
            g2.setColor(border); g2.setStroke(new BasicStroke(1.5f));
            g2.drawRect(x1, ty, w, h);
            g2.setFont(new Font("SansSerif", Font.BOLD, 10));
            g2.drawString(ob.isBullish ? "+OB" : "-OB", Math.max(x1+4, 5), ty+13);
        }
    }

    private void drawStructureLines(Graphics2D g2, IIndicatorDrawingSupport ds) {
        if (!showMarketStructure) return;
        int count = 0;
        for (int i = structureLines.size()-1; i >= 0 && count < maxItems*2; i--, count++) {
            StructureLine sl = structureLines.get(i);
            int x1 = ds.getXForTime(sl.startTime);
            int x2 = ds.getXForTime(sl.endTime);
            double yd = ds.getYForValue(sl.price);

            if (Double.isNaN(yd) || yd == Integer.MIN_VALUE) continue;
            int y = (int) yd;
            if (x1 == Integer.MIN_VALUE || x1 < 0) x1 = 0;
            if (x2 == Integer.MIN_VALUE) x2 = ds.getChartWidth();

            Color c = sl.isBullish ? new Color(0, 220, 150) : new Color(220, 50, 50);
            g2.setColor(c);
            if ("MSS".equals(sl.label)) g2.setStroke(new BasicStroke(2f));
            else g2.setStroke(new BasicStroke(1f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER, 4f, new float[]{4f,3f}, 0f));
            g2.drawLine(x1, y, x2, y);
            g2.setFont(new Font("SansSerif", Font.BOLD, 10));
            g2.setStroke(new BasicStroke(1f));
            g2.drawString(sl.label, Math.max((x1+x2)/2-10, 5), sl.isBullish ? y-3 : y+12);
        }
    }

    private void drawLiquidityZones(Graphics2D g2, IIndicatorDrawingSupport ds) {
        if (!showLiquidity) return;
        int count = 0;
        for (int i = liquidityZones.size()-1; i >= 0 && count < maxItems; i--, count++) {
            LiquidityZone lq = liquidityZones.get(i);
            int x1 = ds.getXForTime(lq.startTime);
            int x2 = ds.getXForTime(lq.endTime);
            double yd1 = ds.getYForValue(lq.top), yd2 = ds.getYForValue(lq.bottom);
            if (Double.isNaN(yd1) || Double.isNaN(yd2) || yd1 == Integer.MIN_VALUE || yd2 == Integer.MIN_VALUE) continue;
            int y1 = (int) yd1, y2 = (int) yd2;

            if (x1 == Integer.MIN_VALUE || x1 < 0) x1 = 0;
            if (x2 == Integer.MIN_VALUE) x2 = ds.getChartWidth();

            int w  = Math.max(x2-x1, 8);
            int h  = Math.max(Math.abs(y2-y1), 3);
            int ty = Math.min(y1, y2);

            Color fill   = lq.isBuyside ? new Color(255, 140, 0, 35)  : new Color(0, 200, 255, 35);
            Color border = lq.isBuyside ? new Color(255, 140, 0, 180) : new Color(0, 200, 255, 180);

            g2.setColor(fill);   g2.fillRect(x1, ty, w, h);
            g2.setColor(border);
            g2.setStroke(new BasicStroke(1f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER, 4f, new float[]{3f,2f}, 0f));
            g2.drawRect(x1, ty, w, h);
            g2.setFont(new Font("SansSerif", Font.PLAIN, 8));
            g2.setStroke(new BasicStroke(1f));
            g2.drawString(lq.isBuyside ? "BSL" : "SSL", Math.max(x1+3, 5), ty+9);
        }
    }

    private void drawDisplacements(Graphics2D g2, IIndicatorDrawingSupport ds) {
        if (!showDisplacement) return;
        int count = 0;
        for (int i = displacementTimes.size()-1; i >= 0 && count < maxItems; i--, count++) {
            long t = displacementTimes.get(i);
            int x = ds.getXForTime(t);
            if (x == Integer.MIN_VALUE) continue;
            // Draw a small arrow marker at the top of the visible area
            g2.setColor(new Color(255, 220, 0, 200));
            g2.setStroke(new BasicStroke(2f));
            g2.drawLine(x, 2, x, 10);
        }
    }
}
