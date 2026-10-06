// tilda-server/public/link.js — copy buttons, in-page wallet payment and status polling (served under CSP default-src 'self')
(() => {
  document.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); } catch { return; }
      const old = b.textContent;
      b.textContent = document.getElementById('lk-status')?.dataset.copied || 'Copied';
      setTimeout(() => { b.textContent = old; }, 1500);
    });
  });

  // Browser-extension wallets (Phantom, Solflare, Backpack on desktop) do not open solana: links, so when one is
  // installed we pay in-page through the Wallet Standard: connect, ask our transaction-request endpoint for the
  // unsigned transaction, and let the wallet sign and send it. Without an extension the link works as before.
  const wallets = [];
  const registry = { register: (...ws) => { wallets.push(...ws); return () => {}; } };
  window.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(registry); } catch { /* ignore */ } });
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registry })); } catch { /* ignore */ }

  const btn = document.getElementById('lk-open-wallet');
  const note = document.getElementById('lk-pay-msg');
  const say = (text) => { if (note) note.textContent = text; };
  const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const pick = (chain) => wallets.find((w) => w.features?.['standard:connect'] && w.features?.['solana:signAndSendTransaction']
    && (!w.chains || w.chains.includes(chain)));

  if (btn) btn.addEventListener('click', async (e) => {
    const wallet = pick(btn.dataset.chain);
    if (!wallet) return; // no extension: follow the solana: link (mobile wallets)
    e.preventDefault();
    try {
      say(btn.dataset.confirmWallet);
      const { accounts } = await wallet.features['standard:connect'].connect();
      const account = accounts?.[0] || wallet.accounts?.[0];
      if (!account) throw new Error('No account');
      const r = await fetch(btn.dataset.pay, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: account.address }) });
      const data = await r.json();
      if (!r.ok || !data.transaction) throw new Error(data.error || 'Could not build the transaction');
      await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction(
        { account, transaction: fromBase64(data.transaction), chain: btn.dataset.chain });
      say(btn.dataset.sent);
    } catch (err) {
      say((err && err.message) || 'Error');
    }
  });

  const el = document.getElementById('lk-status');
  if (!el) return;
  const poll = async () => {
    try {
      const r = await fetch(`/api/invoices/${el.dataset.invoice}/status`, { cache: 'no-store' });
      const s = await r.json();
      if (s.state === 'paid') { el.textContent = el.dataset.paid; el.className = 'lk-status lk-paid'; say(''); return; }
      if (s.state === 'needs_review') { el.textContent = el.dataset.review; el.className = 'lk-status lk-needs_review'; say(''); return; }
      if (s.state === 'expired') { location.reload(); return; }
    } catch { /* retry */ }
    setTimeout(poll, 4000);
  };
  setTimeout(poll, 4000);
})();
