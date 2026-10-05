// The one place the workflows create a Yahoo client (SPEC §5.4). The library
// logs validation details that can include symbols, and the workflows' logs
// are public, so it always gets a silent logger and no validation output.
const silent = { info() {}, warn() {}, error() {}, debug() {}, dir() {} };

export async function yahooClient() {
  const { default: YahooFinance } = await import("yahoo-finance2");
  return new YahooFinance({ logger: silent, suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
}
