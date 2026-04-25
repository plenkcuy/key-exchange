// ── Cloudflare Worker — Exchange API Proxy ───────────────────────
// Format: Service Worker (addEventListener) — compatible dengan Cloudflare Dashboard UI
// Tidak perlu wrangler, langsung paste di editor dashboard → Save and Deploy
//
// Setup:
//   1. Paste file ini di Cloudflare Dashboard → Workers → Edit Code → Save and Deploy
//   2. Workers → Settings → Variables → Add: PROXY_SECRET = (random string 32+ char)
//   3. Railway Variables → Add:
//        CF_PROXY_URL    = https://NAMA-WORKER.ACCOUNT.workers.dev
//        CF_PROXY_SECRET = (secret yang sama)
// ─────────────────────────────────────────────────────────────────

const ALLOWED_DOMAINS = [
  'fapi.binance.com',
  'api.binance.com',
  'api.bybit.com',
  'www.okx.com',
  'api.gateio.ws',
  'contract.mexc.com',
  'api.bitget.com',
  'api.coinlore.net',
]

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, x-proxy-secret',
      },
    })
  }

  if (request.method !== 'POST') {
    return makeJson({ error: 'Method not allowed' }, 405)
  }

  // Auth
  var secret = request.headers.get('x-proxy-secret')
  if (!secret || secret !== PROXY_SECRET) {
    return makeJson({ error: 'Unauthorized' }, 401)
  }

  // Parse body
  var body
  try {
    body = await request.json()
  } catch (e) {
    return makeJson({ error: 'Invalid JSON body' }, 400)
  }

  var url     = body.url
  var timeout = body.timeout || 8000

  if (!url || typeof url !== 'string') {
    return makeJson({ error: 'url (string) required' }, 400)
  }

  // Domain allowlist
  var hostname
  try {
    hostname = new URL(url).hostname
  } catch (e) {
    return makeJson({ error: 'Invalid URL' }, 400)
  }

  if (ALLOWED_DOMAINS.indexOf(hostname) === -1) {
    return makeJson({ error: 'Domain not allowed: ' + hostname }, 403)
  }

  // Forward ke exchange
  var clampedTimeout = Math.min(timeout, 25000)

  try {
    var upstream = await Promise.race([
      fetch(url, {
        headers: {
          'Accept':     'application/json',
          'User-Agent': 'TradingJournal/2.0',
        },
      }),
      new Promise(function(_, reject) {
        setTimeout(function() {
          reject(new Error('timeout ' + clampedTimeout + 'ms'))
        }, clampedTimeout)
      }),
    ])

    if (!upstream.ok) {
      var errText = ''
      try { errText = await upstream.text() } catch (e) {}
      return makeJson(
        { error: 'Exchange HTTP ' + upstream.status, detail: errText.slice(0, 200) },
        upstream.status
      )
    }

    var data = await upstream.json()
    return makeJson(data, 200)

  } catch (e) {
    var isTimeout = e.message && e.message.indexOf('timeout') !== -1
    return makeJson(
      { error: e.message || 'Upstream error' },
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
