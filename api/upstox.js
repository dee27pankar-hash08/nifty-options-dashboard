export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.UPSTOX_TOKEN;
  if (!token) return res.status(500).json({ error: 'Token not configured' });

  const { endpoint, ...params } = req.query;
  if (!endpoint) return res.status(400).json({ error: 'endpoint param required' });

  // Note: instrument keys with spaces need %20 in path (not +)
  const NIFTY   = 'NSE_INDEX%7CNifty%2050';
  const VIX_KEY = 'NSE_INDEX%7CIndia%20VIX';

  const ALLOWED = {
    'option-chain':    `https://api.upstox.com/v2/option/chain`,
    'option-contract': `https://api.upstox.com/v2/option/contract`,
    'change-oi':       `https://api.upstox.com/v2/market/change-oi`,
    'max-pain':        `https://api.upstox.com/v2/market/max-pain`,
    'pcr':             `https://api.upstox.com/v2/market/pcr`,
    // Intraday 30min candles — instrument key in path, must use %20
    'intraday':        `https://api.upstox.com/v2/historical-candle/intraday/${NIFTY}/30minute`,
    'vix-intraday':    `https://api.upstox.com/v2/historical-candle/intraday/${VIX_KEY}/30minute`,
  };

  let url;

  if (endpoint === 'historical') {
    // PDH/PDL: daily candle, instrument key in path
    const { to_date, from_date } = params;
    url = `https://api.upstox.com/v2/historical-candle/${NIFTY}/day/${to_date}/${from_date}`;
  } else {
    const baseUrl = ALLOWED[endpoint];
    if (!baseUrl) return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });
    const qs = new URLSearchParams(params).toString();
    url = qs ? `${baseUrl}?${qs}` : baseUrl;
  }

  try {
    const upstream = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });
    const data = await upstream.json();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Upstream fetch failed', detail: err.message });
  }
}
