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

  // No wallet in this browser (usually a phone browser): offer to reopen this page inside the Phantom app.
  const offerPhantom = () => {
    const a = $('#lk-phantom');
    if (!a) return;
    a.href = 'https://phantom.app/ul/browse/' + encodeURIComponent(location.href) + '?ref=' + encodeURIComponent(location.origin);
    a.hidden = false;
  };
  // Signs the server's one-time sign-in message with the browser wallet; null when there is no wallet or the user cancels.
  const walletSign = async (button) => {
    const w = window.phantom?.solana || window.solflare || window.solana;
    if (!w) { msg(button.dataset.noWallet); offerPhantom(); return null; }
    try {
      const { publicKey } = await w.connect();
      const n = await api('/api/auth/wallet/nonce', 'POST', {});
      const signed = await w.signMessage(new TextEncoder().encode(n.data.message), 'utf8');
      return { address: publicKey.toString(), nonce: n.data.nonce, signature: b58(signed.signature || signed) };
    } catch (e) { msg((e && e.message) || 'error'); return null; }
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
      const s = await walletSign($('#lk-wallet'));
      if (!s) return;
      const r = await api('/api/auth/wallet/verify', 'POST', { ...s, lang });
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

  document.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!window.confirm(b.dataset.confirm)) return;
    const r = await api('/api/merchant/invoices/' + encodeURIComponent(b.dataset.delete), 'DELETE');
    if (r.status === 200) { b.closest('tr').remove(); return; }
    window.alert(r.data.message || r.data.error || 'error');
  }));

  const linkWallet = $('#lk-link-wallet');
  if (linkWallet) linkWallet.addEventListener('click', async () => {
    const s = await walletSign(linkWallet);
    if (!s) return;
    const r = await api('/api/merchant/wallet-login', 'POST', s);
    if (r.status !== 200) return msg(r.data.message || r.data.error || 'error');
    msg(linkWallet.dataset.linked);
    setTimeout(() => location.reload(), 1200);
  });

  const tg = $('#lk-tg');
  if (tg) tg.addEventListener('click', async () => {
    const r = await api('/api/merchant/telegram-link', 'POST', {});
    if (r.status === 200) location.href = r.data.url;
  });
})();
