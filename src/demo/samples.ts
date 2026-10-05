// Sample broker exports for the demo's Import page (Q50): synthetic rows in the
// exact Webull and Schwab CSV formats, on the demo's made-up tickers, dated the
// last trading day before today so nothing is in the future. One Webull row is
// a new 2x ETF, so the preview shows the "map this ETF" step.
import { addDays, dayOfWeek } from "../core/calendar";
import { etDate, etOffset } from "../core/normalize/util";

export interface SampleCsv {
  name: string;
  text: string;
}

const us = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;

/** The weekday before `now`'s ET date. */
function lastSession(now: string): string {
  let d = addDays(etDate(now), -1);
  while (dayOfWeek(d) % 6 === 0) d = addDays(d, -1);
  return d;
}

export function sampleCsvs(now: string): SampleCsv[] {
  const d = lastSession(now);
  const tz = etOffset(d) === "-04:00" ? "EDT" : "EST";
  const t = (hms: string) => `${us(d)} ${hms} ${tz}`;
  const webull = [
    "Name,Symbol,Side,Status,Filled,Total Qty,Price,Avg Price,Time-in-Force,Placed Time,Filled Time",
    `DEMO DAILY ZNRG BULL 2X SHARES,ZNRU,Sell,Filled,40,40,@12.4000000000,12.4100000000,DAY,${t("14:02:10")},${t("14:02:11")}`,
    `DEMO DAILY ZNRG BULL 2X SHARES,ZNRU,Buy,Filled,40,40,@12.0500000000,12.0500000000,DAY,${t("13:31:40")},${t("13:31:42")}`,
    `PLAZMIC MATERIALS,PLZM,Buy,Cancelled,0,100,@5.1000000000,,DAY,${t("11:15:00")},`,
    `QUBITEX SYSTEMS INC,QBTX,Sell,Filled,100,100,@4.6100000000,4.6100000000,DAY,${t("10:12:31")},${t("10:12:31")}`,
    `QUBITEX SYSTEMS INC,QBTX,Sell,Filled,100,100,@4.5200000000,4.5200000000,DAY,${t("09:58:05")},${t("09:58:06")}`,
    `QUBITEX SYSTEMS INC,QBTX,Buy,Filled,200,200,@4.4000000000,4.4000000000,DAY,${t("09:41:17")},${t("09:41:18")}`,
  ].join("\n");
  const schwab = [
    `"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"`,
    `"${us(d)}","Buy","AQRS","AQUARIS ENERGY","20","$66.15","","-$1,323.00"`,
    `"${us(d)}","MoneyLink Transfer","","Tfr DEMO BANK","","","","$500.00"`,
  ].join("\n");
  const stamp = `${d.replaceAll("-", "")}-170000`;
  return [
    { name: "Webull_Orders_Records.csv", text: `${webull}\n` },
    // Schwab exports start with a byte-order mark.
    { name: `Trading_XXX000_Transactions_${stamp}.csv`, text: `${String.fromCharCode(0xfeff)}${schwab}\n` },
  ];
}
