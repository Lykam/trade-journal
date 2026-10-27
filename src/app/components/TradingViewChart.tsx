// TradingView's free Advanced Chart widget (symbol daily chart on Trade detail). It
// renders inside a sandboxed iframe TradingView controls, so there's no way to draw
// buy/sell markers on it — `range` just gets the trade's open date into view.
import { useEffect, useRef } from "react";

export function TradingViewChart({ symbol, range, height = 440 }: { symbol: string; range: string; height?: number }) {
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
      interval: "D",
      range,
      timezone: "America/New_York",
      theme: "dark",
      backgroundColor: "rgba(18, 18, 18, 1)",
      style: "1",
      locale: "en",
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
    });
    container.appendChild(widget);
    container.appendChild(script);
    host.appendChild(container);
  }, [symbol, range]);
  return <div ref={hostRef} style={{ height, width: "100%" }} />;
}
