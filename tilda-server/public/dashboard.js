// tilda-server/public/dashboard.js — sign-in, invoice creation, settings, repayment, Telegram link
(() => {
  const $ = (s) => document.querySelector(s);
  const msg = (text) => { const el = $('#lk-msg'); if (el) el.textContent = text; };
  const csrf = $('#lk-session')?.dataset.csrf;
  const api = async (path, method, body) => {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const b58 = (bytes) => { // minimal base58 encoder for the wallet signature
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
    let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; s = '1' + s; } return s;
  };

  const emailForm = $('#lk-email');
  if (emailForm) {
    const lang = emailForm.dataset.lang;
    emailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await api(emailForm.dataset.start, 'POST', { email: emailForm.email.value, lang });
      if (r.status !== 200) return msg(r.data.message || r.data.error || 'error');
      emailForm.code.parentElement.hidden = false; $('#lk-verify').hidden = false;
    });
    $('#lk-verify').addEventListener('click', async () => {
      const r = await api(emailForm.dataset.verify, 'POST', { email: emailForm.email.value, code: emailForm.code.value, lang });
      if (r.status === 200) location.href = '/m'; else msg(r.data.message || r.data.error || 'error');
    });
    $('#lk-wallet').addEventListener('click', async () => {
      const w = window.phantom?.solana || window.solflare || window.solana;
      if (!w) return msg('Install Phantom or Solflare, or open this page in the wallet browser.');
      const { publicKey } = await w.connect();
      const n = await api('/api/auth/wallet/nonce', 'POST', {});
      const signed = await w.signMessage(new TextEncoder().encode(n.data.message), 'utf8');
      const sig = signed.signature || signed;
      const r = await api('/api/auth/wallet/verify', 'POST', { address: publicKey.toString(), nonce: n.data.nonce, signature: b58(sig), lang });
      if (r.status === 200) location.href = '/m'; else msg(r.data.message || r.data.error || 'error');
    });
  }

  const newForm = $('#lk-new');
  if (newForm) newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/merchant/invoices', 'POST', { amountKzt: newForm.amountKzt.value, description: newForm.description.value, token: newForm.token.value });
    if (r.status !== 200) return msg(r.data.message || r.data.error || 'error');
    $('#lk-url').textContent = r.data.url; $('#lk-result').hidden = false;
    $('#lk-share').onclick = async () => {
      if (navigator.share) { try { await navigator.share({ url: r.data.url }); return; } catch { /* fall through */ } }
      await navigator.clipboard.writeText(r.data.url);
    };
  });

  document.querySelectorAll('[data-repay]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api('/api/merchant/fees/repay', 'POST', { token: b.dataset.repay });
    if (r.status === 200) location.href = r.data.url; else msg(r.data.message || r.data.error || 'error');
  }));

  const settings = $('#lk-settings');
  if (settings) settings.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/merchant/settings', 'PUT', { recipient: settings.recipient.value.trim(), name: settings.name.value, lang: settings.lang.value });
    msg(r.status === 200 ? $('#lk-msg').dataset.saved : (r.data.message || r.data.error || 'error'));
  });

  const tg = $('#lk-tg');
  if (tg) tg.addEventListener('click', async () => {
    const r = await api('/api/merchant/telegram-link', 'POST', {});
    if (r.status === 200) location.href = r.data.url;
  });
})();
