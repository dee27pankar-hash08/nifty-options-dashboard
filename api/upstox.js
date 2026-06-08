// Vercel serverless function — proxies all Upstox API calls
// Keeps the Analytics Token server-side, never exposed to browser

export default async function handler(req, res) {
  // CORS — allow requests from any origin (your Vercel frontend)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.UPSTOX_TOKEN;
  if (!token) return res.status(500).json({ error: 'Token not configured' });

  const { endpoint, ...params } = req.query;
  if (!endpoint) return res.status(400).json({ error: 'endpoint param required' });

  // Whitelist of allowed Upstox endpoints
  const ALLOWED = {
    'option-chain':  'https://api.upstox.com/v2/option/chain',
    'option-contract': 'https://api.upstox.com/v2/option/contract',
    'change-oi':     'https://api.upstox.com/v2/market/change-oi',
    'max-pain':      'https://api.upstox.com/v2/market/max-pain',
    'pcr':           'https://api.upstox.com/v2/market/pcr',
  };

  const baseUrl = ALLOWED[endpoint];
  if (!baseUrl) return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });

  // Build query string from remaining params
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${baseUrl}?${qs}` : baseUrl;

  try {
    const upstream = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });
    const data = await upstream.json();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Upstream fetch failed', detail: err.message });
  }
}
