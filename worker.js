// ── Cloudflare Worker — Exchange API Proxy ────────────────────
// Public proxy — tidak ada secret check.
// Keamanan: domain allowlist ketat, hanya exchange yang diizinkan.
// Deploy: paste file ini → Save and Deploy (tidak perlu setup Variables).

const ALLOWED_DOMAINS = [
  'fapi.binance.com',
  'api.binance.com',
  'dapi.binance.com',
  'api.bybit.com',
  'www.okx.com',
  'api.gateio.ws',
  'contract.mexc.com',
  'api.mexc.com',
  'api.bitget.com',
  'api.coinlore.net',
  'api.hyperliquid.xyz',
  'public-api.birdeye.so',
  'api.geckoterminal.com',
  'price.jup.ag',
  'api.coingecko.com',
]

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }

  if (request.method !== 'POST') {
    return makeJson({ error: 'Method not allowed' }, 405)
  }

  var payload
  try {
    payload = await request.json()
  } catch (e) {
    return makeJson({ error: 'Invalid JSON body' }, 400)
  }

  var targetUrl    = payload.url
  var upstreamMs   = Math.min(payload.timeout || 8000, 25000)
  var upstreamMeth = payload.method || 'GET'
  var upstreamBody = payload.body   || null

  if (!targetUrl || typeof targetUrl !== 'string') {
    return makeJson({ error: 'url is required' }, 400)
  }

  var hostname
  try {
    hostname = new URL(targetUrl).hostname
  } catch (e) {
    return makeJson({ error: 'Invalid URL' }, 400)
  }

  if (ALLOWED_DOMAINS.indexOf(hostname) === -1) {
    return makeJson({ error: 'Domain not allowed: ' + hostname }, 403)
  }

  if (['GET', 'POST'].indexOf(upstreamMeth) === -1) {
    return makeJson({ error: 'Upstream method not allowed' }, 405)
  }

  var fetchOpts = {
    method:  upstreamMeth,
    headers: {
      'Accept':     'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/2.0)',
    },
  }

  if (upstreamMeth === 'POST' && upstreamBody) {
    fetchOpts.headers['Content-Type'] = 'application/json'
    fetchOpts.body = upstreamBody
  }

  var timeoutId
  var timeoutPromise = new Promise(function(_, reject) {
    timeoutId = setTimeout(function() {
      reject(new Error('upstream timeout ' + upstreamMs + 'ms'))
    }, upstreamMs)
  })

  try {
    var upstream = await Promise.race([fetch(targetUrl, fetchOpts), timeoutPromise])
    clearTimeout(timeoutId)

    var responseText = await upstream.text()
    var responseData
    try {
      responseData = JSON.parse(responseText)
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Exchange non-JSON', status: upstream.status, raw: responseText.slice(0, 200) }),
        { status: upstream.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      )
    }

    return new Response(JSON.stringify(responseData), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  } catch (e) {
    clearTimeout(timeoutId)
    return makeJson(
      { error: e.message || 'Upstream fetch failed' },
      e.message && e.message.indexOf('timeout') !== -1 ? 504 : 502
    )
  }
}

function makeJson(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}
