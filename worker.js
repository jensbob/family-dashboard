// ── Helpers ──────────────────────────────────────────────────────────────────

const OREF_HEADERS = {
  'Referer':          'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':           'application/json, text/plain, */*',
  'Accept-Language':  'he-IL,he;q=0.9,en;q=0.8',
};

const CORS_HEADERS = {
  'Content-Type':                 'application/json',
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const HISTORY_KEY    = 'events';
const HISTORY_MAX_MS = 12 * 60 * 60 * 1000; // 12 hours

// Fetch the last ~4 hours of alerts directly from OREF
async function fetchOrefHistory() {
  try {
    const res = await fetch(
      'https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1',
      { headers: OREF_HEADERS, cf: { cacheEverything: false, cacheTtl: 0, country: 'IL' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

// Merge stored + fresh events: deduplicate by rid, prune >12h, sort newest first
function mergeEvents(stored, fresh) {
  const cutoff = Date.now() - HISTORY_MAX_MS;
  const seen   = new Map();

  for (const ev of [...stored, ...fresh]) {
    if (!ev.rid) continue;
    const ts = new Date((ev.alertDate || '').replace('T', ' ')).getTime();
    if (isNaN(ts) || ts < cutoff) continue;
    if (!seen.has(ev.rid)) seen.set(ev.rid, { ...ev, alertDate: ev.alertDate.replace('T', ' ') });
  }

  return [...seen.values()].sort((a, b) => b.alertDate.localeCompare(a.alertDate));
}

// Read KV history (returns [] if empty or missing)
async function readKV(env) {
  try {
    const raw = await env.HISTORY_STORE.get(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

// ── Cron: runs every 15 min ───────────────────────────────────────────────────

async function refreshHistory(env) {
  const [stored, fresh] = await Promise.all([readKV(env), fetchOrefHistory()]);
  const merged = mergeEvents(stored, fresh);
  await env.HISTORY_STORE.put(HISTORY_KEY, JSON.stringify(merged));
}

// ── /alarms-history endpoint ──────────────────────────────────────────────────

async function handleAlarmsHistory(env) {
  // Serve from KV cache (kept fresh by the 15-min cron).
  // Only fall back to a live OREF fetch if KV is empty (e.g. first deploy).
  const stored = await readKV(env);
  if (stored.length > 0) {
    return new Response(JSON.stringify(stored), { headers: CORS_HEADERS });
  }
  // KV empty — bootstrap from live OREF and prime the cache
  const fresh  = await fetchOrefHistory();
  const merged = mergeEvents([], fresh);
  await env.HISTORY_STORE.put(HISTORY_KEY, JSON.stringify(merged));
  return new Response(JSON.stringify(merged), { headers: CORS_HEADERS });
}

// ── Worker entry point ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/alarms-history') {
      return handleAlarmsHistory(env);
    }

    // Simple proxy routes (pass-through to external APIs)
    let targetUrl, referer;
    if (url.pathname === '/history') {
      targetUrl = 'https://api.tzevaadom.co.il/alerts-history';
      referer   = 'https://www.tzevaadom.co.il/';
    } else if (url.pathname === '/alerts-history') {
      targetUrl = 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json';
      referer   = 'https://www.oref.org.il/';
    } else if (url.pathname === '/oref') {
      targetUrl = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
      referer   = 'https://www.oref.org.il/';
    } else if (url.pathname === '/cities') {
      targetUrl = 'https://www.tzevaadom.co.il/static/cities.json';
      referer   = 'https://www.tzevaadom.co.il/';
    } else {
      targetUrl = 'https://api.tzevaadom.co.il/notifications';
      referer   = 'https://www.tzevaadom.co.il/';
    }

    const res  = await fetch(targetUrl, {
      headers: { ...OREF_HEADERS, Referer: referer },
      cf: { cacheEverything: false, cacheTtl: 0, country: 'IL', resolveOverride: 'www.oref.org.il' },
    });
    return new Response(await res.text(), { headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshHistory(env));
  },
};
