/* Small UI helpers shared by every screen: icons, the pixel robots (same grids as the desktop app), usage rings,
   text formatting, toasts and bottom sheets. Look D markup, matching mockups/gen.py. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- icons (stroke, 24 grid)
  const P = {
    mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chat: '<path d="M20 12.5a7.5 7.5 0 0 1-11 6.6L4 20l1.2-4.4A7.5 7.5 0 1 1 20 12.5Z"/>',
    inbox: '<path d="M3.5 13.5 6 5.5h12l2.5 8v5h-17zM3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>',
    folder: '<path d="M3.5 7.5v11h17v-9h-8.5l-2-2.5h-6.5z"/>',
    pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
    shield: '<path d="M12 3.5 19 6v5.5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
    net: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.3 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.3-3.5-8.5s1-6 3.5-8.5Z"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    chev: '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
    term: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
    arrowup: '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>',
    qr: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
    flash: '<path d="M13 3 5.5 13.5H12L11 21l7.5-10.5H12z"/>',
    file: '<path d="M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4"/>',
  };
  function ic(name, size, sw, cls) {
    size = size || 20;
    return `<svg class="ic ${cls || ''}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
           `stroke-width="${sw || 1.9}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name]}</svg>`;
  }

  // ---------------------------------------------------------------- pixel robots
  const V = {
    A: ['....AA....', '....A.....', '.HHHHHHHH.', '.HHHHHHHH.', '.HEEHHEEH.', '.HEEHHEEH.', '.HHHHHHHH.', '.HMMMMMMH.', '.HHHHHHHH.', '..DDDDDD..'],
    B: ['..........', '.A......A.', '.AHHHHHHA.', '.HHHHHHHH.', '.HEEHHEEH.', '.HEEHHEEH.', '.HHMMMMHH.', '.HHHHHHHH.', '..HHHHHH..', '...DDDD...'],
    C: ['...AAAA...', '..HHHHHH..', '.HHHHHHHH.', '.HEEEEEEH.', '.HEEEEEEH.', '.HHHHHHHH.', '.HHMHHMHH.', '.HHHMMHHH.', '..HHHHHH..', '..DDDDDD..'],
    D: ['A........A', 'AA......AA', '.HHHHHHHH.', '.HHHHHHHH.', '.HHEEEEHH.', '.HHEEEEHH.', '.HHHHHHHH.', '.HMHMHMHH.', '.HHHHHHHH.', '..DDDDDD..'],
    E: ['..A....A..', '.AAA..AAA.', '.HHHHHHHH.', '.HHHHHHHH.', '.HEHHHHEH.', '.HEEHHEEH.', '.HHHHHHHH.', '.HHMMMMHH.', '..HHHHHH..', '...DDDD...'],
  };
  const WHO = {
    gup: ['E', '#7c8cff'], casper: ['A', '#ff9a4d'], sky: ['B', '#4dd0e1'], gizmo: ['D', '#ffd166'], pocket: ['C', '#5fe08a'],
    librarian: ['E', '#b58cff'], reviewer: ['E', '#b58cff'], builder: ['C', '#5fe08a'], investigator: ['B', '#9aa3b2'],
  };
  const PALETTE = ['#ff9a4d', '#4dd0e1', '#ffd166', '#5fe08a', '#f06ac0', '#b58cff', '#9aa3b2'];
  function whoFor(name) {
    const n = String(name || '').toLowerCase();
    if (WHO[n]) return WHO[n];
    for (const k of Object.keys(WHO)) if (n.includes(k)) return WHO[k];
    let h = 0;
    for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return ['ABCDE'[h % 5], PALETTE[(h >>> 3) % PALETTE.length]];
  }
  function shade(c, f) {
    c = c.replace('#', '');
    let [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16));
    [r, g, b] = [r, g, b].map(x => f < 1 ? Math.floor(x * f) : Math.floor(x + (255 - x) * (f - 1)));
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  /** who: an agent name or [variant, colour]. */
  function bot(who, size, o) {
    o = o || {};
    const [v, col] = Array.isArray(who) ? who : whoFor(who);
    const cm = { H: col, D: shade(col, .6), A: shade(col, 1.45), E: o.eye || '#0c0c14', M: o.eye || '#0c0c14' };
    let rects = '';
    V[v].forEach((row, y) => [...row].forEach((ch, x) => {
      if (cm[ch]) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${cm[ch]}"/>`;
    }));
    const r = o.radius != null ? o.radius : Math.floor(size * .3);
    let st = `width:${size}px;height:${size}px;`;
    if (o.bg !== false) st += `background:${shade(col, .22)};border-radius:${r}px;box-shadow:inset 0 0 0 1px ${shade(col, .45)};`;
    const s = Math.floor(size * .74);
    return `<span class="bot" style="${st}"><svg viewBox="0 0 10 10" shape-rendering="crispEdges" width="${s}" height="${s}">${rects}</svg></span>`;
  }

  // ---------------------------------------------------------------- usage ring (look D: dial ticks, amber stop mark)
  function ring(pct, col, o) {
    o = o || {};
    const size = o.size || 118, sw = o.sw || 11, r = (size - sw) / 2, c = 2 * Math.PI * r, h = size / 2;
    const val = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    let extra = '';
    for (let k = 0; k < 40; k++) {
      const a = 2 * Math.PI * k / 40, r1 = r - sw / 2 - 4, r2 = r - sw / 2 - (k % 10 === 0 ? 8 : 6);
      extra += `<line x1="${(h + r1 * Math.cos(a)).toFixed(1)}" y1="${(h + r1 * Math.sin(a)).toFixed(1)}" x2="${(h + r2 * Math.cos(a)).toFixed(1)}" ` +
               `y2="${(h + r2 * Math.sin(a)).toFixed(1)}" stroke="rgba(255,255,255,${k % 10 === 0 ? .35 : .14})" stroke-width="1"/>`;
    }
    if (o.mark) {
      const a = -Math.PI / 2 + 2 * Math.PI * o.mark, i = r - sw / 2 - 2, j = r + sw / 2 + 2;
      extra += `<line x1="${(h + i * Math.cos(a)).toFixed(1)}" y1="${(h + i * Math.sin(a)).toFixed(1)}" x2="${(h + j * Math.cos(a)).toFixed(1)}" ` +
               `y2="${(h + j * Math.sin(a)).toFixed(1)}" stroke="var(--amber)" stroke-width="3" stroke-linecap="round"/>`;
    }
    const label = pct == null ? '--' : Math.round(pct) + '%';
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}">` +
      `<circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="${sw}"/>` +
      (val > 0 ? `<circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" ` +
                 `stroke-dasharray="${(c * val / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${h} ${h})"/>` : '') + extra +
      `<text x="50%" y="53%" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-size="25" font-weight="800" ` +
      `font-family="JetBrains Mono, monospace" letter-spacing="-1.5">${label}</text></svg>`;
  }

  // ---------------------------------------------------------------- text and time
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Chat text: escaped, then **bold**, `code`, #123 ticket refs and line breaks. */
  function fmtText(s) {
    return esc(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(>])#(\d{1,6})\b/g, '$1<b class="acc">#$2</b>')
      .replace(/\n/g, '<br>');
  }
  const pad = n => String(n).padStart(2, '0');
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  /** 9:12 today, Mon 9:12 this week, Oct 3 9:12 before. */
  function when(ts) {
    const d = new Date(ts), now = new Date();
    if (isNaN(d)) return '';
    const hm = `${d.getHours()}:${pad(d.getMinutes())}`;
    if (sameDay(d, now)) return hm;
    if (now - d < 6 * 86400e3) return `${DAYS[d.getDay()]} ${hm}`;
    return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
  }
  /** 9:13 AM */
  function clock(ts, withDay) {
    const d = new Date(ts);
    if (isNaN(d)) return '';
    const h = d.getHours() % 12 || 12, m = d.getMinutes(), ap = d.getHours() < 12 ? 'AM' : 'PM';
    const t = m ? `${h}:${pad(m)} ${ap}` : `${h} ${ap}`;
    return withDay && !sameDay(d, new Date()) ? `${DAYS[d.getDay()]} ${t}` : t;
  }
  /** 4m, 2h, 3d */
  function ago(ts, now) {
    const s = Math.max(0, ((now || Date.now()) - new Date(ts)) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

  // ---------------------------------------------------------------- toast and sheets
  let toastTimer = null;
  function toast(html, kind) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = `toast g ${kind || ''}`;
    t.setAttribute('role', 'status');
    t.innerHTML = html;
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), kind === 'bad' ? 5000 : 3200);
    t.addEventListener('click', () => t.remove());
  }

  /** Opens a glass bottom sheet with the given inner HTML. Returns {el, close}. Tapping the dimmer closes it
      (onClose runs once, however it closes). */
  function sheet(html, onClose) {
    const dim = document.createElement('div');
    dim.className = 'dimmer';
    const el = document.createElement('div');
    el.className = 'vsheet g';
    el.setAttribute('role', 'dialog');
    el.innerHTML = html;
    document.body.append(dim, el);
    let open = true;
    function close() {
      if (!open) return;
      open = false;
      dim.remove(); el.remove();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      if (onClose) onClose();
    }
    dim.addEventListener('click', close);
    return { el, close };
  }

  root.GupUI = { ic, bot, whoFor, ring, esc, fmtText, when, clock, ago, cap, toast, sheet };
})(window);
