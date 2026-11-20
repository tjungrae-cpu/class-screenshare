/* 햇반 그림퀴즈 — 공통 모듈 (선생님·학생 화면이 함께 씁니다) */
(function () {
  'use strict';
  const HCM = (window.HCM = {});
  HCM.VERSION = '1.0.0';
  HCM.PROTO = 1;
  HCM.ID_PREFIX = 'hatban-cm1-';
  HCM.W = 1600; // 그림판 논리 크기 (4:3)
  HCM.H = 1200;

  const qs = new URLSearchParams(location.search);
  HCM.qs = qs;

  /* ---------- 연결 설정 ---------- */
  // 기본: PeerJS 공용 중계 서버 + 구글 STUN + PeerJS TURN(직접 연결이 막힐 때 우회)
  // 시험용: ?peerhost=localhost:9000 을 붙이면 지정한 PeerJS 서버를 씁니다.
  HCM.peerOptions = function () {
    const opts = {
      debug: 1,
      config: {
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
          {
            urls: [
              'turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478',
              'turn:eu-0.turn.peerjs.com:3478?transport=tcp', 'turn:us-0.turn.peerjs.com:3478?transport=tcp'
            ],
            username: 'peerjs',
            credential: 'peerjsp'
          }
        ]
      }
    };
    const ph = qs.get('peerhost');
    if (ph) {
      const [host, port] = ph.split(':');
      Object.assign(opts, { host, port: Number(port || 9000), path: '/', secure: false });
      opts.config = { iceServers: [] };
    }
    return opts;
  };
  HCM.extraQuery = function () {
    const ph = qs.get('peerhost');
    return ph ? '&peerhost=' + encodeURIComponent(ph) : '';
  };
  HCM.hostId = room => HCM.ID_PREFIX + String(room).trim();

  /* ---------- 저장소 ---------- */
  HCM.store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } },
    getJSON(k, d = null) { const v = this.get(k); if (v == null) return d; try { return JSON.parse(v); } catch (e) { return d; } },
    setJSON(k, v) { try { return this.set(k, JSON.stringify(v)); } catch (e) { return false; } }
  };

  /* ---------- 글자 도구 ---------- */
  HCM.uid = function (n = 12) {
    const a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (const b of a) s += chars[b % chars.length];
    return s;
  };
  HCM.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  HCM.norm = s => String(s || '').normalize('NFC').toLowerCase().replace(/[\s.,!?~\-_'"`()[\]{}·…:;\\/|]+/g, '');
  HCM.altWords = w => String(w || '').split(/[|/]/).map(x => x.trim()).filter(Boolean);
  HCM.mainWord = w => HCM.altWords(w)[0] || '';
  HCM.isCorrect = (ans, word) => {
    const a = HCM.norm(ans);
    if (!a) return false;
    return HCM.altWords(word).some(w => HCM.norm(w) === a);
  };
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  HCM.chosung = w => Array.from(HCM.mainWord(w)).map(ch => {
    const c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) return CHO[Math.floor((c - 0xac00) / 588)];
    return ch;
  }).join('');
  HCM.letterCount = w => Array.from(HCM.mainWord(w)).filter(ch => ch.trim()).length;
  HCM.blanks = w => Array.from(HCM.mainWord(w)).map(ch => (ch.trim() ? '○' : ' ')).join('');
  HCM.cleanName = s => String(s || '').normalize('NFC').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
  HCM.cleanAnswer = s => String(s || '').normalize('NFC').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);

  /* ---------- 메시지 ---------- */
  HCM.send = function (conn, obj) {
    if (!conn || !conn.open) return false;
    try { conn.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; } catch (e) { return false; }
  };
  HCM.parse = function (raw) {
    if (raw && typeof raw === 'object' && !(raw instanceof ArrayBuffer)) return raw;
    if (typeof raw !== 'string') return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  };

  /* ---------- 그림 데이터 ---------- */
  // 획(stroke): { id, c: 색, w: 굵기, e: 지우개(0/1), p: [x0,y0,x1,y1,...] }
  // 작업(op):  ['c'] 전체 지우기 | ['s', 획] 획 시작 | ['p', id, 점들] 점 이어 붙이기 | ['u', id] 획 취소
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  HCM.sanitizePts = function (p, maxPairs = 4000) {
    if (!Array.isArray(p)) return null;
    const n = Math.min(p.length - (p.length % 2), maxPairs * 2);
    const out = new Array(n);
    for (let i = 0; i < n; i += 2) {
      const x = +p[i], y = +p[i + 1];
      if (!isFinite(x) || !isFinite(y)) return null;
      out[i] = Math.max(0, Math.min(HCM.W, Math.round(x)));
      out[i + 1] = Math.max(0, Math.min(HCM.H, Math.round(y)));
    }
    return out;
  };
  HCM.sanitizeOps = function (ops) {
    if (!Array.isArray(ops) || ops.length > 600) return null;
    const out = [];
    for (const op of ops) {
      if (!Array.isArray(op)) continue;
      const k = op[0];
      if (k === 'c') out.push(['c']);
      else if (k === 's') {
        const s = op[1];
        if (!s || typeof s.id !== 'string' || s.id.length > 24) continue;
        const pts = HCM.sanitizePts(s.p);
        if (!pts || pts.length < 2) continue;
        out.push(['s', { id: s.id, c: COLOR_RE.test(s.c) ? s.c : '#222222', w: Math.max(1, Math.min(160, Math.round(+s.w || 8))), e: s.e ? 1 : 0, p: pts }]);
      } else if (k === 'p') {
        if (typeof op[1] !== 'string') continue;
        const pts = HCM.sanitizePts(op[2]);
        if (!pts || !pts.length) continue;
        out.push(['p', op[1], pts]);
      } else if (k === 'u') {
        if (typeof op[1] !== 'string') continue;
        out.push(['u', op[1]]);
      }
    }
    return out;
  };
  // 전체 그림을 작은 메시지 여러 개로 나눕니다 (첫 메시지는 전체 지우기로 시작)
  HCM.strokesToOps = function (strokes, maxChars = 11000) {
    const msgs = [];
    let cur = [['c']];
    let size = 8;
    const PER = 900; // 한 작업에 담는 점 개수
    const push = op => {
      const len = JSON.stringify(op).length;
      if (size + len > maxChars && cur.length) { msgs.push(cur); cur = []; size = 8; }
      cur.push(op);
      size += len;
    };
    for (const s of strokes) {
      push(['s', { id: s.id, c: s.c, w: s.w, e: s.e, p: s.p.slice(0, PER * 2) }]);
      for (let i = PER * 2; i < s.p.length; i += PER * 2) push(['p', s.id, s.p.slice(i, i + PER * 2)]);
    }
    if (cur.length) msgs.push(cur);
    return msgs;
  };

  /* ---------- 그림판 ---------- */
  class Board {
    constructor(canvas, opts = {}) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.strokes = [];
      this.map = new Map();
      this.editable = false;
      this.tool = { c: '#222222', w: 12, e: 0 };
      this.onOps = opts.onOps || null;
      this.scale = 1;
      this.sid = HCM.uid(3);
      this.seq = 0;
      this.active = null;
      this.pendingOps = [];
      this.flushTimer = null;
      const box = canvas.parentElement;
      if (window.ResizeObserver) { this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(box); }
      window.addEventListener('resize', () => this.resize());
      this.bindInput();
      this.resize();
    }
    resize() {
      const box = this.cv.parentElement;
      const cs = getComputedStyle(box);
      const bw = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const bh = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (bw <= 10 || bh <= 10) return;
      let w = bw, h = (bw * HCM.H) / HCM.W;
      if (h > bh) { h = bh; w = (bh * HCM.W) / HCM.H; }
      w = Math.floor(w); h = Math.floor(h);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      this.cv.style.width = w + 'px';
      this.cv.style.height = h + 'px';
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (this.cv.width !== pw || this.cv.height !== ph) {
        this.cv.width = pw;
        this.cv.height = ph;
        this.scale = pw / HCM.W;
        this.redraw();
      }
      this.scale = this.cv.width / HCM.W;
    }
    redraw() {
      const c = this.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, this.cv.width, this.cv.height);
      for (const s of this.strokes) this.drawFrom(s, 0);
    }
    drawFrom(s, from) {
      const c = this.ctx, k = this.scale, p = s.p, n = p.length / 2;
      if (!n) return;
      const col = s.e ? '#ffffff' : s.c;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.strokeStyle = col;
      c.fillStyle = col;
      c.lineWidth = Math.max(1, s.w * k);
      if (n === 1) {
        c.beginPath();
        c.arc(p[0] * k, p[1] * k, Math.max(0.6, (s.w * k) / 2), 0, Math.PI * 2);
        c.fill();
        return;
      }
      let i = Math.max(0, Math.min(from, n - 2));
      c.beginPath();
      c.moveTo(p[i * 2] * k, p[i * 2 + 1] * k);
      for (i = i + 1; i < n; i++) c.lineTo(p[i * 2] * k, p[i * 2 + 1] * k);
      c.stroke();
    }
    applyOps(ops) {
      let full = false;
      for (const op of ops) {
        const k = op[0];
        if (k === 'c') {
          this.strokes.length = 0;
          this.map.clear();
          full = true;
        } else if (k === 's') {
          const s0 = op[1];
          if (!s0 || this.map.has(s0.id)) continue;
          const s = { id: s0.id, c: s0.c, w: s0.w, e: s0.e ? 1 : 0, p: s0.p.slice() };
          this.strokes.push(s);
          this.map.set(s.id, s);
          if (!full) this.drawFrom(s, 0);
        } else if (k === 'p') {
          const s = this.map.get(op[1]);
          if (!s) continue;
          const m = s.p.length / 2;
          const add = op[2];
          for (let i = 0; i < add.length; i++) s.p.push(add[i]);
          if (!full) this.drawFrom(s, Math.max(0, m - 1));
        } else if (k === 'u') {
          const s = this.map.get(op[1]);
          if (!s) continue;
          this.map.delete(op[1]);
          const i = this.strokes.indexOf(s);
          if (i >= 0) this.strokes.splice(i, 1);
          full = true;
        }
      }
      if (full) this.redraw();
    }
    setStrokes(arr) {
      this.strokes = arr;
      this.map = new Map(arr.map(s => [s.id, s]));
      this.redraw();
    }
    counts() {
      let pts = 0;
      for (const s of this.strokes) pts += s.p.length / 2;
      return [this.strokes.length, pts];
    }
    /* --- 직접 그리기 (출제자) --- */
    bindInput() {
      const cv = this.cv;
      const toPt = e => {
        const r = cv.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
        return [Math.round(x * HCM.W), Math.round(y * HCM.H)];
      };
      cv.addEventListener('pointerdown', e => {
        if (!this.editable || this.active) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        try { cv.setPointerCapture(e.pointerId); } catch (_) { /* 무시 */ }
        const [x, y] = toPt(e);
        const s = { id: this.sid + (++this.seq).toString(36), c: this.tool.c, w: this.tool.w, e: this.tool.e ? 1 : 0, p: [x, y] };
        this.active = { pid: e.pointerId, s, lx: x, ly: y };
        this.strokes.push(s);
        this.map.set(s.id, s);
        this.drawFrom(s, 0);
        this.queue(['s', { id: s.id, c: s.c, w: s.w, e: s.e, p: [x, y] }]);
      });
      const move = e => {
        const a = this.active;
        if (!a || e.pointerId !== a.pid) return;
        e.preventDefault();
        if (!this.editable) { this.active = null; this.flush(); return; }
        const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
        const evs = list && list.length ? list : [e];
        const s = a.s;
        const m = s.p.length / 2;
        const add = [];
        for (const ev of evs) {
          const [x, y] = toPt(ev);
          const dx = x - a.lx, dy = y - a.ly;
          if (dx * dx + dy * dy < 5) continue;
          a.lx = x; a.ly = y;
          s.p.push(x, y);
          add.push(x, y);
        }
        if (add.length) {
          this.drawFrom(s, m - 1);
          this.queue(['p', s.id, add]);
        }
      };
      cv.addEventListener('pointermove', move);
      const end = e => {
        const a = this.active;
        if (!a || e.pointerId !== a.pid) return;
        this.active = null;
        this.flush();
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('lostpointercapture', end);
    }
    queue(op) {
      const last = this.pendingOps[this.pendingOps.length - 1];
      if (op[0] === 'p' && last && last[0] === 'p' && last[1] === op[1]) { for (const v of op[2]) last[2].push(v); }
      else if (op[0] === 'p' && last && last[0] === 's' && last[1].id === op[1]) { for (const v of op[2]) last[1].p.push(v); }
      else this.pendingOps.push(op);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 40);
    }
    flush() {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      if (!this.pendingOps.length) return;
      const ops = this.pendingOps;
      this.pendingOps = [];
      if (this.onOps) this.onOps(ops);
    }
    dropPending() {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.pendingOps = [];
    }
    undo() {
      if (this.active) return;
      const s = this.strokes[this.strokes.length - 1];
      if (!s) return;
      this.applyOps([['u', s.id]]);
      this.queue(['u', s.id]);
      this.flush();
    }
    clearLocal() {
      this.active = null;
      this.dropPending();
      this.applyOps([['c']]);
      this.queue(['c']);
      this.flush();
    }
  }
  HCM.Board = Board;

  /* ---------- 효과음 (파일 없이 직접 만듭니다) ---------- */
  HCM.sfx = (function () {
    let ctx = null;
    let enabled = true;
    function ac() {
      if (!ctx) {
        const A = window.AudioContext || window.webkitAudioContext;
        if (!A) return null;
        try { ctx = new A(); } catch (e) { return null; }
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    function tone(freq, start, dur, type = 'sine', vol = 0.16) {
      const c = ac();
      if (!c || c.state !== 'running') return;
      const t0 = c.currentTime + start;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    }
    const SOUNDS = {
      join: () => { tone(660, 0, 0.12); tone(880, 0.08, 0.16); },
      start: () => { tone(523, 0, 0.15, 'triangle'); tone(659, 0.12, 0.15, 'triangle'); tone(784, 0.24, 0.3, 'triangle'); },
      tick: () => tone(1046, 0, 0.07, 'square', 0.05),
      correct: () => { tone(784, 0, 0.12, 'triangle'); tone(988, 0.1, 0.12, 'triangle'); tone(1319, 0.2, 0.28, 'triangle'); },
      wrong: () => { tone(233, 0, 0.16, 'sawtooth', 0.06); tone(196, 0.14, 0.22, 'sawtooth', 0.06); },
      end: () => { tone(392, 0, 0.2, 'triangle'); tone(330, 0.18, 0.2, 'triangle'); tone(262, 0.36, 0.45, 'triangle'); },
      fanfare: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.22, 'triangle')); tone(1047, 0.5, 0.6, 'triangle'); },
      submit: () => tone(740, 0, 0.08, 'sine', 0.1)
    };
    return {
      unlock() { ac(); },
      set enabled(v) { enabled = !!v; },
      get enabled() { return enabled; },
      play(name) { if (!enabled) return; try { if (SOUNDS[name]) SOUNDS[name](); } catch (e) { /* 무시 */ } }
    };
  })();

  /* ---------- 화면 꺼짐 방지 ---------- */
  HCM.keepAwake = function () {
    let lock = null;
    let busy = false;
    async function req() {
      if (busy || lock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } catch (e) { /* 지원 안 함 */ }
      busy = false;
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') req(); });
    document.addEventListener('pointerdown', req, { passive: true });
    req();
  };

  /* ---------- 백그라운드에서도 멈추지 않는 시계 ---------- */
  // 브라우저는 숨겨진 탭의 타이머를 늦추지만, Worker 안의 타이머는 덜 늦춥니다.
  HCM.ticker = function (ms, fn) {
    try {
      const src = 'let id=null;onmessage=function(e){clearInterval(id);id=setInterval(function(){postMessage(0)},e.data)}';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = () => { try { fn(); } catch (e) { console.error(e); } };
      w.postMessage(ms);
      return () => w.terminate();
    } catch (e) {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    }
  };

  /* ---------- 알림 ---------- */
  HCM.toast = function (msg, kind = '', ms = 2600) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms);
  };

  /* ---------- 앱 설치(홈 화면에 추가) 지원 ---------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost') && !qs.get('nosw')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
})();
