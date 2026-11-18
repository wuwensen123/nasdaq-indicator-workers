// 回填专用：把「价格走势」并入 indicators 行对象。
// targetsData[t.id] 的当日价格优先用 price，缺失时回退技术序列当日 close（如某些标的只有技术代理）。
// 两者都没有时（数据源断供）不写该条目，避免造假。
export function priceOfTarget(td) {
  if (!td) return null;
  return td.price != null ? td.price : (td.technical?.close ?? null);
}

export function addPriceIndicator(ind, td) {
  const px = priceOfTarget(td);
  if (px != null) ind['价格走势'] = { v: px, s: null };
  return ind;
}
