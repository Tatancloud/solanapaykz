// tilda-server/public/consent.js — cookie banner and consent-gated Google analytics (served under the page CSP).
// The choice is kept in localStorage as 'accepted' or 'declined'; the close button counts as declined.
// Google Tag Manager and the Google tag (GA4) load only after 'accepted' — on this page view or a later one.
// They are the same snippets Google gives, moved here because the CSP forbids inline scripts. The GTM
// <noscript> iframe is left out on purpose: without JavaScript the visitor cannot give consent.
(() => {
  const KEY = 'spkz-consent';
  const GTM_ID = 'GTM-5C97N359';
  const GA_ID = 'G-JCX7CZC1PZ';
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  window.spkzConsent = read;

  let loaded = false;
  function loadGoogle() {
    if (loaded) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
    for (const src of [`https://www.googletagmanager.com/gtm.js?id=${GTM_ID}`, `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`]) {
      const s = document.createElement('script');
      s.async = true;
      s.src = src;
      document.head.appendChild(s);
    }
  }

  const choice = read();
  if (choice === 'accepted') loadGoogle();

  const banner = document.getElementById('lk-consent');
  if (!banner || choice) return;
  banner.hidden = false;
  banner.addEventListener('click', (e) => {
    const action = e.target.closest('[data-consent]')?.dataset.consent;
    if (!action) return;
    const value = action === 'accept' ? 'accepted' : 'declined';
    try { localStorage.setItem(KEY, value); } catch { /* private mode: ask again next visit */ }
    banner.hidden = true;
    if (value === 'accepted') loadGoogle();
    window.dispatchEvent(new CustomEvent('spkz-consent', { detail: value }));
  });
})();
