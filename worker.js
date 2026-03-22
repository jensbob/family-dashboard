export default {
  async fetch(request) {
    const url = new URL(request.url);

    let targetUrl, referer;
    if (url.pathname === '/history') {
      targetUrl = 'https://api.tzevaadom.co.il/alerts-history';
      referer = 'https://www.tzevaadom.co.il/';
    } else if (url.pathname === '/alerts-history') {
      targetUrl = 'https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json';
      referer = 'https://www.oref.org.il/';
    } else if (url.pathname === '/oref') {
      targetUrl = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
      referer = 'https://www.oref.org.il/';
    } else if (url.pathname === '/cities') {
      targetUrl = 'https://www.tzevaadom.co.il/static/cities.json';
      referer = 'https://www.tzevaadom.co.il/';
    } else {
      targetUrl = 'https://api.tzevaadom.co.il/notifications';
      referer = 'https://www.tzevaadom.co.il/';
    }

    const res = await fetch(targetUrl, {
      headers: {
        'Referer': referer,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      },
      cf: { cacheEverything: false, cacheTtl: 0, country: 'IL', resolveOverride: 'www.oref.org.il' }
    });

    const text = await res.text();

    return new Response(text, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      }
    });
  }
}
