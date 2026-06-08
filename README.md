# Nifty Options Dashboard

Live intraday options dashboard for Nifty 50. Updates every 15 minutes during market hours (9:15 AM – 3:30 PM IST).

## Features

- Real-time bias (BULLISH / BEARISH / NEUTRAL) with conviction %
- Channel visualizer — where spot sits between support and resistance
- OI change (today vs yesterday) — four-quadrant analysis
- CE/PE wall rankings
- Single trade recommendation with delta, theta, ITM/OTM distance
- Expiry selector (weekly + monthly)

## Deploy to Vercel

### 1. Push to GitHub

Create a new repo called `nifty-options-dashboard` and push this folder.

### 2. Connect to Vercel

1. Go to vercel.com → New Project
1. Import your `nifty-options-dashboard` repo
1. Framework: **Vite**
1. Build command: `npm run build`
1. Output directory: `dist`
1. Click **Deploy**

### 3. Add Environment Variable

In Vercel project → Settings → Environment Variables:

- Name: `UPSTOX_TOKEN`
- Value: your Upstox Analytics Token
- Environment: Production + Preview + Development

### 4. Redeploy

After adding the env var, go to Deployments → click the latest → **Redeploy**.

That’s it — your dashboard is live at `https://your-project.vercel.app`

## Local Development

```bash
npm install
# Create .env.local with:
# UPSTOX_TOKEN=your_token_here
npm run dev
```# nifty-options-dashboard
