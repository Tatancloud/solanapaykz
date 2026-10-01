// tilda-server/public/link.js — copy buttons and status polling (served under CSP default-src 'self')
(() => {
  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); } catch { return; }
      const old = b.textContent;
      b.textContent = document.getElementById('lk-status')?.dataset.copied || 'Copied';
      setTimeout(() => { b.textContent = old; }, 1500);
    });
  });
  const el = document.getElementById('lk-status');
  if (!el) return;
  const poll = async () => {
    try {
      const r = await fetch(`/api/invoices/${el.dataset.invoice}/status`, { cache: 'no-store' });
      const s = await r.json();
      if (s.state === 'paid') { el.textContent = el.dataset.paid; el.className = 'lk-status lk-paid'; return; }
      if (s.state === 'needs_review') { el.textContent = el.dataset.review; el.className = 'lk-status lk-needs_review'; return; }
      if (s.state === 'expired') { location.reload(); return; }
    } catch { /* retry */ }
    setTimeout(poll, 4000);
  };
  setTimeout(poll, 4000);
})();
