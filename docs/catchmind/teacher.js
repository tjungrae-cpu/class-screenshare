/* 햇반 그림퀴즈 — 선생님(호스트) 화면
   이 화면이 '방'이 됩니다. 학생 태블릿은 이 화면에 직접 연결(WebRTC)되고,
   점수·그림·정답은 모두 이 컴퓨터가 관리합니다. (새로고침해도 이어서 진행) */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = HCM.esc;
  const now = () => Date.now();
  const KEY = 'hcm.host.v1';
  const WORDS = window.HCM_WORDS || {};
  const CUSTOM_CAT = '우리 반';
  const CAT_LIST = Object.keys(WORDS).concat([CUSTOM_CAT]);
  const DEFAULT_CATS = ['동물', '음식', '학교', '물건', '탈것·장소', '자연·날씨', '운동·놀이', '직업', CUSTOM_CAT];
  const DEFAULTS = {
    time: 90, answerMode: 'secret', scoring: 'third', hint: 'length', wordMode: 'teacher',
    cats: DEFAULT_CATS, customWords: '잡곡이, 햇반, 티볼, 밥솥, 귀신의 집',
    auto: false, autoGap: 10, sound: true, lock: false, roster: '', rosterOnly: true
  };
  const TIMES = [30, 60, 90, 120];

  /* ================= 상태 ================= */
  function makeState(room, settings) {
    const set = Object.assign({}, DEFAULTS, settings || {});
    set.cats = Array.isArray(set.cats) ? set.cats.slice() : DEFAULT_CATS.slice();
    return { v: 1, room, roundNo: 0, settings: set, players: {}, round: null, history: [], used: [], kicked: [], sv: 1, updatedAt: now() };
  }
  function randomRoom(except) {
    let c;
    do { c = String(1000 + Math.floor(Math.random() * 9000)); } while (c === except);
    return c;
  }
  function loadState() {
    const s = HCM.store.getJSON(KEY);
    if (!s || s.v !== 1 || !/^\d{4}$/.test(String(s.room))) return null;
    s.settings = Object.assign({}, DEFAULTS, s.settings || {});
    if (!Array.isArray(s.settings.cats)) s.settings.cats = DEFAULT_CATS.slice();
    if (!TIMES.includes(s.settings.time)) s.settings.time = 90;
    // 8시간 넘게 지난 게임은 같은 방 번호·설정으로 새로 시작
    if (now() - (s.updatedAt || 0) > 8 * 3600 * 1000) return makeState(s.room, s.settings);
    s.players = s.players || {};
    s.history = s.history || [];
    s.used = s.used || [];
    s.kicked = s.kicked || [];
    s.sv = (s.sv || 1) + 1;
    for (const p of Object.values(s.players)) p.online = !!p.bot;
    if (s.round) {
      const r = s.round;
      r.strokes = r.strokes || [];
      r.answers = r.answers || {};
      r.order = r.order || [];
      r.participants = r.participants || [];
    }
    return s;
  }
  let S = loadState() || makeState(randomRoom());

  const R = {
    peer: null, net: 'connecting', conns: new Map(), info: new WeakMap(), allConns: new Set(), lastErr: null,
    sigTimer: null, restartTimer: null,
    board: null, dirty: false, saveTimer: null, stTimer: null, cntTimer: null, renderQueued: false,
    lastPing: 0, lastNetCheck: 0, lastTickSec: -1, nextAt: 0, botTimers: [],
    nextDrawer: '', peek: false, flashTimer: null, mp: null
  };

  const players = () => Object.values(S.players);
  const P = pid => S.players[pid];
  const nameKey = n => HCM.norm(n);
  const findByToken = t => players().find(p => p.token && p.token === t) || null;
  const findByName = n => { const k = nameKey(n); return players().find(p => nameKey(p.name) === k) || null; };
  const ranked = () => players().slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ko'));
  const rankOf = pid => { const me = P(pid); if (!me) return 0; return 1 + players().filter(p => p.score > me.score).length; };
  const top5 = () => ranked().slice(0, 5).map(p => ({ n: p.name, s: p.score }));
  const fmtTime = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const splitWords = s => String(s || '').split(/[,\n]+/).map(x => x.trim()).filter(Boolean);

  function parseRoster(text) {
    const out = [];
    const seen = new Set();
    String(text || '').split(/[\n,]+/).forEach(line => {
      const n = HCM.cleanName(line.replace(/^\s*\d+\s*[.)번:\-]?\s*/, ''));
      if (n && !seen.has(nameKey(n))) { seen.add(nameKey(n)); out.push(n); }
    });
    return out;
  }
  const rosterList = () => parseRoster(S.settings.roster);

  /* ================= 저장 ================= */
  function markDirty() {
    R.dirty = true;
    if (!R.saveTimer) R.saveTimer = setTimeout(save, 800);
  }
  function save() {
    clearTimeout(R.saveTimer);
    R.saveTimer = null;
    if (!R.dirty) return;
    R.dirty = false;
    S.updatedAt = now();
    HCM.store.setJSON(KEY, S);
  }

  /* ================= 연결 (PeerJS) ================= */
  function setNet(s) { R.net = s; renderNet(); }

  function startPeer() {
    clearTimeout(R.restartTimer);
    clearTimeout(R.sigTimer);
    R.restartTimer = R.sigTimer = null;
    const old = R.peer;
    R.peer = null; // 옛 연결이 닫히며 내는 신호는 무시
    if (old) { try { old.destroy(); } catch (e) { /* 무시 */ } }
    if (R.net !== 'idtaken') setNet('connecting');
    let peer;
    try {
      peer = new Peer(HCM.hostId(S.room), HCM.peerOptions());
    } catch (e) {
      console.error(e);
      setNet('error');
      R.restartTimer = setTimeout(startPeer, 3000);
      return;
    }
    R.peer = peer;
    peer.on('open', () => { if (peer === R.peer) { R.lastErr = null; setNet('online'); } });
    peer.on('connection', conn => {
      if (peer !== R.peer) { try { conn.close(); } catch (e) { /* 무시 */ } return; }
      onConnection(conn);
    });
    peer.on('disconnected', () => {
      if (peer !== R.peer) return;
      setNet('reconnecting');
      sigReconnectSoon();
    });
    peer.on('close', () => {
      if (peer !== R.peer) return;
      const taken = R.lastErr === 'unavailable-id';
      setNet(taken ? 'idtaken' : 'reconnecting');
      clearTimeout(R.restartTimer);
      R.restartTimer = setTimeout(startPeer, taken ? 3000 : 2000);
    });
    peer.on('error', err => {
      if (peer !== R.peer) return;
      const t = err && err.type;
      R.lastErr = t;
      console.warn('[peer]', t, err && err.message);
      if (t === 'peer-unavailable') return;
      if (t === 'browser-incompatible') { setNet('unsupported'); return; }
      setNet(t === 'unavailable-id' ? 'idtaken' : 'reconnecting');
      if (peer.destroyed) { clearTimeout(R.restartTimer); R.restartTimer = setTimeout(startPeer, t === 'unavailable-id' ? 3000 : 2000); }
      else if (peer.disconnected) sigReconnectSoon(t === 'unavailable-id' ? 3000 : null);
    });
  }
  // 중계 서버와의 연결만 끊긴 경우: 학생들과의 직접 연결은 그대로 두고 다시 붙습니다.
  function sigReconnectSoon(delay) {
    clearTimeout(R.sigTimer);
    R.sigTimer = setTimeout(() => {
      R.sigTimer = null;
      const p = R.peer;
      if (!p || p.destroyed) { startPeer(); return; }
      if (p.open) { setNet('online'); return; }
      if (p.disconnected) { try { p.reconnect(); } catch (e) { startPeer(); return; } }
      R.sigTimer = setTimeout(() => { R.sigTimer = null; if (R.peer === p && !p.open) sigReconnectSoon(); }, 7000);
    }, delay != null ? delay : 1000 + Math.random() * 1000);
  }
  function netWatchdog() {
    const p = R.peer;
    if (!p) { if (!R.restartTimer) startPeer(); return; }
    if (p.destroyed) { if (!R.restartTimer) R.restartTimer = setTimeout(startPeer, 500); return; }
    if (p.open) { if (R.net !== 'online') setNet('online'); return; }
    if (p.disconnected && !R.sigTimer) sigReconnectSoon(0);
  }

  function onConnection(conn) {
    const info = { pid: null, token: null, lastRx: now() };
    R.info.set(conn, info);
    R.allConns.add(conn);
    conn.on('data', raw => onData(conn, info, raw));
    conn.on('close', () => onConnClose(conn, info));
    conn.on('error', e => console.warn('[conn]', e && e.type));
  }
  function onConnClose(conn, info) {
    R.allConns.delete(conn);
    if (!info.pid) return;
    if (R.conns.get(info.pid) === conn) {
      R.conns.delete(info.pid);
      const p = P(info.pid);
      if (p) { p.online = false; p.lastSeen = now(); }
      bump();
    }
  }
  function reject(conn, code, msg) {
    HCM.send(conn, { type: 'reject', code, msg });
    if (code === 'kicked' || code === 'version') setTimeout(() => { try { conn.close(); } catch (e) { /* 무시 */ } }, 600);
  }

  function onData(conn, info, raw) {
    info.lastRx = now();
    const m = HCM.parse(raw);
    if (!m || typeof m.type !== 'string') return;
    if (info.pid && R.conns.get(info.pid) === conn) {
      const p = P(info.pid);
      if (p) { p.lastSeen = info.lastRx; if (!p.online) { p.online = true; bump(); } }
    }
    try {
      switch (m.type) {
        case 'hello': onHello(conn, info, m); return;
        case 'join': onJoin(conn, info, m); return;
        case 'ka': HCM.send(conn, { type: 'ka' }); return; // 이름 고르는 동안 연결 유지
        case 'pong': return;
      }
      if (!info.pid || R.conns.get(info.pid) !== conn) return;
      const pid = info.pid;
      switch (m.type) {
        case 'ops': onOps(pid, m); break;
        case 'ans': onAnswer(pid, m); break;
        case 'pick': onPick(pid, m); break;
        case 'need_st': sendState(pid); break;
        case 'need_strokes': sendStrokes(pid); break;
        case 'bye': { // 학생이 창을 닫거나 새로고침: 바로 '끊김'으로 표시
          R.conns.delete(pid);
          const p = P(pid);
          if (p) { p.online = false; p.lastSeen = now(); }
          bump();
          break;
        }
      }
    } catch (e) { console.error(e); }
  }

  function onHello(conn, info, m) {
    if (m.proto !== HCM.PROTO) { reject(conn, 'version', '선생님 화면과 버전이 달라요. 화면을 새로고침해 주세요.'); return; }
    const token = typeof m.token === 'string' && /^[a-z0-9]{8,40}$/.test(m.token) ? m.token : null;
    if (!token) { reject(conn, 'bad', '접속 정보가 잘못됐어요. 새로고침해 주세요.'); return; }
    info.token = token;
    if (S.kicked.includes(token)) { reject(conn, 'kicked', '선생님이 이 기기를 방에서 내보냈어요.'); return; }
    const p = findByToken(token);
    if (p) { bind(conn, info, p); return; }
    HCM.send(conn, { type: 'need_name', roster: rosterInfo(), locked: !!S.settings.lock });
  }
  function rosterInfo() {
    const list = rosterList();
    if (!list.length) return null;
    return list.map(n => { const p = findByName(n); return { n, t: !!(p && p.token) }; });
  }
  function onJoin(conn, info, m) {
    const token = info.token;
    if (!token) { reject(conn, 'bad', '다시 연결해 주세요.'); return; }
    if (S.kicked.includes(token)) { reject(conn, 'kicked', '선생님이 이 기기를 방에서 내보냈어요.'); return; }
    let p = findByToken(token);
    if (p) { bind(conn, info, p); return; }
    const name = HCM.cleanName(m.name);
    if (!name) { reject(conn, 'name_bad', '이름을 다시 써 주세요.'); return; }
    const roster = rosterList();
    if (roster.length && S.settings.rosterOnly && !roster.some(n => nameKey(n) === nameKey(name))) {
      reject(conn, 'not_in_roster', '우리 반 명단에 없는 이름이에요. 목록에서 내 이름을 눌러 주세요.');
      return;
    }
    p = findByName(name);
    if (p) {
      if (p.bot) { reject(conn, 'name_taken', '이미 있는 이름이에요. 다른 이름을 써 주세요.'); return; }
      if (p.token && p.token !== token) {
        reject(conn, 'name_taken', `‘${p.name}’ 이름은 이미 다른 기기에서 쓰고 있어요. 내 이름이 맞다면 선생님께 말씀드려요.`);
        return;
      }
      p.token = token;
      bind(conn, info, p);
      return;
    }
    if (S.settings.lock) { reject(conn, 'locked', '지금은 새로 들어올 수 없어요. 선생님께 말씀드려요.'); return; }
    if (players().filter(x => !x.bot).length >= 60) { reject(conn, 'full', '방이 꽉 찼어요.'); return; }
    p = { pid: 'p' + HCM.uid(8), name, token, score: 0, drawn: 0, joinedAt: now(), online: true, lastSeen: now() };
    S.players[p.pid] = p;
    bind(conn, info, p);
    HCM.sfx.play('join');
  }
  function bind(conn, info, p) {
    const old = R.conns.get(p.pid);
    info.pid = p.pid;
    R.conns.set(p.pid, conn);
    if (old && old !== conn) { try { old.close(); } catch (e) { /* 무시 */ } }
    p.online = true;
    p.lastSeen = now();
    const r = S.round;
    if (r && r.phase !== 'result' && p.pid !== r.drawer && !r.participants.includes(p.pid)) r.participants.push(p.pid);
    HCM.send(conn, { type: 'welcome', pid: p.pid, name: p.name, room: S.room });
    sendState(p.pid);
    if (r && (r.phase === 'result' || (r.phase === 'draw' && p.pid !== r.drawer))) sendStrokes(p.pid);
    bump();
  }

  /* ---------- 보내기 ---------- */
  function sendState(pid) {
    const c = R.conns.get(pid);
    if (c && P(pid)) HCM.send(c, stateFor(pid));
  }
  function broadcastState() {
    clearTimeout(R.stTimer);
    R.stTimer = null;
    for (const pid of R.conns.keys()) sendState(pid);
  }
  // 상태가 바뀔 때마다 부릅니다: 저장 + 화면 갱신 + 학생들에게 알림
  function bump(immediate) {
    S.sv++;
    markDirty();
    renderSoon();
    if (immediate) broadcastState();
    else if (!R.stTimer) R.stTimer = setTimeout(broadcastState, 150);
  }
  function sendStrokes(pid) {
    const c = R.conns.get(pid);
    const r = S.round;
    if (!c || !r) return;
    const msgs = HCM.strokesToOps(R.board.strokes);
    msgs.forEach((ops, i) => HCM.send(c, { type: 'ops', rno: r.no, ops, snap: 1, last: i === msgs.length - 1 ? 1 : 0 }));
  }
  function relay(obj, exceptPid) {
    const raw = JSON.stringify(obj);
    for (const [pid, c] of R.conns) {
      if (pid === exceptPid || !c.open) continue;
      try { c.send(raw); } catch (e) { /* 무시 */ }
    }
  }
  function cntSoon() {
    if (R.cntTimer) return;
    R.cntTimer = setTimeout(() => {
      R.cntTimer = null;
      const r = S.round;
      if (r && r.phase === 'draw') relay({ type: 'cnt', rno: r.no, cnt: counts(r) });
      renderSoon();
    }, 250);
  }

  /* ---------- 학생별 상태 ---------- */
  const phaseNow = () => (S.round ? S.round.phase : 'lobby');
  function remainMs(r) {
    if (!r) return 0;
    if (r.phase === 'pick') return Math.max(0, r.pickEndsAt - now());
    if (r.phase !== 'draw') return 0;
    if (r.paused) return r.pausedRemain;
    return Math.max(0, r.endsAt - now());
  }
  function hintFor(r) {
    const mode = S.settings.hint;
    if (!r || mode === 'none' || !r.word || r.phase !== 'draw') return null;
    const w = HCM.mainWord(r.word);
    const n = HCM.letterCount(w);
    if (mode === 'chosung' && r.half) return { t: HCM.chosung(w), n };
    return { t: HCM.blanks(w), n };
  }
  function counts(r) {
    const parts = r.participants.filter(pid => pid !== r.drawer && P(pid));
    let sub = 0, cor = 0;
    for (const pid of parts) {
      const a = r.answers[pid];
      if (a) { sub++; if (a.ok) cor++; }
    }
    return { sub, cor, elig: parts.length };
  }
  function stateFor(pid) {
    const p = P(pid);
    const r = S.round;
    const set = S.settings;
    const st = {
      type: 'st', sv: S.sv, room: S.room, phase: phaseNow(), mode: set.answerMode,
      me: { pid, name: p.name, score: p.score, rank: rankOf(pid), n: players().length },
      top: top5()
    };
    if (r) {
      const isDrawer = r.drawer === pid;
      const d = P(r.drawer);
      const o = { no: r.no, drawer: r.drawer, dname: d ? d.name : '?', time: r.time, remain: remainMs(r), paused: !!r.paused, cnt: counts(r) };
      if (isDrawer && r.phase === 'draw') o.word = HCM.mainWord(r.word);
      if (isDrawer && r.phase === 'pick') o.choices = (r.choices || []).map(HCM.mainWord);
      if (!isDrawer && r.phase === 'draw') o.hint = hintFor(r);
      const a = r.answers[pid];
      if (a) o.ans = { text: a.text, ok: set.answerMode === 'instant' ? !!a.ok : undefined };
      if (r.phase === 'draw' && set.answerMode === 'instant') o.okNames = r.order.map(x => (P(x) || {}).name).filter(Boolean);
      if (r.phase === 'result') {
        o.word = HCM.mainWord(r.word);
        const res = r.res || { correct: [], parts: 0, award: {} };
        o.res = {
          canceled: !!res.canceled, ok: res.correct.includes(pid), pts: res.award[pid] || 0,
          correct: res.correct.length, parts: res.parts, mode: res.mode || '', rule: res.rule || set.scoring
        };
      }
      st.r = o;
    }
    return st;
  }

  /* ================= 게임 진행 ================= */
  function wordPool() {
    const set = S.settings;
    const pool = [];
    const seen = new Set();
    const add = w => { const k = HCM.norm(HCM.mainWord(w)); if (!k || seen.has(k)) return; seen.add(k); pool.push(w); };
    for (const c of set.cats) {
      if (c === CUSTOM_CAT) splitWords(set.customWords).forEach(add);
      else if (WORDS[c]) splitWords(WORDS[c]).forEach(add);
    }
    if (!pool.length) splitWords(WORDS['동물']).forEach(add);
    return pool;
  }
  function pickWords(n) {
    const pool = wordPool();
    const used = new Set(S.used);
    let fresh = pool.filter(w => !used.has(HCM.norm(HCM.mainWord(w))));
    if (fresh.length < n) { S.used = []; fresh = pool.slice(); }
    const out = [];
    while (out.length < n && fresh.length) out.push(fresh.splice(Math.floor(Math.random() * fresh.length), 1)[0]);
    return out;
  }
  function randomWordForBot() {
    const pool = wordPool();
    return HCM.mainWord(pool[Math.floor(Math.random() * pool.length)] || '몰라요');
  }
  function markUsed(w) {
    const k = HCM.norm(HCM.mainWord(w));
    if (k && !S.used.includes(k)) S.used.push(k);
    if (S.used.length > 1500) S.used = S.used.slice(-800);
  }
  function autoDrawer() {
    const cands = players().filter(p => p.online);
    if (!cands.length) return null;
    const min = Math.min(...cands.map(p => p.drawn || 0));
    let pool = cands.filter(p => (p.drawn || 0) === min);
    const last = S.round && S.round.drawer;
    if (pool.length > 1) pool = pool.filter(p => p.pid !== last);
    return pool[Math.floor(Math.random() * pool.length)].pid;
  }

  function startRound(opts) {
    opts = opts || {};
    const cur = S.round;
    if (cur && (cur.phase === 'draw' || cur.phase === 'pick')) return false;
    const set = S.settings;
    const online = players().filter(p => p.online);
    if (online.length < 2) { if (!opts.auto) HCM.toast('학생이 2명 이상 들어와야 시작할 수 있어요.', 'warn'); return false; }
    let drawer = opts.drawer && P(opts.drawer) && P(opts.drawer).online ? opts.drawer : null;
    if (!drawer) drawer = autoDrawer();
    if (!drawer) return false;
    const time = TIMES.includes(+opts.time) ? +opts.time : set.time;
    const word = opts.word ? String(opts.word).trim().slice(0, 40) : '';
    const r = {
      no: ++S.roundNo, drawer, word: '', time, phase: 'draw', startedAt: now(), endsAt: 0, pickEndsAt: 0,
      paused: false, pausedRemain: 0, answers: {}, order: [], strokes: [], half: false, res: null, applied: null,
      participants: online.map(p => p.pid).filter(x => x !== drawer)
    };
    if (set.wordMode === 'drawer' && !word) {
      r.choices = pickWords(3);
      r.phase = 'pick';
      r.pickEndsAt = now() + 15000;
    } else {
      r.word = word || pickWords(1)[0];
      markUsed(r.word);
      r.endsAt = now() + time * 1000;
    }
    S.round = r;
    R.board.setStrokes(r.strokes);
    R.nextAt = 0;
    R.lastTickSec = -1;
    HCM.sfx.play('start');
    bump(true);
    startBots(r);
    return true;
  }
  function beginDraw(r, word) {
    if (S.round !== r || r.phase !== 'pick') return;
    r.word = word;
    markUsed(word);
    r.phase = 'draw';
    r.choices = null;
    r.endsAt = now() + r.time * 1000;
    HCM.sfx.play('start');
    bump(true);
    startBots(r);
  }
  function onPick(pid, m) {
    const r = S.round;
    if (!r || r.phase !== 'pick' || r.drawer !== pid || m.rno !== r.no) return;
    const i = Math.max(0, Math.min((r.choices || []).length - 1, Number(m.i) || 0));
    beginDraw(r, r.choices[i]);
  }
  function onOps(pid, m) {
    const r = S.round;
    if (!r || r.phase !== 'draw' || r.drawer !== pid || m.rno !== r.no) return;
    const ops = HCM.sanitizeOps(m.ops);
    if (!ops || !ops.length) return;
    applyAndRelay(ops, pid);
  }
  function applyAndRelay(ops, fromPid) {
    const r = S.round;
    if (R.board.strokes.length > 4000) return;
    R.board.applyOps(ops);
    r.strokes = R.board.strokes;
    relay({ type: 'ops', rno: r.no, ops }, fromPid);
    markDirty();
  }
  function onAnswer(pid, m) {
    const r = S.round;
    if (!r || r.phase !== 'draw' || r.drawer === pid || m.rno !== r.no) return;
    const text = HCM.cleanAnswer(m.text);
    if (!text) return;
    if (!r.participants.includes(pid)) r.participants.push(pid);
    const prev = r.answers[pid];
    const c = R.conns.get(pid);
    if (S.settings.answerMode === 'instant') {
      if (prev && prev.ok) { HCM.send(c, { type: 'ack', rno: r.no, text: prev.text, ok: true }); return; }
      if (prev && now() - prev.at < 1000) { HCM.send(c, { type: 'ack', rno: r.no, text: prev.text, ok: false, wait: 1 }); return; }
      const ok = HCM.isCorrect(text, r.word);
      r.answers[pid] = { text, at: now(), ok, tries: ((prev && prev.tries) || 0) + 1 };
      HCM.send(c, { type: 'ack', rno: r.no, text, ok, tries: r.answers[pid].tries });
      if (ok) {
        r.order.push(pid);
        HCM.sfx.play('correct');
        flash(`⭐ ${P(pid).name} 정답!`);
        bump(true);
        if (allCorrect(r)) setTimeout(() => { if (S.round === r) closeRound('all'); }, 1500);
      } else cntSoon();
    } else {
      r.answers[pid] = { text, at: now() };
      HCM.send(c, { type: 'ack', rno: r.no, text });
      cntSoon();
    }
    markDirty();
  }
  function allCorrect(r) {
    const live = r.participants.filter(pid => pid !== r.drawer && P(pid) && P(pid).online);
    return live.length > 0 && live.every(pid => r.answers[pid] && r.answers[pid].ok);
  }
  function judge(r, pid) {
    const a = r.answers[pid];
    if (!a) return false;
    if (a.acc === true) return true;
    if (a.acc === false) return false;
    return HCM.isCorrect(a.text, r.word);
  }
  function computeResult(r) {
    const parts = r.participants.filter(pid => pid !== r.drawer && P(pid));
    const correct = parts.filter(pid => judge(r, pid)).sort((a, b) => r.answers[a].at - r.answers[b].at);
    const award = {};
    const rule = S.settings.scoring;
    let mode = '';
    if (rule === 'third') {
      if (parts.length) {
        if (correct.length > parts.length / 3) {
          mode = 'good';
          correct.forEach(x => { award[x] = 10; });
          if (P(r.drawer)) award[r.drawer] = 10;
        } else {
          mode = 'hard';
          parts.forEach(x => { award[x] = 10; });
        }
      }
    } else {
      correct.forEach((x, i) => { award[x] = 10 + ([5, 3, 1][i] || 0); });
      if (P(r.drawer)) award[r.drawer] = Math.min(10, correct.length * 2);
    }
    r.res = { correct, parts: parts.length, award, rule, mode };
  }
  function applyAward(r) {
    const award = (r.res && r.res.award) || {};
    for (const [pid, pts] of Object.entries(award)) if (P(pid)) P(pid).score += pts;
    r.applied = Object.assign({}, award);
  }
  function revertAward(r) {
    for (const [pid, pts] of Object.entries(r.applied || {})) if (P(pid)) P(pid).score -= pts;
    r.applied = null;
  }
  function closeRound(reason) {
    const r = S.round;
    if (!r || (r.phase !== 'draw' && r.phase !== 'pick')) return;
    clearBots();
    if (r.phase === 'pick' || reason === 'cancel') r.canceled = true;
    r.phase = 'result';
    r.paused = false;
    r.closedAt = now();
    r.reason = reason;
    if (r.canceled) {
      r.res = { canceled: true, correct: [], parts: 0, award: {}, rule: S.settings.scoring, mode: '' };
      r.applied = {};
    } else {
      computeResult(r);
      applyAward(r);
      const d = P(r.drawer);
      if (d) d.drawn = (d.drawn || 0) + 1;
    }
    const d = P(r.drawer);
    S.history.push({ no: r.no, word: HCM.mainWord(r.word), drawer: d ? d.name : '?', correct: r.res.correct.length, parts: r.res.parts, canceled: !!r.canceled, at: now() });
    R.nextAt = S.settings.auto && !r.canceled ? now() + S.settings.autoGap * 1000 : 0;
    HCM.sfx.play(r.canceled ? 'wrong' : 'end');
    bump(true);
  }
  function setAccept(norm, val) {
    const r = S.round;
    if (!r || r.phase !== 'result' || !r.res || r.res.canceled) return;
    for (const a of Object.values(r.answers)) if (HCM.norm(a.text) === norm) a.acc = val;
    revertAward(r);
    computeResult(r);
    applyAward(r);
    const h = S.history.find(x => x.no === r.no);
    if (h) h.correct = r.res.correct.length;
    HCM.sfx.play(val ? 'correct' : 'submit');
    bump(true);
  }
  function togglePause() {
    const r = S.round;
    if (!r || r.phase !== 'draw') return;
    if (r.paused) { r.endsAt = now() + r.pausedRemain; r.paused = false; }
    else { r.pausedRemain = Math.max(0, r.endsAt - now()); r.paused = true; }
    bump(true);
  }
  function addTime(sec) {
    const r = S.round;
    if (!r || r.phase !== 'draw') return;
    if (r.paused) r.pausedRemain += sec * 1000;
    else r.endsAt += sec * 1000;
    bump(true);
  }

  /* ---------- 시계 (0.25초마다) ---------- */
  function tick() {
    const t = now();
    const r = S.round;
    if (r && r.phase === 'draw' && !r.paused) {
      const rem = r.endsAt - t;
      if (rem <= 0) closeRound('time');
      else {
        if (!r.half && rem <= r.time * 500) { r.half = true; if (S.settings.hint === 'chosung') bump(true); }
        const sec = Math.ceil(rem / 1000);
        if (sec !== R.lastTickSec) { R.lastTickSec = sec; if (sec <= 5) HCM.sfx.play('tick'); renderTimer(); }
      }
    } else if (r && r.phase === 'pick') {
      if (t >= r.pickEndsAt) beginDraw(r, r.choices[0]);
      else renderTimer();
    }
    if (r && r.phase === 'result' && R.nextAt) {
      if (t >= R.nextAt) { R.nextAt = 0; if (!startRound({ time: S.settings.time, auto: true })) R.nextAt = now() + 5000; }
      renderAutoCount();
    }
    if (t - R.lastPing >= 2000) { R.lastPing = t; pingAll(); checkStale(); }
    if (t - R.lastNetCheck >= 4000) { R.lastNetCheck = t; netWatchdog(); }
  }
  function pingAll() {
    const r = S.round;
    const msg = { type: 'ping', t: now(), sv: S.sv, ph: phaseNow(), rno: r ? r.no : 0, remain: remainMs(r), paused: !!(r && r.paused) };
    if (r && r.phase === 'draw') { msg.sk = R.board.counts(); msg.cnt = counts(r); }
    relay(msg);
  }
  function checkStale() {
    const t = now();
    let changed = false;
    for (const [pid, c] of Array.from(R.conns)) {
      const info = R.info.get(c);
      const p = P(pid);
      if (!info || !p) { R.conns.delete(pid); continue; }
      const idle = t - info.lastRx;
      if (idle > 9000 && p.online) { p.online = false; changed = true; }
      if (idle > 20000) { R.conns.delete(pid); try { c.close(); } catch (e) { /* 무시 */ } changed = true; }
    }
    // 이름을 고르지 않은 채 오래 조용한 연결 정리
    for (const c of Array.from(R.allConns)) {
      const info = R.info.get(c);
      if (!info || info.pid) continue;
      if (t - info.lastRx > 40000 || (!c.open && t - info.lastRx > 15000)) { R.allConns.delete(c); try { c.close(); } catch (e) { /* 무시 */ } }
    }
    if (changed) bump();
  }

  /* ---------- 학생 관리 ---------- */
  function kick(pid) {
    const p = P(pid);
    if (!p) return;
    const c = R.conns.get(pid);
    if (c) { HCM.send(c, { type: 'kick' }); setTimeout(() => { try { c.close(); } catch (e) { /* 무시 */ } }, 500); }
    R.conns.delete(pid);
    if (p.token && !S.kicked.includes(p.token)) S.kicked.push(p.token);
    const r = S.round;
    if (r && r.drawer === pid && (r.phase === 'draw' || r.phase === 'pick')) closeRound('cancel');
    if (r) r.participants = r.participants.filter(x => x !== pid);
    delete S.players[pid];
    bump(true);
  }
  function releaseDevice(pid) {
    const p = P(pid);
    if (!p || p.bot) return;
    p.token = null;
    HCM.toast(`${p.name}: 이제 다른 기기에서 같은 이름으로 들어올 수 있어요.`);
    bump();
  }
  function resetScores() {
    clearBots();
    for (const p of players()) { p.score = 0; p.drawn = 0; }
    S.history = [];
    S.round = null;
    S.roundNo = 0;
    S.used = [];
    R.nextAt = 0;
    R.board.setStrokes([]);
    bump(true);
  }
  function newRoom() {
    const code = randomRoom(S.room);
    relay({ type: 'moved', room: code }); // 들어와 있던 태블릿은 새 방으로 따라옵니다
    clearBots();
    R.conns = new Map();
    S = makeState(code, S.settings);
    R.board.setStrokes([]);
    R.nextAt = 0;
    R.dirty = true;
    save();
    $('#lobbyOv').dataset.key = '';
    renderSoon();
    setNet('connecting');
    setTimeout(startPeer, 700);
    HCM.toast(`새 방 ${code}을(를) 만들었어요. 들어와 있던 학생은 자동으로 옮겨 와요.`);
  }

  /* ---------- 연습용 봇 ---------- */
  const BOT_NAMES = ['봇 현미', '봇 귀리', '봇 보리', '봇 수수', '봇 흑미', '봇 기장', '봇 율무', '봇 찹쌀', '봇 녹두', '봇 팥'];
  function addBots(n) {
    let added = 0;
    for (const nm of BOT_NAMES) {
      if (added >= n) break;
      if (findByName(nm)) continue;
      const p = { pid: 'b' + HCM.uid(8), name: nm, bot: true, token: null, score: 0, drawn: 0, joinedAt: now(), online: true, lastSeen: now() };
      S.players[p.pid] = p;
      added++;
      const r = S.round;
      if (r && r.phase !== 'result' && !r.participants.includes(p.pid)) r.participants.push(p.pid);
    }
    HCM.toast(added ? `연습용 봇 ${added}명을 넣었어요.` : '봇이 더 들어갈 자리가 없어요.');
    bump(true);
  }
  function removeBots() {
    const r = S.round;
    for (const p of players()) {
      if (!p.bot) continue;
      if (r && r.drawer === p.pid && (r.phase === 'draw' || r.phase === 'pick')) closeRound('cancel');
      if (r) r.participants = r.participants.filter(x => x !== p.pid);
      delete S.players[p.pid];
    }
    bump(true);
  }
  function clearBots() { R.botTimers.forEach(clearTimeout); R.botTimers = []; }
  function botLater(fn, ms) { R.botTimers.push(setTimeout(fn, ms)); }
  function startBots(r) {
    clearBots();
    const d = P(r.drawer);
    if (r.phase === 'pick') {
      if (d && d.bot) botLater(() => beginDraw(r, r.choices[Math.floor(Math.random() * r.choices.length)]), 1500);
      return;
    }
    if (r.phase !== 'draw') return;
    if (d && d.bot) botDraw(r);
    for (const pid of r.participants) { const p = P(pid); if (p && p.bot) botAnswer(r, pid, 0); }
  }
  function botAnswer(r, pid, attempt) {
    const delay = (0.15 + Math.random() * 0.65) * r.time * 1000 * (attempt ? 0.35 : 1);
    botLater(() => {
      if (S.round !== r || r.phase !== 'draw' || !P(pid)) return;
      if (r.paused) { botAnswer(r, pid, attempt); return; }
      const right = Math.random() < 0.55;
      onAnswer(pid, { rno: r.no, text: right ? HCM.mainWord(r.word) : randomWordForBot() });
      if (S.settings.answerMode === 'instant' && !right && attempt < 2) botAnswer(r, pid, attempt + 1);
    }, delay);
  }
  function jitter(pts, a) { return pts.map(v => Math.round(v + (Math.random() - 0.5) * a)); }
  function ellipse(cx, cy, rx, ry, n) {
    const p = [];
    for (let i = 0; i <= n; i++) { const t = (i / n) * Math.PI * 2; p.push(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry); }
    return jitter(p, 6);
  }
  function line(pts, n) {
    const out = [];
    for (let k = 0; k < pts.length - 2; k += 2) {
      for (let i = 0; i < n; i++) out.push(pts[k] + ((pts[k + 2] - pts[k]) * i) / n, pts[k + 1] + ((pts[k + 3] - pts[k + 1]) * i) / n);
    }
    out.push(pts[pts.length - 2], pts[pts.length - 1]);
    return jitter(out, 5);
  }
  function doodle() {
    const kind = ['sun', 'house', 'face', 'flower', 'tree'][Math.floor(Math.random() * 5)];
    const S2 = [];
    const add = (c, w, p) => S2.push({ c, w, p });
    if (kind === 'sun') {
      add('#FB8C00', 16, ellipse(800, 600, 200, 200, 40));
      for (let i = 0; i < 10; i++) { const t = (i / 10) * Math.PI * 2; add('#FDD835', 14, line([800 + Math.cos(t) * 250, 600 + Math.sin(t) * 250, 800 + Math.cos(t) * 360, 600 + Math.sin(t) * 360], 6)); }
    } else if (kind === 'house') {
      add('#6D4C41', 14, line([500, 1000, 500, 600, 1100, 600, 1100, 1000, 500, 1000], 10));
      add('#E53935', 14, line([440, 620, 800, 300, 1160, 620], 12));
      add('#1E88E5', 12, line([720, 1000, 720, 800, 880, 800, 880, 1000], 6));
    } else if (kind === 'face') {
      add('#222222', 14, ellipse(800, 600, 330, 360, 48));
      add('#222222', 22, ellipse(680, 520, 20, 20, 10));
      add('#222222', 22, ellipse(920, 520, 20, 20, 10));
      const sm = [];
      for (let i = 0; i <= 16; i++) { const t = Math.PI * (0.15 + 0.7 * (i / 16)); sm.push(800 + Math.cos(t) * 170, 640 + Math.sin(t) * 140); }
      add('#E53935', 14, jitter(sm, 4));
    } else if (kind === 'flower') {
      add('#43A047', 16, line([800, 640, 800, 1120], 12));
      for (let i = 0; i < 6; i++) { const t = (i / 6) * Math.PI * 2; add('#EC407A', 12, ellipse(800 + Math.cos(t) * 120, 480 + Math.sin(t) * 120, 80, 80, 20)); }
      add('#FDD835', 20, ellipse(800, 480, 60, 60, 16));
    } else {
      add('#6D4C41', 18, line([740, 1100, 740, 760, 860, 760, 860, 1100], 10));
      add('#43A047', 16, ellipse(800, 560, 280, 240, 44));
      add('#E53935', 22, ellipse(720, 520, 18, 18, 8));
      add('#E53935', 22, ellipse(900, 600, 18, 18, 8));
    }
    return S2;
  }
  function botDraw(r) {
    const strokes = doodle();
    const base = 'bt' + HCM.uid(3);
    let si = 0, pi = 0;
    const step = () => {
      if (S.round !== r || r.phase !== 'draw') return;
      if (r.paused) { botLater(step, 400); return; }
      if (si >= strokes.length) return;
      const s = strokes[si];
      const id = base + si;
      const CH = 6;
      if (pi === 0) {
        const pts = s.p.slice(0, CH * 2);
        applyAndRelay([['s', { id, c: s.c, w: s.w, e: 0, p: pts }]], r.drawer);
        pi = pts.length / 2;
      } else {
        const pts = s.p.slice(pi * 2, (pi + CH) * 2);
        applyAndRelay([['p', id, pts]], r.drawer);
        pi += pts.length / 2;
      }
      if (pi * 2 >= s.p.length) { si++; pi = 0; }
      botLater(step, pi === 0 ? 350 : 70);
    };
    botLater(step, 900);
  }

  /* ================= 화면 그리기 ================= */
  function renderSoon() {
    if (R.renderQueued) return;
    R.renderQueued = true;
    requestAnimationFrame(() => { R.renderQueued = false; renderAll(); });
  }
  function renderAll() {
    $('#roomCode').textContent = S.room;
    renderStage();
    renderCtl();
    renderPlayers();
    if (!$('#mRank').hidden) renderRank();
    if (!$('#mJoin').hidden) renderJoin();
  }
  function renderNet() {
    const el = $('#netPill');
    const map = {
      connecting: ['wait', '연결 준비 중…'],
      online: ['ok', '학생 입장 가능'],
      reconnecting: ['wait', '중계 서버 다시 연결 중…'],
      idtaken: ['bad', '이 방 번호가 다른 창에서 열려 있어요'],
      unsupported: ['bad', '이 브라우저는 지원하지 않아요 (크롬 권장)'],
      error: ['bad', '연결 오류 — 다시 시도 중']
    };
    const [cls, txt] = map[R.net] || map.connecting;
    el.className = 'net ' + cls;
    el.lastElementChild.textContent = txt;
    el.title = R.net === 'reconnecting' ? '이미 들어와 있는 학생들은 계속 연결돼 있어요. 새로 들어오는 학생만 잠깐 기다려요.' : '';
  }
  function renderTimer() {
    const r = S.round;
    const el = $('#siTimer');
    let txt = '--';
    let cls = '';
    if (r && (r.phase === 'draw' || r.phase === 'pick')) {
      const s = Math.ceil(remainMs(r) / 1000);
      txt = fmtTime(s);
      if (r.phase === 'draw' && s <= 10) cls = 'warn';
      if (r.paused) cls = 'paused';
    } else if (r && r.phase === 'result') txt = '끝';
    el.className = 'si-timer ' + cls;
    el.firstElementChild.textContent = txt;
  }
  function renderStage() {
    const r = S.round;
    const d = r && P(r.drawer);
    $('#siRound').textContent = r ? `${r.no}라운드` : '준비';
    $('#siDrawer').innerHTML = r ? `🎨 출제자 <b>${esc(d ? d.name : '?')}</b>` : '<span class="muted">학생들이 들어오면 시작해요</span>';
    let hint = '';
    if (r && R.peek && r.word && r.phase !== 'result') hint = `<span class="hint-peek">${esc(HCM.mainWord(r.word))}</span>`;
    else if (r && r.phase === 'draw') {
      const h = hintFor(r);
      if (h) hint = `<span class="hint-t">${esc(h.t)}</span><span class="hint-n">${h.n}글자</span>`;
      if (S.settings.answerMode === 'instant' && r.order.length) hint += `<span class="hint-ok">⭐ ${r.order.length}명 정답</span>`;
    } else if (r && r.phase === 'pick') hint = '<span class="hint-wait">출제자가 단어를 고르는 중…</span>';
    else if (r && r.phase === 'result' && !(r.res && r.res.canceled)) hint = `<span class="hint-ans">정답 <b>${esc(HCM.mainWord(r.word))}</b></span>`;
    $('#siHint').innerHTML = hint;
    renderTimer();
    $('#pauseOv').hidden = !(r && r.phase === 'draw' && r.paused);
    $('#drawerOff').hidden = !(r && (r.phase === 'draw' || r.phase === 'pick') && d && !d.online);
    $('#lobbyOv').hidden = !!r;
    $('#boardWrap').classList.toggle('lobby-on', !r);
    if (!r) renderLobby();
    const ro = $('#resultOv');
    if (r && r.phase === 'result') { ro.hidden = false; renderResult(); }
    else { ro.hidden = true; ro.dataset.key = ''; }
  }
  function studentUrl() {
    const u = new URL('student.html', location.href);
    return u.origin + u.pathname + '?room=' + S.room + HCM.extraQuery();
  }
  function qrSvg(text) {
    try { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }
    catch (e) { return ''; }
  }
  function renderLobby() {
    const ov = $('#lobbyOv');
    const url = studentUrl();
    const on = players().filter(p => p.online).length;
    const key = url + '|' + on + '|' + players().length;
    if (ov.dataset.key === key) return;
    ov.dataset.key = key;
    ov.innerHTML = `<div class="lobby">
      <div class="qr">${qrSvg(url)}</div>
      <div class="lobby-info">
        <h1>그림 퀴즈, 입장하세요!</h1>
        <p class="lb-step">📷 태블릿 카메라로 QR을 찍어요</p>
        <p class="lb-code">방 번호 <b>${esc(S.room)}</b></p>
        <p class="lb-url">${esc(url.replace(/^https?:\/\//, ''))}</p>
        <p class="lb-count">지금 <b>${on}</b>명 들어왔어요</p>
        <p class="lb-tip">모두 들어오면 오른쪽 <b>▶ 라운드 시작</b>을 눌러요</p>
      </div></div>`;
  }
  function renderResult() {
    const r = S.round;
    const ov = $('#resultOv');
    const key = String(S.sv);
    if (ov.dataset.key === key) return;
    ov.dataset.key = key;
    const res = r.res || { correct: [], parts: 0, award: {} };
    if (res.canceled) {
      ov.innerHTML = '<div class="res-panel"><div class="res-head"><span class="res-word small">이번 문제는 취소했어요</span></div><p class="res-rule">점수는 바뀌지 않아요. 다음 문제를 준비해 주세요.</p></div>';
      return;
    }
    const d = P(r.drawer);
    const pct = res.parts ? Math.round((res.correct.length / res.parts) * 100) : 0;
    let rule = '';
    if (res.rule === 'third') {
      if (res.mode === 'good') rule = `맞힌 학생이 1/3보다 많아요! 정답자와 출제자 <b>${esc(d ? d.name : '')}</b> 모두 <b>+10점</b>`;
      else if (res.mode === 'hard') rule = '맞힌 학생이 1/3 이하예요. 출제자를 뺀 모두 <b>+10점</b>';
    } else {
      rule = `정답자 <b>+10점</b> (빨리 맞힌 1·2·3등 +5·+3·+1) · 출제자 <b>+${res.award[r.drawer] || 0}점</b>`;
    }
    const groups = new Map();
    for (const pid of r.participants) {
      if (pid === r.drawer || !P(pid)) continue;
      const a = r.answers[pid];
      const k = a ? HCM.norm(a.text) : '';
      if (!groups.has(k)) groups.set(k, { text: a ? a.text : '', norm: k, pids: [], ok: !!a && judge(r, pid), none: !a, acc: a ? a.acc : undefined });
      groups.get(k).pids.push(pid);
    }
    const arr = Array.from(groups.values()).sort((a, b) => (b.ok - a.ok) || (a.none - b.none) || (b.pids.length - a.pids.length));
    const html = arr.map(g => {
      if (g.none) return `<div class="ag none"><span class="ag-t">답 안 냄</span><span class="ag-n">${g.pids.length}명</span></div>`;
      const names = g.ok ? `<div class="ag-names">${g.pids.map(pid => esc(P(pid).name)).join(', ')}</div>` : '';
      const btn = g.ok
        ? `<button class="btn xs ghost" data-acc="0" data-norm="${esc(g.norm)}">정답 취소</button>`
        : `<button class="btn xs" data-acc="1" data-norm="${esc(g.norm)}">정답 인정</button>`;
      return `<div class="ag ${g.ok ? 'ok' : ''}"><span class="ag-t">${g.ok ? '⭕' : '❌'} ${esc(g.text)}</span><span class="ag-n">${g.pids.length}명</span>${btn}${names}</div>`;
    }).join('');
    ov.innerHTML = `<div class="res-panel">
      <div class="res-head"><span class="res-label">정답</span><span class="res-word">${esc(HCM.mainWord(r.word))}</span></div>
      <div class="res-stats">
        <div class="stat"><b>${res.correct.length}</b><span>맞힌 학생</span></div>
        <div class="stat"><b>${res.parts}</b><span>참여</span></div>
        <div class="stat"><b>${pct}%</b><span>정답률</span></div>
      </div>
      <p class="res-rule">${rule}</p>
      <div class="ag-list">${html || '<p class="empty">제출한 답이 없어요.</p>'}</div>
    </div>`;
  }
  function renderCtl() {
    const r = S.round;
    const set = S.settings;
    const live = !!r && (r.phase === 'draw' || r.phase === 'pick');
    $('#ctlSetup').hidden = live;
    $('#ctlLive').hidden = !live;
    $('#autoPill').hidden = !set.auto;
    $('#fldWord').hidden = set.wordMode === 'drawer';
    $('#noteDrawerPick').hidden = set.wordMode !== 'drawer';
    $$('#segTime button').forEach(b => b.classList.toggle('on', +b.dataset.t === set.time));
    renderDrawerSelect();
    $('#btnStart').textContent = r ? '▶ 다음 라운드 시작' : '▶ 라운드 시작';
    if (live) {
      const d = P(r.drawer);
      const c = counts(r);
      $('#lvTitle').innerHTML = `${r.no}라운드 · 🎨 ${esc(d ? d.name : '?')}`;
      if (r.phase === 'pick') $('#lvCount').textContent = '출제자가 단어를 고르고 있어요';
      else if (set.answerMode === 'instant') $('#lvCount').innerHTML = `정답 <b>${c.cor}</b> / ${c.elig}명 <small>(낸 답 ${c.sub}명)</small>`;
      else $('#lvCount').innerHTML = `제출 <b>${c.sub}</b> / ${c.elig}명`;
      const ratio = c.elig ? (set.answerMode === 'instant' ? c.cor : c.sub) / c.elig : 0;
      $('#lvBar').style.width = Math.round(ratio * 100) + '%';
      $('#lvBar').classList.toggle('full', ratio >= 1);
      $('#btnPause').textContent = r.paused ? '▶️ 계속' : '⏸️ 멈춤';
      $('#btnPause').disabled = $('#btnAdd').disabled = r.phase !== 'draw';
    }
    renderAutoCount();
  }
  function renderAutoCount() {
    const el = $('#autoCount');
    const r = S.round;
    if (R.nextAt && r && r.phase === 'result') {
      el.hidden = false;
      const s = Math.max(0, Math.ceil((R.nextAt - now()) / 1000));
      el.innerHTML = `⏱ <b>${s}</b>초 뒤 다음 라운드 <button class="btn xs ghost" id="btnAutoStop">이번만 멈추기</button>`;
    } else el.hidden = true;
  }
  function renderDrawerSelect() {
    const sel = $('#selDrawer');
    const want = R.nextDrawer || sel.value || '';
    const online = players().filter(p => p.online).sort((a, b) => (a.drawn || 0) - (b.drawn || 0) || a.name.localeCompare(b.name, 'ko'));
    const html = ['<option value="">🎲 자동 (덜 그린 학생 중에서)</option>']
      .concat(online.map(p => `<option value="${p.pid}">${esc(p.name)}${p.drawn ? ` (${p.drawn}번 그림)` : ''}</option>`)).join('');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    sel.value = online.some(p => p.pid === want) ? want : '';
  }
  function renderPlayers() {
    const r = S.round;
    const live = r && r.phase === 'draw';
    const instant = S.settings.answerMode === 'instant';
    const list = players().slice().sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name, 'ko'));
    $('#players').innerHTML = list.map(p => {
      const isD = r && r.drawer === p.pid && r.phase !== 'result';
      const a = live && r.answers[p.pid];
      let mark = '';
      if (isD) mark = '<span class="pm">🎨</span>';
      else if (a) mark = instant ? (a.ok ? '<span class="pm">⭐</span>' : '<span class="pm dim">…</span>') : '<span class="pm sub">✓</span>';
      const cls = ['pchip', p.online ? 'on' : 'off', isD ? 'drawer' : '', a ? 'answered' : '', a && instant && a.ok ? 'correct' : ''].join(' ');
      return `<button class="${cls}" data-pid="${p.pid}"><i class="dot"></i><span class="pn">${esc(p.name)}${p.bot ? ' 🤖' : ''}</span>${mark}<span class="ps">${p.score}</span></button>`;
    }).join('') || '<p class="empty">아직 들어온 학생이 없어요.<br>위쪽 <b>방 번호</b>를 누르면 QR이 크게 떠요.</p>';
    const on = list.filter(p => p.online).length;
    $('#pCount').textContent = `${on}명 접속` + (list.length > on ? ` / ${list.length}명` : '');
  }
  function renderRank() {
    const list = ranked();
    const pod = list.slice(0, 3);
    $('#podium').innerHTML = [1, 0, 2].map(i => pod[i]
      ? `<div class="pod p${i + 1}"><div class="pod-medal">${['🥇', '🥈', '🥉'][i]}</div><div class="pod-name">${esc(pod[i].name)}</div><div class="pod-score">${pod[i].score}점</div><div class="pod-block">${i + 1}</div></div>`
      : '<div class="pod none"></div>').join('');
    $('#rankList').innerHTML = list.map(p => `<li><span class="rk">${rankOf(p.pid)}</span><span class="rn">${esc(p.name)}${p.bot ? ' 🤖' : ''}</span><span class="rs">${p.score}점</span></li>`).join('') || '<p class="empty">아직 점수가 없어요.</p>';
  }
  function renderJoin() {
    const url = studentUrl();
    if ($('#qrBig').dataset.url !== url) { $('#qrBig').innerHTML = qrSvg(url); $('#qrBig').dataset.url = url; }
    $('#joinCode').textContent = S.room;
    $('#joinUrl').textContent = url;
  }
  function flash(msg) {
    const el = $('#flash');
    el.textContent = msg;
    el.hidden = false;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    clearTimeout(R.flashTimer);
    R.flashTimer = setTimeout(() => { el.hidden = true; }, 1800);
  }

  /* ---------- 창(모달) ---------- */
  function openModal(id) { $('#' + id).hidden = false; }
  function closeModal(id) { $('#' + id).hidden = true; }
  $$('.modal').forEach(m => m.addEventListener('click', e => {
    if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
  }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal').forEach(m => { m.hidden = true; }); });

  /* ---------- 설정 ---------- */
  function countWords(c) { return c === CUSTOM_CAT ? splitWords(S.settings.customWords).length : splitWords(WORDS[c]).length; }
  function setSetting(k, v) {
    const r = S.round;
    const live = r && (r.phase === 'draw' || r.phase === 'pick');
    if (live && (k === 'answerMode' || k === 'scoring' || k === 'wordMode')) {
      HCM.toast('진행 중인 라운드가 끝난 뒤에 바꿀 수 있어요.', 'warn');
      return;
    }
    S.settings[k] = v;
    if (k === 'sound') HCM.sfx.enabled = v;
    if (k === 'auto') R.nextAt = v && r && r.phase === 'result' && !(r.res && r.res.canceled) ? now() + S.settings.autoGap * 1000 : 0;
    syncSettingsUI();
    bump(true);
  }
  function syncSettingsUI() {
    $$('#mSettings .seg[data-key]').forEach(seg => {
      const v = String(S.settings[seg.dataset.key]);
      $$('button', seg).forEach(b => b.classList.toggle('on', b.dataset.v === v));
    });
    $$('#catBox input').forEach(i => { i.checked = S.settings.cats.includes(i.value); });
    if (document.activeElement !== $('#taCustom')) $('#taCustom').value = S.settings.customWords;
    if (document.activeElement !== $('#taRoster')) $('#taRoster').value = S.settings.roster;
    $$('#catBox .cat small').forEach(sm => { sm.textContent = countWords(sm.dataset.cat); });
    $('#scoringHelp').innerHTML = S.settings.scoring === 'third'
      ? '맞힌 학생이 <b>1/3보다 많으면</b> 정답자와 출제자가 +10점, <b>1/3 이하면</b> 출제자를 뺀 모두가 +10점 (참고한 앱과 같은 규칙)'
      : '맞히면 +10점, 빨리 맞힌 1·2·3등은 +5·+3·+1 더. 출제자는 맞힌 학생 1명당 +2점 (최대 +10점)';
  }
  function buildSettings() {
    $('#catBox').innerHTML = CAT_LIST.map(c => `<label class="cat"><input type="checkbox" value="${esc(c)}"><span>${esc(c)} <small data-cat="${esc(c)}"></small></span></label>`).join('');
    $$('#mSettings .seg[data-key]').forEach(seg => seg.addEventListener('click', e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      let v = b.dataset.v;
      if (v === 'true') v = true; else if (v === 'false') v = false;
      setSetting(seg.dataset.key, v);
    }));
    $('#catBox').addEventListener('change', () => {
      const cats = $$('#catBox input:checked').map(i => i.value);
      if (!cats.length) { HCM.toast('주제를 하나 이상 골라 주세요.', 'warn'); syncSettingsUI(); return; }
      S.settings.cats = cats;
      markDirty();
    });
    $('#taCustom').addEventListener('input', debounce(() => { S.settings.customWords = $('#taCustom').value; markDirty(); syncSettingsUI(); }, 400));
    $('#taRoster').addEventListener('input', debounce(() => { S.settings.roster = $('#taRoster').value; markDirty(); }, 400));
    $('#btnBots').addEventListener('click', () => addBots(3));
    $('#btnBotsOff').addEventListener('click', removeBots);
    $('#btnCsv').addEventListener('click', exportCsv);
    $('#btnResetScore').addEventListener('click', () => { if (confirm('모든 학생의 점수와 라운드 기록을 0으로 돌릴까요?')) { resetScores(); closeModal('mSettings'); } });
    $('#btnNewRoom').addEventListener('click', () => { if (confirm('새 방 번호로 바꾸고 점수를 모두 지울까요?\n(들어와 있던 학생 태블릿은 새 방으로 자동으로 옮겨 와요)')) { newRoom(); closeModal('mSettings'); } });
    $('#verInfo').textContent = `버전 ${HCM.VERSION}`;
  }
  function exportCsv() {
    const rows = [['순위', '이름', '점수', '그린 횟수']];
    ranked().forEach(p => rows.push([rankOf(p.pid), p.name, p.score, p.drawn || 0]));
    rows.push([]);
    rows.push(['라운드', '제시어', '출제자', '맞힌 학생', '참여', '정답률']);
    S.history.forEach(h => rows.push([h.no, h.word, h.drawer, h.canceled ? '취소' : h.correct, h.parts, h.parts && !h.canceled ? Math.round((h.correct / h.parts) * 100) + '%' : '']));
    const csv = '﻿' + rows.map(row => row.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `hatban-quiz-${new Date().toISOString().slice(0, 10)}.csv`; // 일부 환경에서 한글 파일 이름이 깨져 영문으로
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  /* ---------- 버튼 연결 ---------- */
  function setMasked(on) { $('#inWord').classList.toggle('masked', on); $('#btnPeek').classList.toggle('on', !on); }
  function bindUI() {
    document.addEventListener('pointerdown', () => HCM.sfx.unlock(), { once: true });
    $('#btnJoin').addEventListener('click', () => { renderJoin(); openModal('mJoin'); });
    $('#btnCopy').addEventListener('click', () => {
      const url = studentUrl();
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => HCM.toast('주소를 복사했어요.'), () => HCM.toast(url));
    });
    $('#btnRank').addEventListener('click', () => { renderRank(); openModal('mRank'); HCM.sfx.play('fanfare'); });
    $('#btnSettings').addEventListener('click', () => { syncSettingsUI(); openModal('mSettings'); });
    $('#btnFull').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen().catch(() => {});
    });
    $('#btnPeek').addEventListener('click', () => setMasked(!$('#inWord').classList.contains('masked')));
    $('#btnRandWord').addEventListener('click', () => {
      $('#inWord').value = HCM.mainWord(pickWords(1)[0] || '');
      setMasked(true);
      HCM.toast('제시어를 골라 두었어요. 👁 를 누르면 보여요.');
    });
    $('#inWord').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#btnStart').click(); } });
    $('#btnRandDrawer').addEventListener('click', () => {
      const pid = autoDrawer();
      if (!pid) { HCM.toast('접속한 학생이 없어요.', 'warn'); return; }
      R.nextDrawer = pid;
      renderDrawerSelect();
      HCM.toast(`🎨 다음 출제자: ${P(pid).name}`);
    });
    $('#selDrawer').addEventListener('change', () => { R.nextDrawer = $('#selDrawer').value; });
    $('#segTime').addEventListener('click', e => {
      const b = e.target.closest('button[data-t]');
      if (!b) return;
      S.settings.time = +b.dataset.t;
      markDirty();
      renderCtl();
    });
    $('#btnStart').addEventListener('click', () => {
      const word = S.settings.wordMode === 'drawer' ? '' : $('#inWord').value.trim();
      const drawer = $('#selDrawer').value || '';
      if (startRound({ word, drawer, time: S.settings.time })) {
        $('#inWord').value = '';
        R.nextDrawer = '';
        $('#selDrawer').value = '';
        setMasked(true);
      }
    });
    $('#btnPause').addEventListener('click', togglePause);
    $('#btnAdd').addEventListener('click', () => addTime(30));
    $('#btnClose').addEventListener('click', () => closeRound('teacher'));
    $('#btnCancel').addEventListener('click', () => { if (confirm('이번 문제를 점수 없이 취소할까요?')) closeRound('cancel'); });
    const peekOn = e => { e.preventDefault(); R.peek = true; renderStage(); };
    const peekOff = () => { if (!R.peek) return; R.peek = false; renderStage(); };
    $('#btnPeekLive').addEventListener('pointerdown', peekOn);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => $('#btnPeekLive').addEventListener(ev, peekOff));
    $('#resultOv').addEventListener('click', e => {
      const b = e.target.closest('[data-acc]');
      if (b) setAccept(b.dataset.norm, b.dataset.acc === '1');
    });
    $('#autoCount').addEventListener('click', e => { if (e.target.id === 'btnAutoStop') { R.nextAt = 0; renderAutoCount(); } });
    $('#players').addEventListener('click', e => { const b = e.target.closest('.pchip'); if (b) openPlayer(b.dataset.pid); });
    $('#mPlayer').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const p = P(R.mp);
      if (!p) { closeModal('mPlayer'); return; }
      switch (b.dataset.act) {
        case 'drawer':
          if (!p.online) { HCM.toast('지금 연결이 끊긴 학생이에요.', 'warn'); return; }
          R.nextDrawer = p.pid; renderDrawerSelect(); HCM.toast(`🎨 다음 출제자: ${p.name}`); closeModal('mPlayer'); break;
        case 'plus': p.score += 5; bump(); openPlayer(p.pid); break;
        case 'minus': p.score -= 5; bump(); openPlayer(p.pid); break;
        case 'release': releaseDevice(p.pid); closeModal('mPlayer'); break;
        case 'kick': if (confirm(`${p.name} 학생을 방에서 내보낼까요?`)) { kick(p.pid); closeModal('mPlayer'); } break;
      }
    });
    // 새로고침·창 닫기 직전: 태블릿들에게 "곧 돌아와요"를 알려 바로 다시 붙게 함
    window.addEventListener('pagehide', () => { save(); relay({ type: 'bye' }); });
    window.addEventListener('beforeunload', e => {
      save();
      const r = S.round;
      if (r && (r.phase === 'draw' || r.phase === 'pick') && !HCM.qs.get('test')) { e.preventDefault(); e.returnValue = ''; }
    });
  }
  function openPlayer(pid) {
    const p = P(pid);
    if (!p) return;
    R.mp = pid;
    $('#mpName').textContent = p.name + (p.bot ? ' 🤖' : '');
    $('#mpInfo').innerHTML = `${p.online ? '🟢 접속 중' : '⚪ 연결 끊김'} · <b>${p.score}점</b> · ${p.drawn || 0}번 그림`;
    openModal('mPlayer');
  }

  /* ================= 시작 ================= */
  function init() {
    R.board = new HCM.Board($('#board'));
    if (S.round) {
      R.board.setStrokes(S.round.strokes);
      if (S.round.phase === 'result' && S.settings.auto && !(S.round.res && S.round.res.canceled)) R.nextAt = now() + S.settings.autoGap * 1000;
    }
    HCM.sfx.enabled = S.settings.sound;
    buildSettings();
    syncSettingsUI();
    bindUI();
    renderNet();
    renderAll();
    startPeer();
    HCM.ticker(250, tick);
    HCM.keepAwake();
    save();
    // 시험용 창구 (자동 테스트에서만 씁니다)
    window.__hcm = { get S() { return S; }, R, startRound, closeRound, addBots, removeBots, setAccept, setSetting, togglePause, kick, newRoom };
  }
  init();
})();
