// TradingView's free Advanced Chart widget (symbol chart on Trade detail, Setups cards). It
// renders inside a sandboxed iframe TradingView controls, so there's no way to draw buy/sell
// markers on it. Confirmed directly against tradingview-widget.com (outside this app) that the
// widget picks its own candle size from `range` and largely ignores whatever `interval` we pass
// — range="1M" renders 30-minute bars, "3M" renders 1-hour, "6M" renders 2-hour, no matter what
// `interval` says. Only range="12M"+ reliably gets genuine daily candles (what tvRange in
// TradeDetail relies on) — there's no way to get a short, e.g. 1-month, visible window at daily
// granularity through these params. The small "D" badge in the widget's legend is unrelated to
// any of this — it flags delayed (non-realtime) quotes, not the interval. `hideTopToolbar` is
// separate: at the card's narrow 3-per-row width the toolbar doesn't have room for every
// interval preset, so Setups cards pass it to drop the toolbar rather than show it crowded.
import { useEffect, useRef } from "react";

export function TradingViewChart({
  symbol,
  range,
  interval = "5",
  height = 440,
  hideTopToolbar = false,
}: {
  symbol: string;
  range: string;
  interval?: string;
  height?: number;
  hideTopToolbar?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    // TradingView's loader resizes *this* div for "autosize" (it overwrites its inline
    // height with 100%), so the fixed height has to live one level up, on `host`, which
    // the loader never touches.
    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = "100%";
    container.style.width = "100%";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    widget.style.width = "100%";
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.text = JSON.stringify({
      autosize: true,
      symbol,
      interval,
      range,
      timezone: "America/New_York",
      theme: "dark",
      backgroundColor: "rgba(18, 18, 18, 1)",
      style: "1",
      locale: "en",
      hide_top_toolbar: hideTopToolbar,
      hide_legend: false,
      save_image: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
    });
    container.appendChild(widget);
    container.appendChild(script);
    host.appendChild(container);
  }, [symbol, range, interval, hideTopToolbar]);
  return <div ref={hostRef} style={{ height, width: "100%" }} />;
}
