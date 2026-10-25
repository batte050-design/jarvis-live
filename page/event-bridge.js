// This function runs inside the existing engine's applyEvent scope.
function pagePresentationEvent(ev, d, ctx) {
  if (!['presentation', 'failure', 'page_progress', 'approval_request'].includes(ev)) return {ev, d};
  if (String(d.conv || '') !== String(ctx.conv || '')) return null;
  const tid = String(d.tid || d.turn || '');
  if (!/^[0-9a-fA-F]{8,40}$/.test(tid)) return null;
  if (ev === 'presentation' || ev === 'failure') {
    if (ctx.pageTerminalId === d.id) return null;
    if (ctx.pageTerminalId) throw new Error('Conflicting page terminal event');
    ctx.pageTerminalId = d.id;
    document.querySelectorAll('[data-page-turn="' + tid + '"]').forEach(n => n.remove());
    let text;
    if (ev === 'failure') { text = String(d.message || 'JARVIS could not complete this request.'); ctx.pageFailed = true; }
    else {
      const p = d.payload;
      if (!p || typeof p.intro !== 'string' || !['prose', 'interface'].includes(p.kind)) throw new Error('Invalid presentation envelope');
      text = p.intro;
      if (p.kind === 'interface') {
        if (typeof p.program !== 'string' || !p.program.trim()) throw new Error('Empty interface');
        const bytes = new TextEncoder().encode(JSON.stringify(p.receipts || []));
        let binary = ''; bytes.forEach(b => { binary += String.fromCharCode(b); });
        text += '\n\n```openui\n// jarvis-context: ' + btoa(binary) + '\n' + p.program + '\n```';
      }
    }
    return {ev: 'text', d: {text, conv: d.conv, tid}};
  }
  if (ctx.detached) return null;
  const anchor = document.querySelector('.turn[data-id="' + tid + '"]') || document.getElementById('content');
  if (!anchor) return null;
  if (ev === 'page_progress') {
    let status = anchor.querySelector('[data-page-progress]');
    if (!status) { status = document.createElement('p'); status.dataset.pageProgress = ''; status.dataset.pageTurn = tid; status.setAttribute('role', 'status'); anchor.append(status); }
    status.textContent = String(d.line || ''); return null;
  }
  const id = 'page-approval-' + d.id;
  if (document.getElementById(id)) return null;
  const form = document.createElement('section'); form.id = id; form.dataset.pageTurn = tid; form.setAttribute('aria-label', 'Permission request');
  const title = document.createElement('p'); title.textContent = d.operation + ': ' + d.target;
  const detail = document.createElement('p'); detail.textContent = d.reason + ' ' + d.effect;
  const result = document.createElement('p'); result.setAttribute('role', 'status'); form.append(title, detail, result);
  for (const [decision, label] of [['approve_once', 'Approve once'], ['deny', 'Deny']]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', async () => {
      const buttons = form.querySelectorAll('button'); buttons.forEach(b => { b.disabled = true; });
      try {
        const response = await fetch('/api/page/turns/' + encodeURIComponent(d.conv) + '/' + tid + '/approval', {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: d.id, decision})
        });
        if (!response.ok) throw new Error('Permission decision could not be saved.');
        result.textContent = decision === 'approve_once' ? 'Approved once. Continuing…' : 'Denied.';
      } catch (error) { result.textContent = error.message; buttons.forEach(b => { b.disabled = false; }); }
    });
    form.append(button);
  }
  anchor.append(form); return null;
}
