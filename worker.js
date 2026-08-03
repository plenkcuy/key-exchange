// ── Market Data Service ─────────────────────────────────────────
// Cache layer untuk data exchange (Binance/Bybit/OKX/Gate/MEXC/Bitget).
// Semua fetch ke exchange dilakukan di sini — bukan di browser.
//
// Strategi fetch:
//   1. Cache per field dengan TTL berbeda
//   2. In-flight deduplication — 1 fetch aktif per key
//   3. Cloudflare Worker proxy (jika CF_PROXY_URL di-set) — bypass Railway IP block
//   4. Binance-first: coba Binance dulu (timeout 6s)
//      Jika geo-block / gagal → langsung race 5 exchange fallback paralel
//   5. Fallback order: Bybit → OKX → Gate → MEXC → Bitget (Promise.any)
// ── Butuh Node 18+ (native fetch global) ─────────────────────

// ── Cloudflare Worker proxy config ───────────────────────────
// Set env vars di Railway:
//   CF_PROXY_URL    = https://exchange-proxy.YOUR_ACCOUNT.workers.dev
//   CF_PROXY_SECRET = secret random min 32 char (sama dengan PROXY_SECRET di CF Worker)
// Kalau tidak di-set → direct fetch (Railway IP mungkin di-block exchange)
const CF_PROXY_URL    = process.env.CF_PROXY_URL    || null
const CF_PROXY_SECRET = process.env.CF_PROXY_SECRET || ''

// ── Startup log — langsung kelihatan di Railway logs ─────────
if (CF_PROXY_URL) {
  console.log(`[MarketData] CF Proxy AKTIF → ${CF_PROXY_URL}`)
  console.log(`[MarketData] CF_PROXY_SECRET: ${CF_PROXY_SECRET ? `set (${CF_PROXY_SECRET.length} chars)` : '⚠️  KOSONG — request akan 401!'}`)
} else {
  console.warn('[MarketData] CF_PROXY_URL tidak di-set → direct fetch (kemungkinan geo-blocked)')
}

// ── Pre-block Railway-banned endpoints on startup ─────────────
// Railway IP di-block permanen oleh Binance (HTTP 451) dan Bitget (HTTP 403).
// Tanpa pre-block: setiap restart buang 1x timeout 6s per endpoint sebelum circuit breaker aktif.
// Dengan pre-block: langsung skip ke fallback dari request pertama — zero wasted timeout.
// Berlaku HANYA jika tidak ada CF_PROXY_URL (proxy bypass geo-block).
function _preBlockRailwayEndpoints() {
  if (CF_PROXY_URL) return   // CF proxy bypass geo-block — tidak perlu pre-block
  const RAILWAY_BLOCKED = [
    // Binance Futures — 451 Unavailable For Legal Reasons dari Railway IP
    'https://fapi.binance.com/fapi/v1/klines',
    'https://fapi.binance.com/fapi/v1/openInterest',
    'https://fapi.binance.com/fapi/v1/premiumIndex',
    'https://fapi.binance.com/fapi/v1/ticker',
    'https://fapi.binance.com/fapi/v1/forceOrders',
    'https://fapi.binance.com/futures/data/openInterestHist',
    'https://fapi.binance.com/futures/data/topLongShortPositionRatio',
    'https://fapi.binance.com/futures/data/globalLongShortAccountRatio',
    'https://fapi.binance.com/futures/data/takerlongshortRatio',
    // Bitget — 403 dari Railway IP
    'https://api.bitget.com/api/v2/mix/market/candles',
    'https://api.bitget.com/api/v2/mix/market/long-short-ratio',
    'https://api.bitget.com/api/v2/mix/market/taker-buy-sell-vol',
  ]
  // TTL 30 menit — cukup untuk session normal, tidak terlalu lama jika IP rotation terjadi
  const STARTUP_BLOCK_TTL = 30 * 60_000
  for (const url of RAILWAY_BLOCKED) {
    _geoBlocked.set(url, Date.now() + STARTUP_BLOCK_TTL)
  }
  console.log(`[MarketData] Pre-blocked ${RAILWAY_BLOCKED.length} Railway-banned endpoints (no CF proxy)`)
}
_preBlockRailwayEndpoints()

// ── Fetch helper — otomatis route via CF Worker jika dikonfigurasi ──
// Semua exchange call di file ini pakai apiFetch — tidak perlu ubah kode lain.
// Toggle: set/unset CF_PROXY_URL di Railway env.
// ── URL-level in-flight dedup ─────────────────────────────────
// Kalau URL yang sama sedang di-fetch (misal Bybit /tickers dipanggil
// oleh ticker() DAN markPrice() bersamaan), cukup 1 HTTP request yang
// keluar — keduanya dapat response yang sama. Ini menghilangkan
// duplicate request ke Gate/MEXC/Bitget/Bybit yang share 1 URL untuk
// beberapa method (ticker, markPrice, openInterest).
const _urlFlight = new Map()   // url → Promise<data>

async function apiFetch(url, ms = 8000) {
  // Dedup: kalau URL ini sudah in-flight, ikut promise yang ada
  if (_urlFlight.has(url)) return _urlFlight.get(url)

  const p = _doFetch(url, ms).finally(() => _urlFlight.delete(url))
  _urlFlight.set(url, p)
  return p
}

async function _doFetch(url, ms) {
  // ── Path A: Cloudflare Worker proxy ──────────────────────
  if (CF_PROXY_URL) {
    const ctrl = new AbortController()
    // Extra 3s untuk CF overhead (cold start worker + round trip)
    const tid = setTimeout(() => ctrl.abort(), ms + 3000)
    try {
      const res = await globalThis.fetch(CF_PROXY_URL, {
        method:  'POST',
        signal:  ctrl.signal,
        headers: {
          'Content-Type':   'application/json',
          'x-proxy-secret': CF_PROXY_SECRET,
        },
        body: JSON.stringify({ url, timeout: ms }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        // Log as warn not error — geo-block is expected for Railway IP (circuit breaker handles retry)
      console.warn(`[apiFetch] CF Proxy ${res.status} → ${url.split('?')[0]} | ${err.error || 'unknown'}`)
        throw new Error(`CF Proxy ${res.status}: ${err.error || 'unknown'}`)
      }
      return await res.json()
    } catch (e) {
      if (e.name === 'AbortError') {
        console.error(`[apiFetch] CF Proxy TIMEOUT (${ms}ms) → ${url}`)
      } else if (!e.message.startsWith('CF Proxy')) {
        console.error(`[apiFetch] CF Proxy network error → ${url} | ${e.message}`)
      }
      throw e
    } finally { clearTimeout(tid) }
  }

  // ── Path B: Direct fetch (fallback jika CF_PROXY_URL tidak di-set) ──
  const ctrl = new AbortController()
  const tid  = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await globalThis.fetch(url, {
      signal:  ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'TradingJournal/2.0' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn(`[apiFetch] Direct TIMEOUT (${ms}ms) → ${url}`)
    } else {
      console.warn(`[apiFetch] Direct fetch error → ${url} | ${e.message}`)
    }
    throw e
  } finally { clearTimeout(tid) }
}

const toOKX  = s => s.replace(/USDT$/, '-USDT-SWAP')
const toGate = s => s.replace(/USDT$/, '_USDT')
// Bitget & Binance pakai simbol yang sama (BTCUSDT), tidak perlu converter

// Bungkus promise dengan batas waktu — reject jika melebihi ms
// Timer di-clearTimeout segera saat promise utama selesai agar tidak ada idle timer leak
function withTimeout(promise, ms) {
  let timerId
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId))
}
const BINANCE_PRIORITY_MS = 6000  // BUG FIX: 6s — Railway cold start bisa 5s, 4s terlalu pendek

// ── Per-endpoint geo-block circuit breaker ────────────────────
// Masalah: kalau Binance kena geo-block di endpoint tertentu (misal
// takerlongshortRatio), setiap request buang 6 detik nunggu timeout
// sebelum fallback. Solusi: ingat endpoint mana yang blocked, skip
// langsung ke fallback. Endpoint Binance lain yang tidak blocked
// tetap jalan normal.
//
// Key = URL prefix (tanpa query string) agar semua simbol tergabung.
const _geoBlocked  = new Map()    // urlPrefix → blockedUntil (timestamp)
const GEOBLOCK_TTL = 5 * 60_000   // 5 menit sebelum retry Binance lagi

function _urlPrefix(url) {
  return url.split('?')[0]
}

function isBlocked(url) {
  const key   = _urlPrefix(url)
  const until = _geoBlocked.get(key)
  if (!until) return false
  if (Date.now() > until) { _geoBlocked.delete(key); return false }
  return true
}

function markBlocked(url, errMsg) {
  // Mark geo-block for permanent errors (403/451/418) on ANY exchange, not just Binance.
  // FIX 4: Bitget also returns 403 from Railway IP → needs same circuit-breaker treatment.
  const isGeo = /HTTP 40[138]|HTTP 451|CF Proxy 40[138]|CF Proxy 451|geo|legal|unavailable|Exchange HTTP 403|Exchange HTTP 451/i.test(errMsg)
  if (!isGeo) return false
  const key = _urlPrefix(url)
  if (!_geoBlocked.has(key)) {
    const host = (() => { try { return new URL(key).hostname } catch { return key } })()
    console.warn(`[GeoBlock] ⚠️  ${host} → ${key.split('/').slice(-2).join('/')} blocked — skip ${GEOBLOCK_TTL / 60_000} min`)
  }
  _geoBlocked.set(key, Date.now() + GEOBLOCK_TTL)
  return true
}

// Helper: coba Binance (skip jika blocked), fallback ke fungsi lain
async function withGeoFallback(fetchBinanceFn, binanceUrl, fallbackFn) {
  if (!isBlocked(binanceUrl)) {
    try {
      return await fetchBinanceFn()
    } catch (e) {
      markBlocked(binanceUrl, e.message || '')
      // Lanjut ke fallback
    }
  }
  return fallbackFn()
}


// ══════════════════════════════════════════════════════════════
// EXCHANGE ADAPTERS (server-side, tidak perlu proxy)
// ══════════════════════════════════════════════════════════════

// ── Binance ──────────────────────────────────────────────────
const B1 = 'https://fapi.binance.com/fapi/v1'
const B2 = 'https://fapi.binance.com/futures/data'
const binance = {
  name: 'Binance',
  async ticker(s)  { const d=await apiFetch(`${B1}/ticker/24hr?symbol=${s}`); return {high:+d.highPrice,low:+d.lowPrice,volume:+d.volume,priceChangePct:+d.priceChangePercent} },
  async markPrice(s) { const d=await apiFetch(`${B1}/premiumIndex?symbol=${s}`); return {mark:+d.markPrice,index:+d.indexPrice,funding:+d.lastFundingRate} },
  async klines(s,iv,lim) { const d=await apiFetch(`${B1}/klines?symbol=${s}&interval=${iv}&limit=${lim}`); return d.map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]})) },
  async openInterest(s) { const d=await apiFetch(`${B1}/openInterest?symbol=${s}`); return {oi:+d.openInterest} },
  async oiHistory(s,period='5m',lim=12) {
    const d=await apiFetch(`${B2}/openInterestHist?symbol=${s}&period=${period}&limit=${lim}`)
    if(!Array.isArray(d)||d.length<2) throw new Error('empty')
    const vals=d.map(o=>+o.sumOpenInterest)
    if(vals.every(v=>Math.abs(v-vals[0])/(vals[0]||1)<0.001)) throw new Error('flat')
    return d.map(o=>({oi:+o.sumOpenInterest,time:+o.timestamp}))
  },
  async longShortRatio(s) { const d=await apiFetch(`${B2}/globalLongShortAccountRatio?symbol=${s}&period=5m&limit=1`); const r=d[d.length-1]; if(!r||r.longAccount==null) throw new Error('Binance L/S ratio: empty'); return {longPct:+r.longAccount*100,shortPct:+r.shortAccount*100} },
  // topLongShortPositionRatio hanya tersedia untuk top-N liquid pairs — throw gracefully jika empty
  async longShortPosition(s) { const d=await apiFetch(`${B2}/topLongShortPositionRatio?symbol=${s}&period=5m&limit=1`); const r=d[d.length-1]; if(!r||r.longPosition==null) throw new Error('Binance position ratio: empty or unsupported symbol'); return {longPct:+r.longPosition*100,shortPct:+r.shortPosition*100} },
  // takerlongshortRatio — sering geo-blocked Railway IP, circuit breaker di fetchTaker() handle ini
  async takerVolume(s) { const d=await apiFetch(`${B2}/takerlongshortRatio?symbol=${s}&period=5m&limit=1`); const r=d[d.length-1]; if(!r||r.buyVol==null) throw new Error('Binance taker: empty'); const buy=+r.buyVol,sell=+r.sellVol,total=buy+sell; if(!total)throw new Error('zero'); return {buyPct:(buy/total)*100,sellPct:(sell/total)*100,buySellRatio:+r.buySellRatio} },
}

// ── Bybit ────────────────────────────────────────────────────
const BB = 'https://api.bybit.com/v5/market'
const bybit = {
  name: 'Bybit',
  async ticker(s)  { const d=await apiFetch(`${BB}/tickers?category=linear&symbol=${s}`); const t=d.result.list[0]; return {high:+t.highPrice24h,low:+t.lowPrice24h,volume:+t.volume24h,priceChangePct:+t.price24hPcnt*100} },
  async markPrice(s) { const d=await apiFetch(`${BB}/tickers?category=linear&symbol=${s}`); const t=d.result.list[0]; return {mark:+t.markPrice,index:+t.indexPrice,funding:+t.fundingRate} },
  // BUG-IV FIX: '4h' tidak ada di map → fallback '||60' kirim request 1h yang salah
  async klines(s,iv,lim) { const m={'1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'D'}; const d=await apiFetch(`${BB}/kline?category=linear&symbol=${s}&interval=${m[iv]||'60'}&limit=${lim}`); return [...d.result.list].reverse().map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]})) },
  async openInterest(s) { const d=await apiFetch(`${BB}/open-interest?category=linear&symbol=${s}&intervalTime=5min&limit=1`); return {oi:+d.result.list[0].openInterest} },
  async oiHistory(s,period='5m',lim=12) {
    const m={'5m':'5min','15m':'15min','1h':'1h'}
    const d=await apiFetch(`${BB}/open-interest?category=linear&symbol=${s}&intervalTime=${m[period]||'5min'}&limit=${lim}`)
    const list=d.result?.list; if(!list||list.length<2) throw new Error('empty')
    const sorted=[...list].reverse(); const vals=sorted.map(o=>+o.openInterest)
    if(vals.every(v=>Math.abs(v-vals[0])/(vals[0]||1)<0.001)) throw new Error('flat')
    return sorted.map(o=>({oi:+o.openInterest,time:+o.timestamp}))
  },
  async longShortRatio(s) { const d=await apiFetch(`${BB}/account-ratio?category=linear&symbol=${s}&period=5min&limit=1`); const r=d.result?.list?.[0]; if(!r)throw new Error('empty'); const lp=parseFloat(r.buyRatio)*100,sp=parseFloat(r.sellRatio)*100; if(isNaN(lp)||lp<=0)throw new Error('invalid'); return {longPct:lp,shortPct:sp} },
  // Bybit tidak punya endpoint position ratio terpisah — throw agar posR.data = null
  // dan consumer tahu data tidak tersedia (bukan data duplikat yang terlihat sebagai konfirmasi independen)
  async longShortPosition() { throw new Error('Bybit: no separate position ratio endpoint') },
  async takerVolume(s) { const d=await apiFetch(`${BB}/recent-trade?category=linear&symbol=${s}&limit=200`); const trades=d.result?.list||[]; if(!trades.length)throw new Error('empty'); let bv=0,sv=0; trades.forEach(t=>{const v=+t.size;if(t.side==='Buy')bv+=v;else sv+=v}); const tot=bv+sv; if(!tot)throw new Error('zero'); return {buyPct:(bv/tot)*100,sellPct:(sv/tot)*100,buySellRatio:sv>0?bv/sv:null} },
}

// ── OKX ──────────────────────────────────────────────────────
const OKX = 'https://www.okx.com/api/v5'
const okx = {
  name: 'OKX',
  async ticker(s) { const d=await apiFetch(`${OKX}/market/ticker?instId=${toOKX(s)}`); const t=d.data[0]; const last=+t.last,open24=+t.open24h; return {high:+t.high24h,low:+t.low24h,volume:+t.vol24h,priceChangePct:open24>0?((last-open24)/open24)*100:0} },
  // Bug F: OKX /public/mark-price hanya mengembalikan markPx, bukan indexPrice.
  // Sebelumnya index diisi dengan markPx (duplikat) → data misleading.
  // Set index: null agar consumer tahu data tidak tersedia dari OKX adapter ini.
  async markPrice(s) { const [mk,fu]=await Promise.all([apiFetch(`${OKX}/public/mark-price?instType=SWAP&instId=${toOKX(s)}`),apiFetch(`${OKX}/public/funding-rate?instId=${toOKX(s)}`)]); return {mark:+mk.data[0].markPx,index:null,funding:+fu.data[0].fundingRate} },
  // BUG-IV FIX: '4h' tidak ada di map → fallback '||1H' kirim request 1h yang salah
  async klines(s,iv,lim) { const m={'1m':'1m','5m':'5m','15m':'15m','1h':'1H','4h':'4H','1d':'1D'}; const d=await apiFetch(`${OKX}/market/candles?instId=${toOKX(s)}&bar=${m[iv]||'1H'}&limit=${lim}`); return [...d.data].reverse().map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]})) },
  async openInterest(s) { const d=await apiFetch(`${OKX}/public/open-interest?instType=SWAP&instId=${toOKX(s)}`); return {oi:+d.data[0].oi} },
  async oiHistory() { throw new Error('OKX no OI hist') },
  async longShortRatio(s) { const d=await apiFetch(`${OKX}/rubik/stat/contracts/long-short-account-ratio?instId=${toOKX(s)}&period=5m&limit=1`); const ratio=+d.data[0].longShortRatio; const lp=(ratio/(1+ratio))*100; return {longPct:lp,shortPct:100-lp} },
  // FIX 3: /rubik/stat/contracts/long-short-account-ratio-top-trader is DEPRECATED by OKX (returns 404).
  // New endpoint: /rubik/stat/contracts/long-short-account-ratio-top-trader (top-trader only).
  // If that also fails (not all symbols supported) → throw so caller falls back to Bybit.
  async longShortPosition(s) {
    const url = `${OKX}/rubik/stat/contracts/long-short-account-ratio-top-trader?instId=${toOKX(s)}&period=5m&limit=1`
    const d = await apiFetch(url)
    const row = d.data?.[0]
    if (!row || !row.longShortRatio) throw new Error('OKX top-trader pos ratio: empty')
    const ratio = +row.longShortRatio
    if (isNaN(ratio) || ratio <= 0) throw new Error('OKX top-trader pos ratio: invalid')
    const lp = (ratio / (1 + ratio)) * 100
    return { longPct: lp, shortPct: 100 - lp }
  },
  async takerVolume(s) { const d=await apiFetch(`${OKX}/rubik/stat/contracts/taker-volume?instId=${toOKX(s)}&period=5m&limit=1`); const r=d.data[0]; const buy=+r[2],sell=+r[1],total=buy+sell; if(!total)throw new Error('zero'); return {buyPct:(buy/total)*100,sellPct:(sell/total)*100,buySellRatio:sell>0?buy/sell:null} },
}

// ── Gate.io ──────────────────────────────────────────────────
const GT = 'https://api.gateio.ws/api/v4'
const gate = {
  name: 'Gate',
  async ticker(s) { const d=await apiFetch(`${GT}/futures/usdt/tickers?contract=${toGate(s)}`); return {high:+d[0].high_24h,low:+d[0].low_24h,volume:+d[0].volume_24h_base,priceChangePct:+d[0].change_percentage} },
  async markPrice(s) { const d=await apiFetch(`${GT}/futures/usdt/tickers?contract=${toGate(s)}`); return {mark:+d[0].mark_price,index:+d[0].index_price,funding:+d[0].funding_rate} },
  // BUG-IV FIX: '4h' tidak ada di map → fallback '||1h' kirim request 1h yang salah
  async klines(s,iv,lim) { const m={'1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d'}; const d=await apiFetch(`${GT}/futures/usdt/candlesticks?contract=${toGate(s)}&interval=${m[iv]||'1h'}&limit=${lim}`); return d.map(k=>({open:+k.o,high:+k.h,low:+k.l,close:+k.c,volume:+k.v})) },
  async openInterest(s) { const d=await apiFetch(`${GT}/futures/usdt/tickers?contract=${toGate(s)}`); return {oi:+d[0].total_size} },
  async oiHistory() { throw new Error('Gate no OI hist') },
  async longShortRatio() { return {longPct:50,shortPct:50} },
}

// ── MEXC ─────────────────────────────────────────────────────
const MX = 'https://contract.mexc.com/api/v1/contract'
const mexc = {
  name: 'MEXC',
  async ticker(s) { const d=await apiFetch(`${MX}/ticker?symbol=${s}`); const t=d.data; return {high:+t.high24Price,low:+t.low24Price,volume:+t.volume24,priceChangePct:+t.riseFallRate*100} },
  async markPrice(s) { const d=await apiFetch(`${MX}/ticker?symbol=${s}`); const t=d.data; return {mark:+t.lastPrice,index:+t.indexPrice||+t.lastPrice,funding:+t.fundingRate||0} },
  // BUG-IV FIX: '4h' tidak ada di map → fallback '||Hour1' kirim request 1h yang salah
  async klines(s,iv,lim) { const m={'1m':'Min1','5m':'Min5','15m':'Min15','1h':'Hour1','4h':'Hour4','1d':'Day1'}; const d=await apiFetch(`${MX}/kline/${s}?interval=${m[iv]||'Hour1'}&limit=${lim}`); return (d.data||[]).map(k=>({open:+k[1],high:+k[3],low:+k[4],close:+k[2],volume:+k[5]})) },
  async openInterest(s) { const d=await apiFetch(`${MX}/ticker?symbol=${s}`); return {oi:+d.data.holdVol||0} },
  async oiHistory() { throw new Error('MEXC no OI hist') },
  async longShortRatio() { return {longPct:50,shortPct:50} },
}

// ── Bitget ───────────────────────────────────────────────────
// API v2 Mix USDT-FUTURES. Simbol sama dengan Binance (BTCUSDT).
const BG = 'https://api.bitget.com/api/v2/mix/market'
const bitget = {
  name: 'Bitget',
  async ticker(s) {
    const d = await apiFetch(`${BG}/tickers?productType=USDT-FUTURES&symbol=${s}`)
    const t = d.data?.[0]
    if (!t) throw new Error('Bitget ticker: no data')
    return {
      high:           +t.high24h,
      low:            +t.low24h,
      volume:         +t.baseVolume,
      // priceChangePercent Bitget: desimal (0.0150 = 1.50%), kalikan 100
      priceChangePct: +t.priceChangePercent * 100,
    }
  },
  async markPrice(s) {
    const d = await apiFetch(`${BG}/tickers?productType=USDT-FUTURES&symbol=${s}`)
    const t = d.data?.[0]
    if (!t) throw new Error('Bitget markPrice: no data')
    return { mark: +t.markPrice, index: +t.indexPrice, funding: +t.fundingRate }
  },
  async klines(s, iv, lim) {
    const m = { '1m': '1min', '5m': '5min', '15m': '15min', '1h': '1H', '4h': '4H', '1d': '1D' }
    const url = `${BG}/candles?productType=USDT-FUTURES&symbol=${s}&granularity=${m[iv] || '1H'}&limit=${lim}`
    if (isBlocked(url)) throw new Error('Bitget klines: circuit-breaker open')
    try {
      const d = await apiFetch(url)
      if (!d.data?.length) throw new Error('Bitget klines: empty')
      return [...d.data].reverse().map(k => ({ open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }))
    } catch (e) {
      markBlocked(url, e.message || '')
      throw e
    }
  },
  async openInterest(s) {
    const d    = await apiFetch(`${BG}/open-interest?productType=USDT-FUTURES&symbol=${s}`)
    const size = d.data?.openInterestList?.[0]?.size
    if (size == null) throw new Error('Bitget OI: no data')
    return { oi: +size }
  },
  // Bitget tidak punya OI history endpoint publik yang konsisten
  async oiHistory() { throw new Error('Bitget no OI hist') },
  async longShortRatio(s) {
    const url = `${BG}/long-short-ratio?productType=USDT-FUTURES&symbol=${s}&period=5min&limit=1`
    // FIX 5: check circuit-breaker — Bitget 403 blocks Railway IP for 5 min
    if (isBlocked(url)) throw new Error('Bitget L/S ratio: circuit-breaker open')
    try {
      const d = await apiFetch(url)
      const r = d.data?.[0]
      if (!r) throw new Error('Bitget L/S ratio: empty')
      const ratio = +r.longShortRatio
      if (isNaN(ratio) || ratio <= 0) throw new Error('Bitget L/S ratio: invalid')
      const lp = (ratio / (1 + ratio)) * 100
      return { longPct: lp, shortPct: 100 - lp }
    } catch (e) {
      markBlocked(url, e.message || '')
      throw e
    }
  },
  async longShortPosition(s) { return bitget.longShortRatio(s) },
  async takerVolume(s) {
    const d = await apiFetch(`${BG}/taker-buy-sell-vol?productType=USDT-FUTURES&symbol=${s}&period=5min&limit=1`)
    const r = d.data?.[0]
    if (!r) throw new Error('Bitget taker vol: empty')
    const buy = +r.buyVolCoin, sell = +r.sellVolCoin, total = buy + sell
    if (!total) throw new Error('Bitget taker vol: zero')
    return { buyPct: (buy / total) * 100, sellPct: (sell / total) * 100, buySellRatio: sell > 0 ? buy / sell : null }
  },
}


// ── Hyperliquid ──────────────────────────────────────────────
// Public REST, tidak butuh API key, tidak ada geo-block dari Railway.
// Endpoint: POST https://api.hyperliquid.xyz/info
// Dipakai sebagai fallback setelah Bybit jika semua exchange lain gagal.
// Mendukung: ticker, markPrice, klines, openInterest.
// Tidak punya L/S ratio endpoint publik — skip untuk raceLS.
const HL_BASE = 'https://api.hyperliquid.xyz/info'

// Convert BTCUSDT → BTC, ETHUSDT → ETH, SOLUSDT → SOL
function toHL(sym) {
  return sym.replace(/USDT$/i, '').replace(/USDC$/i, '').toUpperCase()
}

// Interval map: TradingView/standard → Hyperliquid format
const HL_IV = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' }

async function hlPost(body) {
  // Route via CF Worker jika tersedia — konsisten dengan exchange lain
  if (CF_PROXY_URL) {
    const ctrl = new AbortController()
    const tid  = setTimeout(() => ctrl.abort(), 10000)
    try {
      const res = await globalThis.fetch(CF_PROXY_URL, {
        method:  'POST',
        signal:  ctrl.signal,
        headers: {
          'Content-Type':   'application/json',
          'x-proxy-secret': CF_PROXY_SECRET,
        },
        // CF Worker forward POST body sebagai-is ke upstream
        body: JSON.stringify({ url: HL_BASE, method: 'POST', body: JSON.stringify(body), timeout: 8000 }),
      })
      if (!res.ok) throw new Error(`CF→Hyperliquid HTTP ${res.status}`)
      return res.json()
    } finally { clearTimeout(tid) }
  }
  // Direct fetch fallback (Hyperliquid tidak geo-block datacenter)
  const res = await globalThis.fetch(HL_BASE, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`)
  return res.json()
}

// Cache metaAndAssetCtxs 20 detik — endpoint berat, hindari call berulang
let _hlMeta     = null
let _hlMetaTs   = 0
const HL_META_TTL = 20_000

async function getHLMeta() {
  if (_hlMeta && Date.now() - _hlMetaTs < HL_META_TTL) return _hlMeta
  const data = await hlPost({ type: 'metaAndAssetCtxs' })
  _hlMeta   = data
  _hlMetaTs = Date.now()
  return data
}

async function getHLAsset(sym) {
  const [meta, ctxs] = await getHLMeta()
  const coin  = toHL(sym)
  const idx   = meta.universe.findIndex(a => a.name === coin)
  if (idx === -1) throw new Error(`Hyperliquid: ${coin} not found`)
  return { asset: meta.universe[idx], ctx: ctxs[idx] }
}

const hyperliquid = {
  name: 'Hyperliquid',
  async ticker(s) {
    const { ctx } = await getHLAsset(s)
    const mark   = parseFloat(ctx.markPx || ctx.midPx || ctx.prevDayPx) || 0
    const prev   = parseFloat(ctx.prevDayPx) || mark
    const chgPct = prev > 0 ? ((mark - prev) / prev) * 100 : 0
    return {
      high:          mark * 1.002,  // HL tidak punya high/low 24h — estimasi dari mark
      low:           mark * 0.998,
      volume:        parseFloat(ctx.dayNtlVlm) / mark || 0,  // notional → base
      priceChangePct: chgPct,
    }
  },
  async markPrice(s) {
    const { ctx } = await getHLAsset(s)
    return {
      mark:    parseFloat(ctx.markPx    || ctx.midPx) || 0,
      index:   parseFloat(ctx.oraclePx  || ctx.markPx) || 0,
      funding: parseFloat(ctx.funding)  || 0,
    }
  },
  async klines(s, iv, lim) {
    const coin     = toHL(s)
    const interval = HL_IV[iv] || '1h'
    const now      = Date.now()
    // Hitung startTime berdasarkan interval dan limit
    const msMap  = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }
    const startTime = now - (msMap[iv] || 3_600_000) * lim
    const data = await hlPost({
      type: 'candleSnapshot',
      req:  { coin, interval, startTime, endTime: now },
    })
    if (!Array.isArray(data) || !data.length) throw new Error('Hyperliquid klines: empty')
    return data.slice(-lim).map(k => ({
      open:   parseFloat(k.o),
      high:   parseFloat(k.h),
      low:    parseFloat(k.l),
      close:  parseFloat(k.c),
      volume: parseFloat(k.v),
    }))
  },
  async openInterest(s) {
    const { ctx } = await getHLAsset(s)
    const oi = parseFloat(ctx.openInterest)
    if (!oi || isNaN(oi)) throw new Error('Hyperliquid OI: no data')
    return { oi }
  },
  async oiHistory() { throw new Error('Hyperliquid: no OI history endpoint') },
  async longShortRatio() { throw new Error('Hyperliquid: no L/S ratio endpoint') },
  async longShortPosition() { throw new Error('Hyperliquid: no position ratio endpoint') },
  async takerVolume() { throw new Error('Hyperliquid: no taker volume endpoint') },
}

// ── Daftar Exchange ──────────────────────────────────────────
const ALL      = [binance, bybit, okx, gate, mexc, bitget]
const FALLBACK = [bybit, hyperliquid, okx, gate, mexc, bitget]   // waterfall jika Binance gagal

// ── Per-exchange failure tracker ─────────────────────────────
// Berbeda dari circuit breaker URL — ini track kegagalan per exchange object
// Jika exchange X gagal 3x dalam 5 menit → skip 2 menit
const _exFails  = new Map()   // exName → { count, skipUntil }
const EX_MAX    = 3
const EX_SKIP   = 2 * 60_000   // 2 menit skip
const EX_WINDOW = 5 * 60_000   // reset count setelah 5 menit tanpa gagal

function isExSkipped(name) {
  const e = _exFails.get(name)
  if (!e) return false
  if (Date.now() > e.skipUntil + EX_SKIP) { _exFails.delete(name); return false }
  return Date.now() < e.skipUntil
}
function recordExFail(name) {
  const now = Date.now()
  const e   = _exFails.get(name) || { count: 0, skipUntil: 0, lastFail: 0 }
  if (now - e.lastFail > EX_WINDOW) e.count = 0   // reset jika lama tidak gagal
  e.count++; e.lastFail = now
  if (e.count >= EX_MAX) {
    e.skipUntil = now + EX_SKIP
    console.warn(`[binanceFirst] ${name} skip 2min (failed ${e.count}x)`)
  }
  _exFails.set(name, e)
}
function recordExOk(name) {
  _exFails.delete(name)
}
const LS_EX    = [bybit, okx, bitget]               // fallback L/S (selain Binance)

// ── Binance-first helpers ─────────────────────────────────────
// Coba Binance dulu dalam BINANCE_PRIORITY_MS (4s).
// Jika geo-block / error / lambat → langsung race 5 fallback paralel.
// Tidak menunggu Binance 8s penuh sebelum memulai fallback.

async function binanceFirst(method, sym, ...args) {
  // Build a representative URL for circuit-breaker bookkeeping.
  // binance uses B1 for most methods and B2 for history endpoints.
  const _binanceUrlHint = method === 'oiHistory'          ? `${B2}/openInterestHist`
    : method === 'longShortPosition'                      ? `${B2}/topLongShortPositionRatio`
    : method === 'longShortRatio'                         ? `${B2}/globalLongShortAccountRatio`
    : method === 'takerVolume'                            ? `${B2}/takerlongshortRatio`
    : method === 'klines'                                 ? `${B1}/klines`
    : method === 'openInterest'                           ? `${B1}/openInterest`
    : `${B1}/${method}`

  if (!isBlocked(_binanceUrlHint)) {
    try {
      const data = await withTimeout(binance[method](sym, ...args), BINANCE_PRIORITY_MS)
      return { data, source: 'Binance', marketType: 'futures' }
    } catch (e) {
      // FIX: mark blocked so we skip Binance for GEOBLOCK_TTL (5 min)
      markBlocked(_binanceUrlHint, e.message || '')
    }
  }
  // Binance blocked/failed → race all fallbacks yang punya method ini
  const valid = FALLBACK.filter(ex => typeof ex[method] === 'function')

  // Coba waterfall per-exchange daripada Promise.any race
  // Alasan: Promise.any menunggu SEMUA reject → lambat saat banyak timeout
  // Waterfall: stop di exchange pertama yang berhasil → lebih cepat
  for (const ex of valid) {
    // Skip exchange yang baru saja gagal berulang
    if (isExSkipped(ex.name)) {
      console.warn(`[binanceFirst] skip ${ex.name} (cooling down)`)
      continue
    }
    try {
      const data = await Promise.race([
        ex[method](sym, ...args),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 7000)),
      ])
      if (data != null) {
        recordExOk(ex.name)
        return { data, source: ex.name, marketType: 'futures' }
      }
      recordExFail(ex.name)
    } catch (e) {
      recordExFail(ex.name)
      console.warn(`[binanceFirst] ${ex.name}.${method}(${sym}): ${e.message?.slice(0,60)}`)
    }
  }

  // Semua gagal — return null daripada throw 500
  // Komponen yang memanggil harus handle null dengan graceful degradation
  console.error(`[binanceFirst] ${method}(${sym}): all exchanges failed — returning null`)
  return null
}

// OI History: hanya Binance + Bybit yang punya endpoint publik
async function raceOI(sym, period, limit) {
  const BINANCE_OI_URL = `${B2}/openInterestHist`
  const OI_SOURCES = [
    // FIX 2: skip Binance OI hist if circuit-breaker says it's blocked
    ...(!isBlocked(BINANCE_OI_URL)
      ? [() => binance.oiHistory(sym, period, limit)
            .then(d => ({ data: d, source: 'Binance' }))
            .catch(e => { markBlocked(BINANCE_OI_URL, e.message || ''); throw e })]
      : []),
    () => bybit.oiHistory(sym, period, limit).then(d => ({ data: d, source: 'Bybit' })),
  ]
  if (!OI_SOURCES.length) {
    return { data: null, source: 'unavailable', marketType: 'futures', needsVpn: true }
  }
  try {
    const result = await Promise.any(OI_SOURCES.map(fn => fn()))
    return { data: result.data, source: result.source, marketType: 'futures', needsVpn: false }
  } catch {
    return { data: null, source: 'unavailable', marketType: 'futures', needsVpn: true }
  }
}

function isRealLS(d) { return d && Math.abs(d.longPct - 50) > 0.1 }

// L/S Ratio: Binance-first per komponen, fallback race LS_EX
async function raceLS(sym) {
  const DEFAULT = { longPct: 50, shortPct: 50 }

  async function fetchLS(method) {
    try {
      const d = await withTimeout(binance[method](sym), BINANCE_PRIORITY_MS)
      if (!isRealLS(d)) throw new Error('no real data')
      return { data: d, source: 'Binance' }
    } catch {
      return Promise.any(
        LS_EX.map(ex => ex[method](sym)
          .then(d => { if (!isRealLS(d)) throw new Error('no real'); return { data: d, source: ex.name } })
        )
      ).catch(() => ({ data: null, source: 'unavailable' }))
    }
  }

  const TAKER_URL = `${B2}/takerlongshortRatio`

  async function fetchTaker() {
    // takerlongshortRatio sering geo-blocked dari Railway IP — skip Binance jika sedang blocked
    if (!isBlocked(TAKER_URL)) {
      try {
        const d = await withTimeout(binance.takerVolume(sym), BINANCE_PRIORITY_MS)
        if (!d || isNaN(d.buyPct)) throw new Error('invalid')
        return { data: d, source: 'Binance' }
      } catch (e) {
        markBlocked(TAKER_URL, e.message || '')
        // jatuh ke fallback di bawah
      }
    }
    return Promise.any(
      LS_EX.map(ex => ex.takerVolume(sym)
        .then(d => { if (!d || isNaN(d.buyPct)) throw new Error('invalid'); return { data: d, source: ex.name } })
      )
    ).catch(() => ({ data: null, source: 'unavailable' }))
  }

  const [accR, posR, takR] = await Promise.all([
    fetchLS('longShortRatio').then(r => r.data ? r : { data: DEFAULT, source: r.source }),
    // longShortPosition: Binance hanya support liquid pairs, OKX endpoint sering restricted
    // Kalau semua LS_EX gagal → coba Bybit account-ratio sebagai proxy terakhir (lebih baik dari null)
    fetchLS('longShortPosition').then(r => {
      if (r.data) return r
      // Semua gagal — coba Bybit account-ratio sebagai last resort proxy
      return bybit.longShortRatio(sym)
        .then(d => ({ data: d, source: 'Bybit (proxy)' }))
        .catch(() => ({ data: null, source: 'unavailable' }))
    }),
    fetchTaker(),
  ])

  return {
    data: { ...accR.data, position: posR.data || null, taker: takR.data || null },
    source: accR.source, sourcePos: posR.source, sourceTaker: takR.source,
    marketType: 'futures',
  }
}

async function fetchBtcDominance() {
  try {
    const d = await apiFetch('https://api.coinlore.net/api/global/', 8000)
    const j = Array.isArray(d) ? d[0] : d
    return { btcDom: parseFloat(j.btc_d) || 0, ethDom: parseFloat(j.eth_d) || 0, source: 'CoinLore', marketType: 'spot' }
  } catch { return { btcDom: 0, ethDom: 0, source: 'unavailable', marketType: 'spot' } }
}

async function fetchBtcMarket() {
  try {
    const [tr, kr] = await Promise.all([
      apiFetch('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT'),
      apiFetch('https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=6'),
    ])
    const t      = tr.result?.list?.[0]
    const klines = [...(kr.result?.list || [])].reverse()
    const price     = t ? +t.markPrice : 0
    const change24h = t ? +t.price24hPcnt * 100 : 0
    const recent    = klines.slice(-3).map(k => +k[4])
    const priceDir  = recent.length >= 2
      ? (recent.at(-1) > recent[0]*1.002 ? 'up' : recent.at(-1) < recent[0]*0.998 ? 'down' : 'stable')
      : (change24h > 1 ? 'up' : change24h < -1 ? 'down' : 'stable')
    return { price, change24h, priceDir, source: 'Bybit', marketType: 'futures' }
  } catch { return { price: 0, change24h: 0, priceDir: 'stable', source: 'unavailable', marketType: 'futures' } }
}

// ══════════════════════════════════════════════════════════════
// CACHE ENGINE
// ══════════════════════════════════════════════════════════════

// TTL per field (ms)
const TTL = {
  ticker:    30_000,           // naik dari 15s → 30s (harga ticker tidak berubah drastis tiap 15s)
  mark:      20_000,           // naik dari 10s → 20s (mark price stabil, bukan tick-by-tick)
  klines5m:  30_000,
  klines15m: 60_000,
  klines1h:  5  * 60_000,
  klines4h:  4  * 60_000,
  klines1d:  30 * 60_000,
  oi:        30_000,           // naik dari 20s → 30s
  oiHist5m:  5  * 60_000,
  oiHist15m: 15 * 60_000,
  oiHist1h:  60 * 60_000,
  ls:        45_000,           // naik dari 30s → 45s (L/S ratio tidak perlu real-time ketat)
  btcDom:    5 * 60_000,
  btcMarket: 45_000,           // naik dari 30s → 45s
}

// Cache per symbol: Map<symbol, { field: { data, source?, fetchedAt }, _lastAccessed }>
const cache    = new Map()
// In-flight dedup: Map<"symbol:field", Promise>
const inFlight = new Map()

// Bug #15: batas max symbol dan TTL tidak diakses
const CACHE_MAX_AGE     = 30 * 60_000   // 30 menit idle → evict
const CACHE_MAX_SYMBOLS = 500            // hard cap — cegah DoS via ribuan symbol unik

function getCache(sym) {
  if (!cache.has(sym)) {
    // LRU-lite: kalau sudah penuh, hapus entry yang paling lama tidak diakses
    if (cache.size >= CACHE_MAX_SYMBOLS) {
      let oldest = null, oldestTime = Infinity
      for (const [s, e] of cache) {
        if ((e._lastAccessed || 0) < oldestTime) { oldest = s; oldestTime = e._lastAccessed || 0 }
      }
      if (oldest) cache.delete(oldest)
    }
    cache.set(sym, { _lastAccessed: Date.now() })
  }
  const entry = cache.get(sym)
  entry._lastAccessed = Date.now()   // update setiap akses
  return entry
}

// Evict symbol yang tidak diakses > 30 menit — jalankan tiap 15 menit
setInterval(() => {
  const now = Date.now()
  let evicted = 0
  for (const [sym, entry] of cache) {
    if (now - (entry._lastAccessed || 0) > CACHE_MAX_AGE) {
      cache.delete(sym)
      evicted++
    }
  }
  if (evicted > 0) {
    console.log(`[MarketCache] Evicted ${evicted} stale symbols. Remaining: ${cache.size}`)
  }
}, 15 * 60_000)

function isFresh(entry, field) {
  return entry[field] && (Date.now() - entry[field].fetchedAt) < TTL[field]
}

// ── fetchField ────────────────────────────────────────────────
// fetchFn bisa return:
//   a) plain data (array / object biasa)
//   b) { _d: data, _s: source } — sentinel khusus untuk source tracking
//      dipakai oleh fetch regular (ticker, mark, klines, oi)
//   c) { data, source, ...extra } — dari raceOI/raceLS, disimpan as-is
//      sebagai cache.data agar metadata (needsVpn, sourcePos, dll) tidak hilang
async function fetchField(sym, field, fetchFn) {
  const key = `${sym}:${field}`
  if (inFlight.has(key)) return inFlight.get(key)

  const p = fetchFn().then(raw => {
    // Deteksi sentinel { _d, _s, _mt } — dipakai untuk source + marketType tracking
    const isSentinel = raw !== null && typeof raw === 'object'
      && '_d' in raw && '_s' in raw

    const data       = isSentinel ? raw._d  : raw
    const source     = isSentinel ? raw._s  : undefined
    const marketType = isSentinel ? (raw._mt || 'futures') : 'futures'

    // Jangan cache null/undefined/empty array — biarkan request berikutnya retry langsung
    const isEmpty = Array.isArray(data) && data.length === 0
    if (data !== null && data !== undefined && !isEmpty) {
      getCache(sym)[field] = { data, source, marketType, fetchedAt: Date.now() }
    }
    inFlight.delete(key)
    return data
  }).catch(err => {
    inFlight.delete(key)
    // Graceful degradation: return null daripada throw
    // Caller harus cek null dan handle — tidak propagate ke 500
    console.warn(`[fetchField] ${sym}:${field} failed: ${err.message?.slice(0,80)}`)
    return null
  })

  inFlight.set(key, p)
  return p
}

// Ambil field — dari cache kalau masih fresh, fetch kalau expired
async function get(sym, field, fetchFn) {
  const entry = getCache(sym)
  if (isFresh(entry, field)) return entry[field].data
  return fetchField(sym, field, fetchFn)
}

// ── Sentinel helper ───────────────────────────────────────────
// Bungkus hasil race() agar source tersimpan di cache via fetchField
function src(raceResult) {
  // Guard: binanceFirst return null jika semua exchange gagal
  if (!raceResult) return { _d: null, _s: 'unavailable' }
  return { _d: raceResult.data, _s: raceResult.source }
}

// ── Global cache (tidak per symbol) ──────────────────────────
let _btcDomCache    = null
let _btcMarketCache = null

async function getBtcDom() {
  if (_btcDomCache && Date.now() - _btcDomCache.fetchedAt < TTL.btcDom) return _btcDomCache.data
  if (inFlight.has('global:btcDom')) return inFlight.get('global:btcDom')
  const p = fetchBtcDominance().then(d => { _btcDomCache = { data: d, fetchedAt: Date.now() }; inFlight.delete('global:btcDom'); return d }).catch(e => { inFlight.delete('global:btcDom'); throw e })
  inFlight.set('global:btcDom', p)
  return p
}

async function getBtcMarket() {
  if (_btcMarketCache && Date.now() - _btcMarketCache.fetchedAt < TTL.btcMarket) return _btcMarketCache.data
  if (inFlight.has('global:btcMarket')) return inFlight.get('global:btcMarket')
  const p = fetchBtcMarket().then(d => { _btcMarketCache = { data: d, fetchedAt: Date.now() }; inFlight.delete('global:btcMarket'); return d }).catch(e => { inFlight.delete('global:btcMarket'); throw e })
  inFlight.set('global:btcMarket', p)
  return p
}

// ══════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// GET /api/market/:symbol/liquidations
// Fetch force orders Binance + Bybit server-side (no CORS, no geo-block di browser).
// Dipanggil oleh: exchangeAdapters.buildLiqHeatmap() — menggantikan df() langsung.
// PENTING: harus dideklarasi SEBELUM /:symbol agar 'liquidations' tidak ditangkap param.
// ══════════════════════════════════════════════════════════════

export async function fetchExchangeLiquidations(sym) {
  const BINANCE_FORCE_URL = 'https://fapi.binance.com/fapi/v1/forceOrders'
  // FIX 6a: skip Binance forceOrders if circuit-breaker says it's geo-blocked (HTTP 451)
  const binanceLiqPromise = isBlocked(BINANCE_FORCE_URL)
    ? Promise.resolve([])
    : apiFetch(`${BINANCE_FORCE_URL}?symbol=${sym}&limit=200`)
        .then(d => (Array.isArray(d) ? d : []).map(o => ({
          exchange:   'Binance',
          marketType: 'futures',
          side:       o.side,
          price:      +o.price,
          qty:        +o.origQty,
          value:      +o.price * +o.origQty,
          time:       +o.time,
        })))
        .catch(e => { markBlocked(BINANCE_FORCE_URL, e.message || ''); return [] })

  // FIX 6b: Bybit /v5/market/liquidation returns 404 for less-liquid symbols.
  // Also try /v5/market/recent-trade as proxy for liquidation heatmap data.
  const BYBIT_LIQ_URL = `https://api.bybit.com/v5/market/liquidation`
  const bybitLiqPromise = isBlocked(BYBIT_LIQ_URL + `?category=linear&symbol=${sym}`)
    ? Promise.resolve([])
    : apiFetch(
        `${BYBIT_LIQ_URL}?category=linear&symbol=${sym}&limit=200`
      )
        .then(d => (d.result?.list || []).map(o => ({
          exchange:   'Bybit',
          marketType: 'futures',
          side:       o.side,
          price:      +o.price,
          qty:        +o.size,
          value:      +o.price * +o.size,
          time:       +o.updatedTime,
        })))
        .catch(e => {
          // 404 for illiquid symbols — circuit-break so we stop retrying every request
          markBlocked(`${BYBIT_LIQ_URL}?category=linear&symbol=${sym}`, e.message || '')
          return []
        })

  const [bl, byl] = await Promise.all([binanceLiqPromise, bybitLiqPromise])
  return [...bl, ...byl]
}

/**
 * Ambil semua market data untuk 1 symbol.
 * Format return identik dengan fetchAllMarketData() di frontend.
 */

// ── Per-TF independent klines fetch ───────────────────────────
// Each TF has its own fallback chain: Bybit first (reliable, no geo-block),
// then OKX, Gate, MEXC as fallbacks. Binance fapi tried last only if not blocked.
// Returns sentinel { _d: klines[], _s: sourceName }
async function fetchKlinesTF(sym, interval, limit) {
  // Bybit is most reliable from Railway — try first
  const tryBybit = () => bybit.klines(sym, interval, limit)
    .then(d => { if (!d?.length) throw new Error('empty'); return { _d: d, _s: 'Bybit' } })

  const tryHL    = () => hyperliquid.klines(sym, interval, limit)
    .then(d => { if (!d?.length) throw new Error('empty'); return { _d: d, _s: 'Hyperliquid' } })

  const tryOKX   = () => okx.klines(sym, interval, limit)
    .then(d => { if (!d?.length) throw new Error('empty'); return { _d: d, _s: 'OKX' } })

  const tryGate  = () => gate.klines(sym, interval, limit)
    .then(d => { if (!d?.length) throw new Error('empty'); return { _d: d, _s: 'Gate' } })

  const tryMEXC  = () => mexc.klines(sym, interval, limit)
    .then(d => { if (!d?.length) throw new Error('empty'); return { _d: d, _s: 'MEXC' } })

  const tryBinance = () => {
    const hint = `${B1}/klines`
    if (isBlocked(hint)) return Promise.reject(new Error('Binance klines: blocked'))
    return binance.klines(sym, interval, limit)
      .then(d => { if (!d?.length) throw new Error('empty'); return { _d: d, _s: 'Binance' } })
      .catch(e => { markBlocked(hint, e.message || ''); throw e })
  }

  // Sequential: Bybit → OKX → Gate → MEXC → Binance
  // Sequential (not race) to avoid hammering all exchanges for every TF simultaneously
  const chain = [tryBybit, tryHL, tryOKX, tryGate, tryMEXC, tryBinance]
  for (const fn of chain) {
    try {
      return await withTimeout(fn(), 8000)
    } catch (_) {
      // try next
    }
  }
  // All failed
  console.warn(`[fetchKlinesTF] ${sym} ${interval} — all exchanges failed, returning empty`)
  return { _d: [], _s: 'unavailable' }
}

export async function getAllMarketData(symbol) {
  const sym = symbol.toUpperCase().trim()

  const [tickerR, markR, k1hR, k15mR, k5mR, k4hR, k1dR, oiR, oi5mR, oi15mR, oi1hR, lsR, btcDomR, btcMktR] =
    await Promise.all([
      // Binance-first — sentinel src() agar exchange yang menang tersimpan di cache
      get(sym, 'ticker',    () => binanceFirst('ticker',       sym).then(src).catch(() => ({ _d: null, _s: 'unavailable' }))),
      get(sym, 'mark',      () => binanceFirst('markPrice',    sym).then(src).catch(() => ({ _d: null, _s: 'unavailable' }))),
      // Klines: per-TF independent fallback chains.
      // FIX: sebelumnya semua TF pakai binanceFirst() pool yang sama → kalau Binance blocked,
      // semua TF race 5 exchange sekaligus → rate limit → partial empty array.
      // Fix: setiap TF punya chain sendiri — Bybit primary (stabil), OKX/Gate fallback.
      get(sym, 'klines1h',  () => fetchKlinesTF(sym, '1h',  50)),
      get(sym, 'klines15m', () => fetchKlinesTF(sym, '15m', 50)),
      get(sym, 'klines5m',  () => fetchKlinesTF(sym, '5m',  50)),
      get(sym, 'klines4h',  () => fetchKlinesTF(sym, '4h',  50)),
      get(sym, 'klines1d',  () => fetchKlinesTF(sym, '1d',  50)),
      get(sym, 'oi',        () => binanceFirst('openInterest', sym).then(src).catch(() => ({ _d: null, _s: 'unavailable' }))),
      // OI history & LS — return object metadata lengkap (needsVpn, sourcePos, dll)
      get(sym, 'oiHist5m',  () => raceOI(sym, '5m',  12).then(r => ({ data: r.data, source: r.source, needsVpn: r.needsVpn })).catch(() => ({ data: [], source: 'unavailable', needsVpn: false }))),
      get(sym, 'oiHist15m', () => raceOI(sym, '15m', 12).then(r => ({ data: r.data, source: r.source, needsVpn: r.needsVpn })).catch(() => ({ data: [], source: 'unavailable', needsVpn: false }))),
      get(sym, 'oiHist1h',  () => raceOI(sym, '1h',  12).then(r => ({ data: r.data, source: r.source, needsVpn: r.needsVpn })).catch(() => ({ data: [], source: 'unavailable', needsVpn: false }))),
      get(sym, 'ls',        () => raceLS(sym).then(r => ({ data: r.data, source: r.source, sourcePos: r.sourcePos, sourceTaker: r.sourceTaker })).catch(() => ({ data: null, source: 'unavailable', needsVpn: true }))),
      getBtcDom().catch(() => ({ btcDom: 0, ethDom: 0, source: 'unavailable', marketType: 'spot' })),
      getBtcMarket().catch(() => ({ price: 0, change24h: 0, priceDir: 'stable', source: 'unavailable', marketType: 'futures' })),
    ])

  const entry = getCache(sym)

  return {
    ticker:    tickerR,
    mark:      markR,
    klines1h:  k1hR,
    klines15m: k15mR,
    klines5m:  k5mR  ?? [],
    klines4h:  k4hR  ?? [],   // baru — 50 bar 4h (TTL 4 menit)
    klines1d:  k1dR  ?? [],   // baru — 50 bar 1d (TTL 30 menit)
    oi:        oiR,
    // oiHist* & ls: extract .data untuk payload (source ada di oiSources/lsSources)
    oiHist5m:  oi5mR?.data  ?? null,
    oiHist15m: oi15mR?.data ?? null,
    oiHist1h:  oi1hR?.data  ?? null,
    oiSources: {
      '5m':        oi5mR?.source  || 'unavailable',
      '15m':       oi15mR?.source || 'unavailable',
      '1h':        oi1hR?.source  || 'unavailable',
      marketType:  'futures',
    },
    oiNeedsVpn: (oi5mR?.needsVpn !== false) && (oi15mR?.needsVpn !== false) && (oi1hR?.needsVpn !== false),
    ls:        lsR?.data ?? null,
    lsSources: {
      account:    lsR?.source      || 'unavailable',
      position:   lsR?.sourcePos   || 'unavailable',
      taker:      lsR?.sourceTaker || 'unavailable',
      marketType: 'futures',
    },
    btcDom:    btcDomR,
    btcMarket: btcMktR,
    // sources: exchange yang berhasil menang race untuk tiap field + marketType spot/futures.
    // Semua data di sini adalah FUTURES. Frontend bisa pakai marketType sebagai label.
    sources: {
      price:      entry.mark?.source     || 'unavailable',
      ticker:     entry.ticker?.source   || 'unavailable',
      klines:     entry.klines1h?.source || 'unavailable',
      oi:         entry.oi?.source       || 'unavailable',
      ls:         lsR?.source            || 'unavailable',
      // marketType per field — semua futures, tapi disertakan agar FE tidak perlu hardcode
      marketTypes: {
        price:  entry.mark?.marketType     || 'futures',
        ticker: entry.ticker?.marketType   || 'futures',
        klines: entry.klines1h?.marketType || 'futures',
        oi:     entry.oi?.marketType       || 'futures',
        ls:     lsR?.marketType            || 'futures',
      },
    },
    klinesSources: {
      '5m':       entry.klines5m?.source  || 'unavailable',
      '15m':      entry.klines15m?.source || 'unavailable',
      '1h':       entry.klines1h?.source  || 'unavailable',
      '4h':       entry.klines4h?.source  || 'unavailable',
      '1d':       entry.klines1d?.source  || 'unavailable',
      marketType: 'futures',
    },
    _cacheAge: entry.mark ? Date.now() - entry.mark.fetchedAt : 0,
  }
}

/**
 * Invalidate cache 1 symbol (paksa re-fetch berikutnya)
 */
export function invalidateSymbol(symbol) {
  cache.delete(symbol.toUpperCase())
}

/**
 * Stats untuk health check — kini menyertakan source per field
 */
export function getMarketCacheStats() {
  const stats = {}
  for (const [sym, fields] of cache) {
    stats[sym] = {}
    for (const [field, entry] of Object.entries(fields)) {
      // Bug B: _lastAccessed adalah number (timestamp), bukan cache entry object
      // — skip agar tidak menghasilkan 'NaN ago' di output stats
      if (field === '_lastAccessed') continue
      stats[sym][field] = {
        age:    `${Math.round((Date.now() - entry.fetchedAt) / 1000)}s ago`,
        source: entry.source || 'unknown',
      }
    }
  }
  return {
    symbols:   cache.size,
    inFlight:  inFlight.size,
    exchanges: ALL.map(e => e.name),
    data:      stats,
  }
}

// ══════════════════════════════════════════════════════════════
// SMART MONEY DATA
// ══════════════════════════════════════════════════════════════
// Endpoint terpisah — data lebih berat, TTL lebih panjang (30s),
// tidak ikut cache getAllMarketData agar tidak memblokir main flow.
//
// Sumber data:
//   Binance Futures /futures/data:
//     - topLongShortAccountRatio  — % akun top trader yang long vs short
//     - topLongShortPositionRatio — % SIZE posisi top trader long vs short
//     - globalLongShortAccountRatio — semua akun (retail baseline)
//     - takerlongshortRatio        — siapa yang jadi aggressor (market order)
//     - fundingRate history         — cost of carry, proxy crowding
//   Bybit:
//     - account-ratio (konfirmasi cross-exchange top trader)
//   Liquidations:
//     - Binance + Bybit force orders — di mana whale di-stop out
// ──────────────────────────────────────────────────────────────

const smCache  = new Map()   // symbol → { data, fetchedAt }
const smFlight = new Map()   // symbol → Promise (in-flight dedup)
const TTL_SM   = 30_000      // 30 detik

// Evict smCache entries setelah 30 menit idle — sama dengan cache utama
setInterval(() => {
  const now = Date.now()
  for (const [sym, entry] of smCache) {
    if (now - entry.fetchedAt > TTL_SM * 60) smCache.delete(sym)
  }
}, 15 * 60_000)

// ── Binance raw fetchers ──────────────────────────────────────

// ── Binance raw fetchers with Bybit fallback ──────────────────
// Semua endpoint di bawah ini ada di Binance futures/data — sering
// geo-blocked di server Vercel region non-Asia.
// Fallback hierarchy: Binance → Bybit equivalent → OKX → null

// ── Smart money fetchers dengan per-endpoint geo-block circuit breaker ──
// Setiap fetcher pakai withGeoFallback(binanceFn, binanceUrl, fallbackFn).
// Kalau Binance gagal dengan error permanen (403/451/418) → endpoint itu
// di-mark blocked selama GEOBLOCK_TTL, next request langsung ke fallback.
// Endpoint Binance lain yang tidak di-block tetap jalan normal.

async function fetchTopTraderAccount(sym, limit = 12) {
  const url = `${B2}/topLongShortAccountRatio?symbol=${sym}&period=5m&limit=${limit}`
  return withGeoFallback(
    // ── Binance ──
    async () => {
      const d = await apiFetch(url)
      if (!Array.isArray(d) || !d.length) throw new Error('empty')
      return d.map(r => ({
        longPct:  +r.longAccount * 100,
        shortPct: +r.shortAccount * 100,
        ratio:    +r.longShortRatio,
        time:     +r.timestamp,
        source:   'Binance',
      }))
    },
    url,
    // ── Fallback: Bybit account-ratio ──
    async () => {
      try {
        const d    = await apiFetch(`${BB}/account-ratio?category=linear&symbol=${sym}&period=5min&limit=${limit}`)
        const list = d.result?.list
        if (!list?.length) throw new Error('empty')
        return [...list].reverse().map(r => ({
          longPct:  parseFloat(r.buyRatio) * 100,
          shortPct: parseFloat(r.sellRatio) * 100,
          ratio:    parseFloat(r.buyRatio) / (parseFloat(r.sellRatio) || 1),
          time:     +r.timestamp,
          source:   'Bybit',
        }))
      } catch { return null }
    }
  )
}

async function fetchTopTraderPosition(sym, limit = 12) {
  // Hanya Binance yang punya endpoint ini — tidak ada fallback yang equivalent
  const url = `${B2}/topLongShortPositionRatio?symbol=${sym}&period=5m&limit=${limit}`
  return withGeoFallback(
    async () => {
      const d = await apiFetch(url)
      if (!Array.isArray(d) || !d.length) throw new Error('empty')
      return d.map(r => ({
        longPct:  +r.longPosition * 100,
        shortPct: +r.shortPosition * 100,
        ratio:    +r.longShortRatio,
        time:     +r.timestamp,
        source:   'Binance',
      }))
    },
    url,
    async () => null   // tidak ada exchange lain yang punya endpoint position ratio
  )
}

async function fetchGlobalRatio(sym, limit = 12) {
  // Fallback hierarchy: Binance → OKX → Bybit*
  // OKX paling mendekati "global retail" (long-short-account-ratio)
  const url = `${B2}/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=${limit}`
  return withGeoFallback(
    // ── Binance ──
    async () => {
      const d = await apiFetch(url)
      if (!Array.isArray(d) || !d.length) throw new Error('empty')
      return d.map(r => ({
        longPct:  +r.longAccount * 100,
        shortPct: +r.shortAccount * 100,
        ratio:    +r.longShortRatio,
        time:     +r.timestamp,
        source:   'Binance',
      }))
    },
    url,
    // ── Fallback: OKX → Bybit ──
    async () => {
      // OKX dulu — konsep paling mendekati global retail
      try {
        const inst = toOKX(sym)
        const d    = await apiFetch(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?instId=${inst}&period=5m&limit=${limit}`)
        const list = d.data
        if (!list?.length) throw new Error('empty')
        return list.map(r => {
          const ls = parseFloat(r.longShortRatio)
          const lp = (ls / (1 + ls)) * 100
          return { longPct: lp, shortPct: 100 - lp, ratio: ls, time: +r.ts, source: 'OKX' }
        })
      } catch {
        // Bybit last resort — bukan retail tapi lebih baik dari null
        try {
          const d    = await apiFetch(`${BB}/account-ratio?category=linear&symbol=${sym}&period=5min&limit=${limit}`)
          const list = d.result?.list
          if (!list?.length) throw new Error('empty')
          return [...list].reverse().map(r => ({
            longPct:  parseFloat(r.buyRatio) * 100,
            shortPct: parseFloat(r.sellRatio) * 100,
            ratio:    parseFloat(r.buyRatio) / (parseFloat(r.sellRatio) || 1),
            time:     +r.timestamp,
            source:   'Bybit*',
          }))
        } catch { return null }
      }
    }
  )
}

async function fetchTakerHistory(sym, limit = 12) {
  // Fallback: Bybit recent-trade aggregation (snapshot, bukan history)
  const url = `${B2}/takerlongshortRatio?symbol=${sym}&period=5m&limit=${limit}`
  return withGeoFallback(
    // ── Binance ──
    async () => {
      const d = await apiFetch(url)
      if (!Array.isArray(d) || !d.length) throw new Error('empty')
      return d.map(r => {
        const buy = +r.buyVol, sell = +r.sellVol, total = buy + sell
        return {
          buyPct:       total ? (buy / total) * 100 : 50,
          sellPct:      total ? (sell / total) * 100 : 50,
          buySellRatio: sell > 0 ? buy / sell : null,
          time:         +r.timestamp,
          source:       'Binance',
        }
      })
    },
    url,
    // ── Fallback: Bybit recent-trade ──
    async () => {
      try {
        const d      = await apiFetch(`${BB}/recent-trade?category=linear&symbol=${sym}&limit=200`)
        const trades = d.result?.list || []
        if (!trades.length) throw new Error('empty')
        let bv = 0, sv = 0
        trades.forEach(t => { const v = +t.size; t.side === 'Buy' ? bv += v : sv += v })
        const tot = bv + sv
        if (!tot) throw new Error('zero')
        return [{
          buyPct:       (bv / tot) * 100,
          sellPct:      (sv / tot) * 100,
          buySellRatio: sv > 0 ? bv / sv : null,
          time:         Date.now(),
          source:       'Bybit',
        }]
      } catch { return null }
    }
  )
}

async function fetchFundingHistory(sym, limit = 8) {
  // Funding settle tiap 8 jam — limit=8 → 2.7 hari terakhir
  // Fallback: Bybit funding history jika Binance geo-blocked
  const url = `${B1}/fundingRate?symbol=${sym}&limit=${limit}`

  function parseBinanceFunding(d) {
    if (!Array.isArray(d) || !d.length) throw new Error('empty')
    const sorted = [...d].sort((a, b) => +a.fundingTime - +b.fundingTime)
    const intervals = sorted.slice(1).map((r, i) => +r.fundingTime - +sorted[i].fundingTime)
    const avgIntervalMs = intervals.length
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length
      : 8 * 3600 * 1000
    const periodsPerDay = (24 * 3600 * 1000) / avgIntervalMs
    return sorted.map(r => ({
      rate:       +r.fundingRate,
      annualized: +r.fundingRate * periodsPerDay * 365 * 100,
      time:       +r.fundingTime,
      source:     'Binance',
    }))
  }

  return withGeoFallback(
    async () => {
      const d = await apiFetch(url)
      return parseBinanceFunding(d)
    },
    url,
    // Fallback: Bybit funding history
    async () => {
      try {
        const d    = await apiFetch(`${BB}/funding/history?category=linear&symbol=${sym}&limit=${limit}`)
        const list = d.result?.list
        if (!list?.length) throw new Error('empty')
        const sorted = [...list].sort((a, b) => +a.fundingRateTimestamp - +b.fundingRateTimestamp)
        return sorted.map(r => ({
          rate:       parseFloat(r.fundingRate),
          annualized: parseFloat(r.fundingRate) * 3 * 365 * 100,  // Bybit 8h = 3x/day
          time:       +r.fundingRateTimestamp,
          source:     'Bybit',
        }))
      } catch { throw new Error('funding fallback failed') }
    }
  )
}

// Bybit top trader sebagai konfirmasi cross-exchange
async function fetchBybitTopTrader(sym) {
  const d  = await apiFetch(`${BB}/account-ratio?category=linear&symbol=${sym}&period=5min&limit=1`)
  const r  = d.result?.list?.[0]
  if (!r) throw new Error('empty')
  const lp = parseFloat(r.buyRatio) * 100
  const sp = parseFloat(r.sellRatio) * 100
  if (isNaN(lp) || lp <= 0) throw new Error('invalid')
  return { longPct: lp, shortPct: sp, source: 'Bybit' }
}

// ── Composite smart money signal ──────────────────────────────
// Score: -100 (strong bearish) … 0 (neutral) … +100 (strong bullish)
// Bobot tiap komponen:
//   topAcc  Binance account ratio  → max ±20 (delta×0.4)
//   topPos  Binance position ratio → max ±30 (delta×0.6) — lebih representatif
//   div     Smart vs retail diverg → max ±15 (div×0.3)
//   bybit   Bybit cross-exchange   → max ±10 (delta×0.2) — konfirmasi
//   taker   Aggressor flow         → max ±15 (delta×0.3)
//   funding Cost of carry crowding → max ±20 (kontraksi)
//   liqs    Liquidation dominance  → max ±10 (directional bias)
// Total max: ~120 → di-clamp ke ±100
function computeSmartMoneySignal({ topAcc, topPos, global, taker, funding, bybitTop, liqSummary }) {
  let score = 0
  const factors = []
  let dataPoints = 0  // track berapa sumber yang berhasil

  // ① Top trader account ratio (Binance)
  const acc = topAcc?.[topAcc.length - 1]
  if (acc) {
    dataPoints++
    const delta = acc.longPct - 50
    score += delta * 0.4
    if (delta > 10)  factors.push(`Top traders heavily long (${acc.longPct.toFixed(1)}%)`)
    else if (delta < -10) factors.push(`Top traders heavily short (${acc.shortPct.toFixed(1)}%)`)
  }

  // ② Top trader position ratio — size matters more than count (Binance)
  const pos = topPos?.[topPos.length - 1]
  if (pos) {
    dataPoints++
    const delta = pos.longPct - 50
    score += delta * 0.6
    if (delta > 15)  factors.push(`Top trader positions skewed long (${pos.longPct.toFixed(1)}%)`)
    else if (delta < -15) factors.push(`Top trader positions skewed short (${pos.shortPct.toFixed(1)}%)`)
  }

  // ③ Divergence: smart money vs retail
  if (acc && global?.length) {
    const retail = global[global.length - 1]
    const div    = acc.longPct - retail.longPct
    if (Math.abs(div) > 5) {
      score += div * 0.3
      factors.push(div > 0
        ? `Smart money more bullish than retail (+${div.toFixed(1)}% divergence)`
        : `Smart money more bearish than retail (${div.toFixed(1)}% divergence)`
      )
    }
  }

  // ④ Bybit top trader cross-exchange confirmation
  // BUG FIX: bybitTop di-fetch tapi tidak pernah dipakai di scoring
  // Padahal ini data yang tersedia bahkan saat Binance geo-blocked
  if (bybitTop?.longPct != null) {
    dataPoints++
    const delta = bybitTop.longPct - 50
    score += delta * 0.2   // bobot lebih rendah — 1 titik data saja
    if (delta > 12)  factors.push(`Bybit top traders long-biased (${bybitTop.longPct.toFixed(1)}%)`)
    else if (delta < -12) factors.push(`Bybit top traders short-biased (${bybitTop.shortPct.toFixed(1)}%)`)
  }

  // ⑤ Taker flow — aggressor direction (Binance)
  const tak = taker?.[taker.length - 1]
  if (tak) {
    dataPoints++
    const delta = tak.buyPct - 50
    score += delta * 0.3
    if (delta > 10)  factors.push(`Buy-side aggressor dominant (${tak.buyPct.toFixed(1)}%)`)
    else if (delta < -10) factors.push(`Sell-side aggressor dominant (${tak.sellPct.toFixed(1)}%)`)
  }

  // ⑥ Funding rate — extreme = crowded = contrarian signal
  const fund = funding?.[funding.length - 1]
  if (fund) {
    dataPoints++
    if (fund.annualized > 100) {
      score -= 20
      factors.push(`Extreme long funding (${fund.annualized.toFixed(1)}% ann.) — longs crowded`)
    } else if (fund.annualized > 50) {
      score -= 10
      factors.push(`High funding rate (${fund.annualized.toFixed(1)}% ann.) — longs paying premium`)
    } else if (fund.annualized > 20) {
      score -= 5
    } else if (fund.annualized < -20) {
      score += 20
      factors.push(`Negative funding (${fund.annualized.toFixed(1)}% ann.) — shorts crowded`)
    } else if (fund.annualized < -5) {
      score += 10
      factors.push(`Slightly negative funding (${fund.annualized.toFixed(1)}% ann.)`)
    }
  }

  // ⑦ Liquidation dominance — whale stop-hunt direction
  // BUG FIX: liqSummary ada tapi tidak dipakai di scoring
  // long_squeezed  → banyak longs di-force close → bearish pressure
  // short_squeezed → banyak shorts kena squeeze → bullish catalyst
  if (liqSummary?.dominance && liqSummary.dominance !== 'neutral') {
    dataPoints++
    if (liqSummary.dominance === 'long_squeezed') {
      score -= 10
      factors.push(`Long liquidations dominant ($${(liqSummary.longLiqUsd / 1e6).toFixed(1)}M) — longs flushed`)
    } else if (liqSummary.dominance === 'short_squeezed') {
      score += 10
      factors.push(`Short liquidations dominant ($${(liqSummary.shortLiqUsd / 1e6).toFixed(1)}M) — shorts squeezed`)
    }
  }

  const clamped = Math.max(-100, Math.min(100, score))

  // Turunkan threshold sinyal — sebelumnya ≥30/≥10 terlalu tinggi saat data terbatas
  // Dengan max hanya 1-2 sumber (geo-block), score jarang tembus 30
  const signal = clamped >= 25  ? 'strong_bullish'
               : clamped >= 8   ? 'bullish'
               : clamped <= -25 ? 'strong_bearish'
               : clamped <= -8  ? 'bearish'
               : 'neutral'

  return {
    score:      +clamped.toFixed(1),
    signal,
    factors:    factors.slice(0, 5),
    dataPoints, // berapa sumber berhasil — frontend bisa tampilkan confidence
  }
}

// ── Liquidations summary ──────────────────────────────────────
function summarizeLiqs(liqs) {
  if (!liqs?.length) return { longLiqUsd: 0, shortLiqUsd: 0, dominance: 'neutral', largestLong: null, largestShort: null, marketType: 'futures' }
  let longUsd = 0, shortUsd = 0, largestLong = null, largestShort = null
  for (const l of liqs) {
    if (l.side === 'SELL' || l.side === 'Sell') {
      // Long position liquidated (exchange sells their position)
      longUsd += l.value || 0
      if (!largestLong || l.value > largestLong.value) largestLong = l
    } else {
      shortUsd += l.value || 0
      if (!largestShort || l.value > largestShort.value) largestShort = l
    }
  }
  return {
    longLiqUsd:   +longUsd.toFixed(2),
    shortLiqUsd:  +shortUsd.toFixed(2),
    dominance:    longUsd > shortUsd * 1.5  ? 'long_squeezed'
                : shortUsd > longUsd * 1.5  ? 'short_squeezed'
                : 'neutral',
    largestLong:  largestLong  ? { price: largestLong.price,  valueUsd: +largestLong.value.toFixed(2),  time: largestLong.time,  exchange: largestLong.exchange  || 'unknown', marketType: 'futures' } : null,
    largestShort: largestShort ? { price: largestShort.price, valueUsd: +largestShort.value.toFixed(2), time: largestShort.time, exchange: largestShort.exchange || 'unknown', marketType: 'futures' } : null,
    marketType:   'futures',
  }
}

// ── Main smart money fetcher ──────────────────────────────────
async function _fetchSmartMoney(sym) {
  const [topAcc, topPos, globalR, takerR, fundingR, bybitTop, liqsR] = await Promise.all([
    fetchTopTraderAccount(sym, 12).catch(() => null),
    fetchTopTraderPosition(sym, 12).catch(() => null),
    fetchGlobalRatio(sym, 12).catch(() => null),
    fetchTakerHistory(sym, 12).catch(() => null),
    fetchFundingHistory(sym, 8).catch(() => null),
    fetchBybitTopTrader(sym).catch(() => null),
    fetchExchangeLiquidations(sym).catch(() => []),
  ])

  const liqSummary = summarizeLiqs(liqsR)
  const composite  = computeSmartMoneySignal({
    topAcc, topPos, global: globalR, taker: takerR, funding: fundingR,
    bybitTop,    // BUG FIX: pass bybitTop — sebelumnya di-fetch tapi tidak masuk scoring
    liqSummary,  // BUG FIX: pass liqSummary — liquidation dominance sebagai faktor
  })

  const fundLast   = fundingR?.[fundingR.length - 1]
  const fundSignal = !fundLast            ? 'unavailable'
    : fundLast.annualized > 100           ? 'extreme_long_bias'
    : fundLast.annualized > 50            ? 'long_bias'
    : fundLast.annualized < -20           ? 'extreme_short_bias'
    : fundLast.annualized < 0            ? 'short_bias'
    : 'neutral'

  const takLast   = takerR?.[takerR.length - 1]
  const takerBias = !takLast            ? 'unavailable'
    : takLast.buyPct > 60              ? 'buy_dominant'
    : takLast.buyPct < 40              ? 'sell_dominant'
    : 'neutral'

  // Baca source aktual dari item terakhir di array — bukan hardcode 'Binance'.
  // Kalau geo-blocked, item sudah berisi source fallback (Bybit/OKX) dari withGeoFallback.
  const accSource     = topAcc?.[topAcc.length - 1]?.source     || (topAcc   ? 'Binance' : 'unavailable')
  const posSource     = topPos?.[topPos.length - 1]?.source     || (topPos   ? 'Binance' : 'unavailable')
  const retailSource  = globalR?.[globalR.length - 1]?.source   || (globalR  ? 'Binance' : 'unavailable')
  const takerSource   = takerR?.[takerR.length - 1]?.source     || (takerR   ? 'Binance' : 'unavailable')
  const fundingSource = fundingR?.[fundingR.length - 1]?.source || (fundingR ? 'Binance' : 'unavailable')

  return {
    topTraders: {
      account: {
        current: topAcc?.length ? {
          longPct:  topAcc[topAcc.length - 1].longPct,
          shortPct: topAcc[topAcc.length - 1].shortPct,
        } : null,
        history:    topAcc,
        source:     accSource,
        marketType: 'futures',
      },
      position: {
        current: topPos?.length ? {
          longPct:  topPos[topPos.length - 1].longPct,
          shortPct: topPos[topPos.length - 1].shortPct,
        } : null,
        history:    topPos,
        source:     posSource,
        marketType: 'futures',
      },
      bybit: bybitTop ? { ...bybitTop, marketType: 'futures' } : null,
    },
    retail: {
      current: globalR?.length ? {
        longPct:  globalR[globalR.length - 1].longPct,
        shortPct: globalR[globalR.length - 1].shortPct,
      } : null,
      history: globalR,
      divergence: (topAcc?.length && globalR?.length) ? +(
        topAcc[topAcc.length - 1].longPct - globalR[globalR.length - 1].longPct
      ).toFixed(2) : null,
      source:     retailSource,
      marketType: 'futures',
    },
    takerFlow: {
      current: takLast ? {
        buyPct:       +takLast.buyPct.toFixed(2),
        sellPct:      +takLast.sellPct.toFixed(2),
        buySellRatio: takLast.buySellRatio !== null ? +takLast.buySellRatio.toFixed(3) : null,
      } : null,
      history:    takerR,
      bias:       takerBias,
      source:     takerSource,
      marketType: 'futures',
    },
    funding: {
      current: fundLast ? {
        rate:       +fundLast.rate.toFixed(6),
        annualized: +fundLast.annualized.toFixed(2),
      } : null,
      history:    fundingR,
      signal:     fundSignal,
      source:     fundingSource,
      marketType: 'futures',
    },
    liquidations: {
      summary:    liqSummary,
      recent:     (liqsR || []).slice(0, 20),
      sources:    ['Binance', 'Bybit'],
      marketType: 'futures',
    },
    composite,
  }
}

/**
 * Get smart money data untuk 1 symbol.
 * Cache 30 detik — endpoint terpisah, tidak memblokir getAllMarketData.
 */
export async function getSmartMoneyData(symbol) {
  const sym = symbol.toUpperCase().trim()

  const cached = smCache.get(sym)
  if (cached && Date.now() - cached.fetchedAt < TTL_SM) return cached.data

  if (smFlight.has(sym)) return smFlight.get(sym)

  const p = _fetchSmartMoney(sym)
    .then(data => {
      smCache.set(sym, { data, fetchedAt: Date.now() })
      smFlight.delete(sym)
      return data
    })
    .catch(e => {
      smFlight.delete(sym)
      throw e
    })

  smFlight.set(sym, p)
  return p
}

// ══════════════════════════════════════════════════════════════
// EXCHANGE HEALTH CHECK — diagnostik per-exchange dari IP server
// Dipanggil oleh GET /api/market/_exchange-check (requireAuth + admin only)
// Berguna untuk debug "no data" — cek exchange mana yang di-block Railway/VPS
// ══════════════════════════════════════════════════════════════
export async function checkExchangeHealth() {
  const TEST_SYM = 'BTCUSDT'
  const TIMEOUT  = 7000

  // Test setiap exchange secara paralel — 3 endpoint per exchange (ticker, markPrice, klines)
  const tests = [
    {
      name: 'Binance (Futures)',
      tests: {
        ticker:    () => apiFetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${TEST_SYM}`, TIMEOUT).then(d => !!d.highPrice),
        markPrice: () => apiFetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${TEST_SYM}`, TIMEOUT).then(d => !!d.markPrice),
        oiHist:    () => apiFetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${TEST_SYM}&period=5m&limit=2`, TIMEOUT).then(d => Array.isArray(d) && d.length > 0),
        lsRatio:   () => apiFetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${TEST_SYM}&period=5m&limit=1`, TIMEOUT).then(d => Array.isArray(d) && d.length > 0),
      },
    },
    {
      name: 'Bybit',
      tests: {
        ticker:    () => apiFetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${TEST_SYM}`, TIMEOUT).then(d => !!d.result?.list?.[0]),
        markPrice: () => apiFetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${TEST_SYM}`, TIMEOUT).then(d => !!d.result?.list?.[0]?.markPrice),
        oiHist:    () => apiFetch(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${TEST_SYM}&intervalTime=5min&limit=2`, TIMEOUT).then(d => !!d.result?.list?.length),
        lsRatio:   () => apiFetch(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${TEST_SYM}&period=5min&limit=1`, TIMEOUT).then(d => !!d.result?.list?.[0]),
      },
    },
    {
      name: 'OKX',
      tests: {
        ticker:    () => apiFetch(`https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP`, TIMEOUT).then(d => !!d.data?.[0]),
        markPrice: () => apiFetch(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=BTC-USDT-SWAP`, TIMEOUT).then(d => !!d.data?.[0]?.markPx),
        oiHist:    () => Promise.reject(new Error('OKX: no OI hist endpoint')),
        lsRatio:   () => apiFetch(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?instId=BTC-USDT-SWAP&period=5m&limit=1`, TIMEOUT).then(d => !!d.data?.[0]),
      },
    },
    {
      name: 'Gate.io',
      tests: {
        ticker:    () => apiFetch(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=BTC_USDT`, TIMEOUT).then(d => !!d[0]),
        markPrice: () => apiFetch(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=BTC_USDT`, TIMEOUT).then(d => !!d[0]?.mark_price),
        oiHist:    () => Promise.reject(new Error('Gate: no OI hist endpoint')),
        lsRatio:   () => Promise.reject(new Error('Gate: no real L/S endpoint')),
      },
    },
    {
      name: 'Bitget',
      tests: {
        ticker:    () => apiFetch(`https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES&symbol=${TEST_SYM}`, TIMEOUT).then(d => !!d.data?.[0]),
        markPrice: () => apiFetch(`https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES&symbol=${TEST_SYM}`, TIMEOUT).then(d => !!d.data?.[0]?.markPrice),
        oiHist:    () => Promise.reject(new Error('Bitget: no OI hist endpoint')),
        lsRatio:   () => apiFetch(`https://api.bitget.com/api/v2/mix/market/long-short-ratio?productType=USDT-FUTURES&symbol=${TEST_SYM}&period=5min&limit=1`, TIMEOUT).then(d => !!d.data?.[0]),
      },
    },
    {
      name: 'MEXC',
      tests: {
        ticker:    () => apiFetch(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${TEST_SYM}`, TIMEOUT).then(d => !!d.data),
        markPrice: () => apiFetch(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${TEST_SYM}`, TIMEOUT).then(d => !!d.data?.lastPrice),
        oiHist:    () => Promise.reject(new Error('MEXC: no OI hist endpoint')),
        lsRatio:   () => Promise.reject(new Error('MEXC: no real L/S endpoint')),
      },
    },
  ]

  const startAll = Date.now()

  const results = await Promise.all(tests.map(async ({ name, tests: endpoints }) => {
    const endpointResults = {}
    let passed = 0, failed = 0

    await Promise.all(
      Object.entries(endpoints).map(async ([endpointName, fn]) => {
        const t0 = Date.now()
        try {
          const ok = await fn()
          endpointResults[endpointName] = { ok: !!ok, ms: Date.now() - t0 }
          if (ok) passed++; else failed++
        } catch (e) {
          endpointResults[endpointName] = {
            ok:    false,
            ms:    Date.now() - t0,
            error: e.message?.slice(0, 80),
          }
          failed++
        }
      })
    )

    const reachable = passed > 0
    return { name, reachable, passed, failed, endpoints: endpointResults }
  }))

  const totalMs     = Date.now() - startAll
  const reachable   = results.filter(r => r.reachable).map(r => r.name)
  const unreachable = results.filter(r => !r.reachable).map(r => r.name)

  return {
    summary: {
      totalMs,
      reachable,
      unreachable,
      oiHistAvailable: results.filter(r =>
        r.reachable && r.endpoints.oiHist?.ok
      ).map(r => r.name),
    },
    exchanges: results,
  }
}
