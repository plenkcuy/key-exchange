// ── Cloudflare Worker — Exchange API Proxy ────────────────────
// Setup:
//   1. Workers → Settings → Variables → Add variable:
//        PROXY_SECRET = (random string, sama dengan CF_PROXY_SECRET di Railway)
//   2. Paste file ini → Save and Deploy
//
// Flow: Railway backend → POST ke worker ini → worker forward ke exchange
// Worker hanya menerima POST dari Railway, tidak dari browser langsung.

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
]

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, x-proxy-secret',
      },
    })
  }

  // Hanya terima POST
  if (request.method !== 'POST') {
    return makeJson({ error: 'Method not allowed' }, 405)
  }

  // Verifikasi secret dari Railway
  var incoming = request.headers.get('x-proxy-secret')
  if (!incoming || incoming !== PROXY_SECRET) {
    return makeJson({ error: 'Unauthorized' }, 401)
  }

  // Parse body
  var payload
  try {
    payload = await request.json()
  } catch (e) {
    return makeJson({ error: 'Invalid JSON body' }, 400)
  }

  var targetUrl    = payload.url
  var upstreamMs   = Math.min(payload.timeout || 8000, 25000)
  var upstreamMeth = payload.method || 'GET'
  var upstreamBody = payload.body   || null   // JSON string untuk POST upstream

  // Validasi URL
  if (!targetUrl || typeof targetUrl !== 'string') {
    return makeJson({ error: 'url is required' }, 400)
  }

  // Validasi domain
  var hostname
  try {
    hostname = new URL(targetUrl).hostname
  } catch (e) {
    return makeJson({ error: 'Invalid URL' }, 400)
  }

  if (ALLOWED_DOMAINS.indexOf(hostname) === -1) {
    return makeJson({ error: 'Domain not allowed: ' + hostname }, 403)
  }

  // Validasi method
  if (['GET', 'POST'].indexOf(upstreamMeth) === -1) {
    return makeJson({ error: 'Upstream method not allowed' }, 405)
  }

  // Build fetch options
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

  // Forward ke upstream dengan timeout
  var timeoutId
  var timeoutPromise = new Promise(function(_, reject) {
    timeoutId = setTimeout(function() {
      reject(new Error('upstream timeout ' + upstreamMs + 'ms'))
    }, upstreamMs)
  })

  try {
    var upstream = await Promise.race([
      fetch(targetUrl, fetchOpts),
      timeoutPromise,
    ])
    clearTimeout(timeoutId)

    // Baca body response
    var responseText = await upstream.text()

    // Coba parse sebagai JSON, kalau gagal kirim as-is
    var responseData
    try {
      responseData = JSON.parse(responseText)
    } catch (e) {
      // Response bukan JSON (HTML error page dari exchange)
      return new Response(
        JSON.stringify({ error: 'Exchange returned non-JSON', status: upstream.status, raw: responseText.slice(0, 300) }),
        {
          status: upstream.status,
          headers: {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      )
    }

    return new Response(JSON.stringify(responseData), {
      status: upstream.status,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })

  } catch (e) {
    clearTimeout(timeoutId)
    var isTimeout = e.message && e.message.indexOf('timeout') !== -1
    return makeJson(
      { error: e.message || 'Upstream fetch failed' },
      isTimeout ? 504 : 502
    )
  }
}

function makeJson(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
