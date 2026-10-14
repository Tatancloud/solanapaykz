// tilda-server/public/consent.js — cookie banner (served under CSP default-src 'self').
// The choice is kept in localStorage as 'accepted' or 'declined'; the close button counts as declined.
// Analytics added later must load only after window.spkzConsent() === 'accepted' or on the 'spkz-consent' event.
(() => {
  const KEY = 'spkz-consent';
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  window.spkzConsent = read;

  const banner = document.getElementById('lk-consent');
  if (!banner || read()) return;
  banner.hidden = false;
  banner.addEventListener('click', (e) => {
    const action = e.target.closest('[data-consent]')?.dataset.consent;
    if (!action) return;
    const value = action === 'accept' ? 'accepted' : 'declined';
    try { localStorage.setItem(KEY, value); } catch { /* private mode: ask again next visit */ }
    banner.hidden = true;
    window.dispatchEvent(new CustomEvent('spkz-consent', { detail: value }));
  });
})();
