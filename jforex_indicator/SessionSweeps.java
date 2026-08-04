package jforex;

import com.dukascopy.api.DefaultColors;
import com.dukascopy.api.IBar;
import com.dukascopy.api.indicators.*;
import java.awt.*;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.List;

/**
 * Sessions Indicator for JForex
 * Highlights Asia, London, NY AM, and NY PM trading sessions across all chart history.
 * Each session is rendered during its own outputIdx pass so colors and opacities in the Outputs tab are 100% independent.
 */
public class SessionSweeps implements IIndicator, IDrawingIndicator {

    private IndicatorInfo indicatorInfo;
    private InputParameterInfo[] inputParameterInfos;
    private OptInputParameterInfo[] optInputParameterInfos;
    private OutputParameterInfo[] outputParameterInfos;
    private IBar[][] inputs = new IBar[1][];
    private double[][] outputs = new double[4][];

    // Session Visibility Options
    private boolean showAsia = true;
    private boolean showLondon = true;
    private boolean showNyAm = true;
    private boolean showNyPm = true;
    private boolean showTable = true;

    // Session Instance Structure
    public static class SessionInstance {
        public String name;
        public int sessionType; // 0=Asia, 1=London, 2=NY AM, 3=NY PM
        public long startTime;
        public long endTime;
        public double high;
        public double low;
        public boolean active;

        public SessionInstance(String name, int sessionType, long startTime) {
            this.name = name;
            this.sessionType = sessionType;
            this.startTime = startTime;
            this.endTime = startTime;
            this.high = -Double.MAX_VALUE;
            this.low = Double.MAX_VALUE;
            this.active = true;
        }
    }

    private List<SessionInstance> sessionsList = new ArrayList<>();
    private SimpleDateFormat utcFormat;

    @Override
    public void onStart(IIndicatorContext context) {
        indicatorInfo = new IndicatorInfo("SessionSweeps", "Trading Sessions [LuxAlgo]", "Custom", true, false, false, 1, 5, 4);

        inputParameterInfos = new InputParameterInfo[] {
            new InputParameterInfo("Bars", InputParameterInfo.Type.BAR)
        };

        optInputParameterInfos = new OptInputParameterInfo[] {
            new OptInputParameterInfo("Show Asia Session", OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Show London Session", OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Show NY AM Session", OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Show NY PM Session", OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true)),
            new OptInputParameterInfo("Show Status Table", OptInputParameterInfo.Type.OTHER, new BooleanOptInputDescription(true))
        };

        // 4 Independent Outputs -> JForex gives independent Color, Opacity & Line controls for each in the "Outputs" tab!
        outputParameterInfos = new OutputParameterInfo[] {
            new OutputParameterInfo("Asia Session", OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.LINE),
            new OutputParameterInfo("London Session", OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.LINE),
            new OutputParameterInfo("NY AM Session", OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.LINE),
            new OutputParameterInfo("NY PM Session", OutputParameterInfo.Type.DOUBLE, OutputParameterInfo.DrawingStyle.LINE)
        };

        outputParameterInfos[0].setColor(DefaultColors.YELLOW);
        outputParameterInfos[0].setDrawnByIndicator(true);

        outputParameterInfos[1].setColor(DefaultColors.ROYAL_BLUE);
        outputParameterInfos[1].setDrawnByIndicator(true);

        outputParameterInfos[2].setColor(DefaultColors.DARK_ORANGE);
        outputParameterInfos[2].setDrawnByIndicator(true);

        outputParameterInfos[3].setColor(DefaultColors.RED);
        outputParameterInfos[3].setDrawnByIndicator(true);

        utcFormat = new SimpleDateFormat("HH");
        utcFormat.setTimeZone(TimeZone.getTimeZone("UTC"));
    }

    @Override
    public IndicatorResult calculate(int startIndex, int endIndex) {
        if (startIndex < 0 || endIndex >= inputs[0].length) return new IndicatorResult(0, 0);

        int outLen = endIndex - startIndex + 1;
        for (int k = 0; k < 4; k++) {
            if (outputs[k] == null || outputs[k].length < outLen) {
                outputs[k] = new double[outLen];
            }
        }

        sessionsList.clear();

        SessionInstance currentAsia = null;
        SessionInstance currentLondon = null;
        SessionInstance currentNyAm = null;
        SessionInstance currentNyPm = null;

        for (int i = 0; i < inputs[0].length; i++) {
            IBar bar = inputs[0][i];
            long t = bar.getTime();
            int utcHour = Integer.parseInt(utcFormat.format(new Date(t)));

            // 1. Asia Session (00:00 - 09:00 UTC)
            if (showAsia) {
                boolean inAsia = (utcHour >= 0 && utcHour < 9);
                if (inAsia) {
                    if (currentAsia == null || !currentAsia.active) {
                        currentAsia = new SessionInstance("Asia", 0, t);
                        sessionsList.add(currentAsia);
                    }
                    currentAsia.high = Math.max(currentAsia.high, bar.getHigh());
                    currentAsia.low = Math.min(currentAsia.low, bar.getLow());
                    currentAsia.endTime = t;
                } else if (currentAsia != null && currentAsia.active) {
                    currentAsia.active = false;
                }
            }

            // 2. London Session (07:00 - 16:00 UTC)
            if (showLondon) {
                boolean inLondon = (utcHour >= 7 && utcHour < 16);
                if (inLondon) {
                    if (currentLondon == null || !currentLondon.active) {
                        currentLondon = new SessionInstance("London", 1, t);
                        sessionsList.add(currentLondon);
                    }
                    currentLondon.high = Math.max(currentLondon.high, bar.getHigh());
                    currentLondon.low = Math.min(currentLondon.low, bar.getLow());
                    currentLondon.endTime = t;
                } else if (currentLondon != null && currentLondon.active) {
                    currentLondon.active = false;
                }
            }

            // 3. NY AM Session (12:00 - 17:00 UTC)
            if (showNyAm) {
                boolean inNyAm = (utcHour >= 12 && utcHour < 17);
                if (inNyAm) {
                    if (currentNyAm == null || !currentNyAm.active) {
                        currentNyAm = new SessionInstance("NY AM", 2, t);
                        sessionsList.add(currentNyAm);
                    }
                    currentNyAm.high = Math.max(currentNyAm.high, bar.getHigh());
                    currentNyAm.low = Math.min(currentNyAm.low, bar.getLow());
                    currentNyAm.endTime = t;
                } else if (currentNyAm != null && currentNyAm.active) {
                    currentNyAm.active = false;
                }
            }

            // 4. NY PM Session (17:00 - 23:00 UTC)
            if (showNyPm) {
                boolean inNyPm = (utcHour >= 17 && utcHour < 23);
                if (inNyPm) {
                    if (currentNyPm == null || !currentNyPm.active) {
                        currentNyPm = new SessionInstance("NY PM", 3, t);
                        sessionsList.add(currentNyPm);
                    }
                    currentNyPm.high = Math.max(currentNyPm.high, bar.getHigh());
                    currentNyPm.low = Math.min(currentNyPm.low, bar.getLow());
                    currentNyPm.endTime = t;
                } else if (currentNyPm != null && currentNyPm.active) {
                    currentNyPm.active = false;
                }
            }

            if (i >= startIndex && i <= endIndex) {
                for (int k = 0; k < 4; k++) {
                    outputs[k][i - startIndex] = bar.getClose();
                }
            }
        }

        return new IndicatorResult(startIndex, outLen, endIndex);
    }

    @Override
    public Point drawOutput(Graphics g, int outputIdx, Object values, Color color, Stroke stroke,
                            IIndicatorDrawingSupport ds, List<Shape> shapes, Map<Color, List<Point>> handles) {
        if (g == null || ds == null || color == null) return null;
        if (outputIdx < 0 || outputIdx > 3) return null;

        Graphics2D g2 = (Graphics2D) g.create();
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

        try {
            // Render ONLY the session corresponding to this outputIdx using the exact color/opacity passed by JForex
            drawSessionType(g2, ds, outputIdx, color);
            if (outputIdx == 0 && showTable) drawStatusTable(g2, ds);
        } catch (Exception e) {
            // Guard
        } finally {
            g2.dispose();
        }

        return null;
    }

    private void drawSessionType(Graphics2D g2, IIndicatorDrawingSupport ds, int targetSessionType, Color userColor) {
        int chartW = ds.getChartWidth();

        // Calculate fill color (if solid color selected, use 45 alpha, else preserve user chosen alpha)
        int alpha = userColor.getAlpha() == 255 ? 45 : userColor.getAlpha();
        Color fillColor = new Color(userColor.getRed(), userColor.getGreen(), userColor.getBlue(), alpha);
        Color borderColor = new Color(userColor.getRed(), userColor.getGreen(), userColor.getBlue(), Math.min(255, Math.max(alpha, 190)));

        for (int i = 0; i < sessionsList.size(); i++) {
            SessionInstance s = sessionsList.get(i);
            if (s.sessionType != targetSessionType) continue; // Draw ONLY matching session type
            if (s.high == -Double.MAX_VALUE || s.low == Double.MAX_VALUE) continue;

            int x1 = ds.getXForTime(s.startTime);
            int x2 = s.active ? chartW : ds.getXForTime(s.endTime);
            double yd1 = ds.getYForValue(s.high);
            double yd2 = ds.getYForValue(s.low);

            if (Double.isNaN(yd1) || Double.isNaN(yd2) || yd1 == Integer.MIN_VALUE || yd2 == Integer.MIN_VALUE) continue;
            int y1 = (int) yd1, y2 = (int) yd2;

            if (x1 == Integer.MIN_VALUE || x1 < -500) x1 = 0;
            if (x2 == Integer.MIN_VALUE || x2 > chartW + 500) x2 = chartW;
            if (x1 > chartW || x2 < 0) continue;

            int w = Math.max(x2 - x1, 4);
            int h = Math.max(Math.abs(y2 - y1), 2);
            int ty = Math.min(y1, y2);

            // 1. Fill Session Box
            g2.setColor(fillColor);
            g2.fillRect(x1, ty, w, h);

            // 2. Draw Border
            g2.setColor(borderColor);
            g2.drawRect(x1, ty, w, h);

            // 3. Draw Title
            g2.setFont(new Font("SansSerif", Font.BOLD, 10));
            g2.drawString(s.name, x1 + 4, ty + 12);
        }
    }

    private void drawStatusTable(Graphics2D g2, IIndicatorDrawingSupport ds) {
        int w = 180, h = 90;
        int x = ds.getChartWidth() - w - 15;
        int y = 15;

        g2.setColor(new Color(20, 24, 35, 210));
        g2.fillRect(x, y, w, h);
        g2.setColor(new Color(60, 68, 85, 255));
        g2.drawRect(x, y, w, h);

        g2.setFont(new Font("SansSerif", Font.BOLD, 11));
        g2.setColor(Color.WHITE);
        g2.drawString("Sessions Status (UTC)", x + 10, y + 18);

        g2.setFont(new Font("SansSerif", Font.PLAIN, 10));
        g2.setColor(new Color(255, 235, 59));
        g2.drawString("Asia (00:00 - 09:00 UTC)", x + 10, y + 36);

        g2.setColor(new Color(33, 150, 243));
        g2.drawString("London (07:00 - 16:00 UTC)", x + 10, y + 51);

        g2.setColor(new Color(255, 152, 0));
        g2.drawString("NY AM (12:00 - 17:00 UTC)", x + 10, y + 66);

        g2.setColor(new Color(244, 67, 54));
        g2.drawString("NY PM (17:00 - 23:00 UTC)", x + 10, y + 81);
    }

    @Override public IndicatorInfo getIndicatorInfo() { return indicatorInfo; }
    @Override public InputParameterInfo getInputParameterInfo(int index) { return index == 0 ? inputParameterInfos[0] : null; }
    @Override public OptInputParameterInfo getOptInputParameterInfo(int index) { return index < optInputParameterInfos.length ? optInputParameterInfos[index] : null; }
    @Override public OutputParameterInfo getOutputParameterInfo(int index) { return index < outputParameterInfos.length ? outputParameterInfos[index] : null; }
    @Override public void setInputParameter(int index, Object array) { inputs[index] = (IBar[]) array; }
    @Override public void setOptInputParameter(int index, Object value) {
        if (value == null) return;
        switch (index) {
            case 0: showAsia = (Boolean) value; break;
            case 1: showLondon = (Boolean) value; break;
            case 2: showNyAm = (Boolean) value; break;
            case 3: showNyPm = (Boolean) value; break;
            case 4: showTable = (Boolean) value; break;
        }
    }
    @Override public void setOutputParameter(int index, Object array) { outputs[index] = (double[]) array; }
    @Override public int getLookback() { return 0; }
    @Override public int getLookforward() { return 0; }
}
