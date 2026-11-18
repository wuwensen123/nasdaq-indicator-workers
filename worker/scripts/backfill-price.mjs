// 回填专用：把「价格走势」并入 indicators 行对象。
// targetsData[t.id] 的当日价格优先用 price，缺失时回退技术序列当日 close（如某些标的只有技术代理）。
// 两者都没有时（数据源断供）不写该条目，避免造假。
// 第三参 ohlc = {o,h,l,c,d}（当日 as-of 的真实 OHLC）：有则写蜡烛图字段（v 仍为收盘价）。
export function priceOfTarget(td) {
  if (!td) return null;
  return td.price != null ? td.price : (td.technical?.close ?? null);
}

export function addPriceIndicator(ind, td, ohlc = null) {
  if (ohlc && ohlc.c != null) {
    ind['价格走势'] = { v: ohlc.c, s: null, o: ohlc.o, h: ohlc.h, l: ohlc.l, d: ohlc.d };
    return ind;
  }
  const px = priceOfTarget(td);
  if (px != null) ind['价格走势'] = { v: px, s: null };
  return ind;
}
