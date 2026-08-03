// Cookieless analytics beacon. Reads nothing from the device, writes nothing to it.

const ENDPOINT = '/api/collect';

const send = (name, extra = {}) => {
  const payload = JSON.stringify({
    name,
    path: location.pathname,
    query: location.search,
    referrer: document.referrer,
    ...extra,
  });

  // sendBeacon survives the page unload that follows an outbound click.
  if (navigator.sendBeacon) {
    navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
    return;
  }
  fetch(ENDPOINT, { method: 'POST', body: payload, keepalive: true }).catch(() => {});
};

send('pageview');

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link) return;

  const href = link.getAttribute('href');

  if (href.startsWith('mailto:')) {
    send('cta_book_call', { target: href });
    return;
  }

  const url = new URL(href, location.href);
  if (url.origin !== location.origin) send('outbound', { target: url.href });
});
