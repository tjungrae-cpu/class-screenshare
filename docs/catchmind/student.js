/* 햇반 그림퀴즈 — 학생(태블릿) 화면
   선생님 화면에 직접 연결하고, 끊기면 스스로 다시 연결해 그림·답·점수를 이어 받습니다. */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = HCM.esc;
  const now = () => Date.now();
  const K = { token: 'hcm.token', name: 'hcm.name', room: 'hcm.room', snd: 'hcm.snd' };
  const COLORS = ['#222222', '#E53935', '#FB8C00', '#FDD835', '#43A047', '#1E88E5', '#8E24AA', '#6D4C41', '#EC407A', '#9E9E9E'];
  const SIZES = [6, 14, 28, 52];
  const BACKOFF = [300, 700, 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000];

  let token = HCM.store.get(K.token);
  if (!token || !/^[a-z0-9]{8,40}$/.test(token)) { token = HCM.uid(16); HCM.store.set(K.token, token); }
  const qsRoom = (HCM.qs.get('room') || '').replace(/\D/g, '').slice(0, 4);
  if (qsRoom.length === 4) HCM.store.set(K.room, qsRoom);

  const C = {
    room: qsRoom.length === 4 ? qsRoom : (HCM.store.get(K.room) || ''),
    name: HCM.store.get(K.name) || '', token,
    pid: null, welcomed: false, everWelcomed: false, needName: null, nameErr: '',
    kicked: false, stopped: false, fatal: '', st: null, sv: 0, rno: 0,
    localEnd: 0, pausedMs: 0, ansPending: null, skMiss: 0, lastStReq: 0, justWelcomed: false,
    autoJoinTried: false, needSync: false, syncing: false, hostMissing: 0, resultShown: 0, fbT: null
  };
  const N = { peer: null, conn: null, connecting: false, attempt: 0, timer: null, lastRx: 0, status: 'idle', peerWait: null, attemptFail: null, lastKa: 0, lastSigTry: 0 };

  HCM.sfx.enabled = HCM.store.get(K.snd) !== '0';
  const board = new HCM.Board($('#board'), { onOps: sendOps });

  /* ================= 연결 ================= */
  function setStatus(s) { N.status = s; renderNet(); }
  function sendMsg(obj) {
    if (!N.conn || !N.conn.open || !C.welcomed) return false;
    return HCM.send(N.conn, obj);
  }
  function ensurePeer() {
    return new Promise((resolve, reject) => {
      let p = N.peer;
      if (p && !p.destroyed && p.open) { resolve(p); return; }
      let done = false;
      const onOpen = () => finish(true);
      const finish = (ok, err) => {
        if (done) return;
        done = true;
        clearTimeout(to);
        N.peerWait = null;
        if (p) { try { p.off('open', onOpen); } catch (e) { /* 무시 */ } }
        if (ok) resolve(p); else reject(err || new Error('peer-fail'));
      };
      const to = setTimeout(() => {
        finish(false, new Error('peer-timeout'));
        if (N.peer === p) { try { p.destroy(); } catch (e) { /* 무시 */ } N.peer = null; }
      }, 10000);
      N.peerWait = finish;
      if (p && !p.destroyed) {
        p.on('open', onOpen);
        if (p.disconnected) { try { p.reconnect(); } catch (e) { finish(false, e); } }
        return;
      }
      try { p = new Peer(HCM.peerOptions()); } catch (e) { finish(false, e); return; }
      N.peer = p;
      p.on('open', onOpen);
      p.on('error', err => onPeerError(p, err));
      p.on('close', () => { if (N.peer === p) N.peer = null; });
    });
  }
  function onPeerError(p, err) {
    if (p !== N.peer) return;
    const t = err && err.type;
    if (t === 'peer-unavailable') {
      C.hostMissing++;
      if (N.attemptFail) N.attemptFail('host-missing');
      renderConnect();
      return;
    }
    if (t === 'browser-incompatible') {
      C.fatal = '이 브라우저에서는 실시간 연결을 쓸 수 없어요. 크롬이나 삼성 인터넷으로 열어 주세요.';
      C.stopped = true;
      render();
      return;
    }
    if (N.peerWait) N.peerWait(false, err);
    if (N.attemptFail) N.attemptFail(t || 'peer-error');
  }
  async function connect() {
    clearTimeout(N.timer);
    N.timer = null;
    if (C.stopped || C.kicked || C.room.length !== 4) return;
    if (N.connecting || (N.conn && N.conn.open)) return;
    N.connecting = true;
    setStatus(N.attempt ? 'retry' : 'connecting');
    let conn = null;
    try {
      const p = await ensurePeer();
      conn = p.connect(HCM.hostId(C.room), { reliable: true, serialization: 'raw' });
      if (!conn) throw new Error('no-conn');
      await new Promise((resolve, reject) => {
        let done = false;
        const fin = (ok, e) => {
          if (done) return;
          done = true;
          clearTimeout(to);
          N.attemptFail = null;
          if (ok) resolve(); else reject(e || new Error('fail'));
        };
        const to = setTimeout(() => fin(false, new Error('open-timeout')), 9000);
        N.attemptFail = reason => fin(false, new Error(reason));
        conn.on('open', () => fin(true));
        conn.on('error', e => fin(false, e));
        conn.on('close', () => fin(false, new Error('closed')));
      });
      if (C.stopped || C.kicked) { try { conn.close(); } catch (e) { /* 무시 */ } return; }
      N.conn = conn;
      N.lastRx = now();
      N.iceDisc = 0;
      C.hostMissing = 0;
      conn.on('data', raw => onData(conn, raw));
      conn.on('close', () => onConnLost(conn));
      conn.on('error', () => onConnLost(conn));
      conn.on('iceStateChanged', s => {
        if (conn !== N.conn) return;
        if (s === 'disconnected') N.iceDisc = now();
        else if (s === 'connected' || s === 'completed') N.iceDisc = 0;
      });
      HCM.send(conn, { type: 'hello', proto: HCM.PROTO, token: C.token, name: C.name || null });
      setStatus('handshake');
    } catch (e) {
      if (conn) { try { conn.close(); } catch (_) { /* 무시 */ } }
      scheduleRetry();
    } finally {
      N.connecting = false;
      render();
    }
  }
  function onConnLost(conn) {
    if (conn !== N.conn) return;
    N.conn = null;
    C.welcomed = false;
    scheduleRetry(250);
    render();
  }
  function scheduleRetry(delay) {
    if (C.stopped || C.kicked) return;
    clearTimeout(N.timer);
    const d = delay != null ? delay : BACKOFF[Math.min(N.attempt, BACKOFF.length - 1)] + Math.random() * 400;
    N.attempt++;
    setStatus('retry');
    N.timer = setTimeout(connect, d);
  }
  function reconnectNow() {
    if (C.stopped || C.kicked) return;
    if (N.conn) {
      const c = N.conn;
      N.conn = null;
      C.welcomed = false;
      try { c.close(); } catch (e) { /* 무시 */ }
    }
    N.attempt = 0;
    scheduleRetry(30);
    render();
  }

  // 연결 감시: 선생님 화면에서 2초마다 오는 신호가 끊기면 바로 다시 연결
  setInterval(() => {
    const t = now();
    if (N.conn && N.conn.open) {
      // 신호가 7초 끊기면 다시 연결 (연결 상태가 '끊김'으로 바뀌었으면 3.5초)
      if (C.welcomed) { if (t - N.lastRx > (N.iceDisc ? 3500 : 7000)) reconnectNow(); }
      else {
        if (t - N.lastKa > 4000) { N.lastKa = t; HCM.send(N.conn, { type: 'ka' }); }
        if (t - N.lastRx > 15000) reconnectNow();
      }
    }
    if (N.peer && !N.peer.destroyed && N.peer.disconnected && !N.connecting && t - N.lastSigTry > 5000) {
      N.lastSigTry = t;
      try { N.peer.reconnect(); } catch (e) { /* 무시 */ }
    }
  }, 1000);
  setInterval(renderTimer, 250);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!N.conn || !N.conn.open || now() - N.lastRx > 3500) reconnectNow();
  });
  window.addEventListener('online', () => { if (!N.conn) reconnectNow(); });
  window.addEventListener('offline', () => renderNet());
  window.addEventListener('pageshow', e => { if (e.persisted) reconnectNow(); });
  window.addEventListener('pagehide', () => { sendMsg({ type: 'bye' }); });

  /* ================= 받은 메시지 ================= */
  function onData(conn, raw) {
    if (conn !== N.conn) return;
    N.lastRx = now();
    const m = HCM.parse(raw);
    if (!m || typeof m.type !== 'string') return;
    try {
      switch (m.type) {
        case 'ping': onPing(m); break;
        case 'ka': break;
        case 'need_name': onNeedName(m); break;
        case 'reject': onReject(m); break;
        case 'welcome': onWelcome(m); break;
        case 'st': onState(m); break;
        case 'ops': onOps(m); break;
        case 'cnt': onCnt(m); break;
        case 'ack': onAck(m); break;
        case 'kick': onKick(); break;
        case 'moved': onMoved(m); break;
        case 'bye': onBye(); break;
      }
    } catch (e) { console.error(e); }
  }
  function onPing(m) {
    HCM.send(N.conn, { type: 'pong', t: m.t });
    if (!C.welcomed || !C.st) return;
    const st = C.st;
    const r = st.r;
    if (r && m.rno === r.no && (m.ph === 'draw' || m.ph === 'pick')) {
      if (m.paused) C.pausedMs = m.remain || 0;
      else C.localEnd = performance.now() + (m.remain || 0);
      if (!!m.paused !== !!r.paused) { r.paused = !!m.paused; render(); }
    }
    if (m.cnt && r && m.rno === r.no) { r.cnt = m.cnt; renderCnt(); }
    if (m.sv !== C.sv && now() - C.lastStReq > 2500) { C.lastStReq = now(); sendMsg({ type: 'need_st' }); }
    // 그림이 선생님 화면과 다르면 통째로 다시 받기
    if (m.sk && r && m.rno === r.no && C.rno === m.rno && r.drawer !== C.pid && !C.syncing) {
      const [a, b] = board.counts();
      if (a !== m.sk[0] || b !== m.sk[1]) {
        if (++C.skMiss >= 2) { C.skMiss = 0; C.syncing = true; sendMsg({ type: 'need_strokes' }); }
      } else C.skMiss = 0;
    }
  }
  function onNeedName(m) {
    C.needName = m;
    C.welcomed = false;
    setStatus('name');
    if (C.name && !C.autoJoinTried) {
      const free = !m.roster || m.roster.some(x => HCM.norm(x.n) === HCM.norm(C.name) && !x.t);
      if (free && !m.locked) { C.autoJoinTried = true; sendJoin(C.name); return; }
    }
    render();
  }
  function sendJoin(name) {
    const n = HCM.cleanName(name);
    if (!n) { C.nameErr = '이름을 써 주세요.'; render(); return; }
    C.nameErr = '';
    if (!HCM.send(N.conn, { type: 'join', token: C.token, name: n })) {
      C.nameErr = '연결이 끊겼어요. 잠시 뒤 다시 눌러 주세요.';
      reconnectNow();
    }
    render();
  }
  function onReject(m) {
    if (m.code === 'kicked') { onKick(); return; }
    if (m.code === 'version') { C.stopped = true; C.fatal = m.msg || '화면을 새로고침해 주세요.'; render(); return; }
    C.nameErr = m.msg || '들어갈 수 없어요.';
    if (!C.needName) C.needName = { roster: null };
    render();
  }
  function onWelcome(m) {
    C.pid = m.pid;
    C.name = m.name;
    C.welcomed = true;
    C.everWelcomed = true;
    C.needName = null;
    C.nameErr = '';
    C.autoJoinTried = false;
    HCM.store.set(K.name, m.name);
    HCM.store.set(K.room, C.room);
    N.attempt = 0;
    C.justWelcomed = true;
    setStatus('online');
    render();
  }
  function onState(st) {
    const prevNo = C.rno;
    const r = st.r;
    C.st = st;
    C.sv = st.sv;
    if (r) {
      if (r.no !== C.rno) {
        // 새 라운드: 그림판과 답 칸 비우기
        C.rno = r.no;
        board.dropPending();
        board.active = null;
        board.applyOps([['c']]);
        C.ansPending = null;
        C.needSync = false;
        C.syncing = false;
        C.skMiss = 0;
        $('#ansInput').value = '';
      }
      if (st.phase === 'draw' || st.phase === 'pick') {
        if (r.paused) C.pausedMs = r.remain || 0;
        else C.localEnd = performance.now() + (r.remain || 0);
      }
      const amDrawer = r.drawer === C.pid;
      if (amDrawer && st.phase === 'draw') {
        if (C.justWelcomed) {
          // 다시 연결된 출제자: 내 그림이 있으면 내 것을 보내고, 없으면(새로고침) 선생님 화면 것을 받기
          if (prevNo === r.no && board.strokes.length && !C.syncing) fullSync();
          else { C.syncing = true; sendMsg({ type: 'need_strokes' }); }
        } else if (C.needSync) fullSync();
      }
      if (C.ansPending && r.ans && r.ans.text === C.ansPending) C.ansPending = null;
      if (C.ansPending && st.phase === 'draw' && !amDrawer) sendMsg({ type: 'ans', rno: r.no, text: C.ansPending });
    }
    C.justWelcomed = false;
    render();
  }
  function fullSync() {
    const r = C.st && C.st.r;
    if (!r) return;
    C.needSync = false;
    board.dropPending();
    for (const ops of HCM.strokesToOps(board.strokes)) {
      if (!sendMsg({ type: 'ops', rno: r.no, ops })) { C.needSync = true; break; }
    }
  }
  function sendOps(ops) {
    const st = C.st;
    const r = st && st.r;
    if (!r || st.phase !== 'draw' || r.drawer !== C.pid) return;
    if (C.needSync) return; // 다시 연결되면 그림 전체를 한 번에 보냄
    if (!sendMsg({ type: 'ops', rno: r.no, ops })) C.needSync = true;
  }
  function onOps(m) {
    const st = C.st;
    if (!st || !st.r || m.rno !== C.rno) return;
    const amDrawer = st.r.drawer === C.pid && st.phase === 'draw';
    if (amDrawer && !m.snap) return;
    const ops = HCM.sanitizeOps(m.ops);
    if (ops) board.applyOps(ops);
    if (m.snap && m.last) { C.syncing = false; C.skMiss = 0; updateEditable(); }
  }
  function onCnt(m) {
    const r = C.st && C.st.r;
    if (r && m.rno === r.no) { r.cnt = m.cnt; renderCnt(); }
  }
  function onAck(m) {
    const st = C.st;
    if (!st || !st.r || m.rno !== st.r.no) return;
    if (C.ansPending === m.text) C.ansPending = null;
    st.r.ans = { text: m.text, ok: m.ok };
    if (st.mode === 'instant' && !m.wait) {
      if (m.ok) { HCM.sfx.play('correct'); showFb(true); $('#ansInput').blur(); }
      else { HCM.sfx.play('wrong'); showFb(false); try { $('#ansInput').select(); } catch (e) { /* 무시 */ } }
    }
    renderAnswerStatus();
    updateAnswerEnabled();
  }
  function onKick() {
    C.kicked = true;
    C.stopped = true;
    clearTimeout(N.timer);
    const c = N.conn;
    N.conn = null;
    try { if (c) c.close(); } catch (e) { /* 무시 */ }
    render();
  }
  // 선생님 화면이 새로고침되는 중: 바로 다시 붙을 준비
  function onBye() {
    const c = N.conn;
    N.conn = null;
    C.welcomed = false;
    try { if (c) c.close(); } catch (e) { /* 무시 */ }
    N.attempt = 0;
    scheduleRetry(700);
    render();
  }
  function onMoved(m) {
    const room = String(m.room || '').replace(/\D/g, '').slice(0, 4);
    if (room.length !== 4) return;
    C.room = room;
    HCM.store.set(K.room, room);
    C.st = null;
    C.rno = 0;
    C.autoJoinTried = false;
    board.applyOps([['c']]);
    const c = N.conn;
    N.conn = null;
    C.welcomed = false;
    try { if (c) c.close(); } catch (e) { /* 무시 */ }
    N.attempt = 0;
    scheduleRetry(1500);
    HCM.toast(`새 방(${room})으로 옮겨 가요`);
    render();
  }

  /* ================= 보내기 (답·단어 고르기) ================= */
  function submitAnswer() {
    const st = C.st;
    const r = st && st.r;
    if (!r || st.phase !== 'draw' || r.drawer === C.pid) return;
    const text = HCM.cleanAnswer($('#ansInput').value);
    if (!text) { $('#ansInput').focus(); return; }
    if (st.mode === 'instant' && r.ans && r.ans.ok) return;
    C.ansPending = text;
    sendMsg({ type: 'ans', rno: r.no, text });
    if (st.mode !== 'instant') $('#ansInput').blur();
    renderAnswerStatus();
  }

  /* ================= 화면 ================= */
  function show(id) {
    $$('.scr').forEach(el => el.classList.toggle('on', el.id === id));
    document.body.dataset.scr = id;
  }
  function render() {
    renderTop();
    renderNet();
    $('#offBanner').hidden = !(C.everWelcomed && !C.welcomed && !C.kicked && !C.stopped && !C.needName);
    if (C.fatal) { showMsg('잠깐만요!', C.fatal, true); return; }
    if (C.kicked) { showMsg('방에서 나왔어요', '선생님이 이 기기를 방에서 내보냈어요. 선생님께 말씀드려요.', false); return; }
    if (!C.welcomed && C.needName && N.conn) { renderName(); show('scrName'); return; }
    if (!C.everWelcomed) { renderConnect(); show('scrConnect'); return; }
    const st = C.st;
    const r = st && st.r;
    if (!st || !r || st.phase === 'lobby') { renderWait(); show('scrWait'); return; }
    if (st.phase === 'pick') {
      if (r.drawer === C.pid) { renderPick(); show('scrPick'); }
      else { renderWait('pick'); show('scrWait'); }
      return;
    }
    renderPlay();
    show('scrPlay');
  }
  function showMsg(title, sub, reload) {
    $('#msgTitle').textContent = title;
    $('#msgSub').textContent = sub;
    $('#btnMsgAction').hidden = !reload;
    show('scrMsg');
  }
  function renderTop() {
    const st = C.st;
    $('#meName').textContent = C.everWelcomed && C.name ? C.name : '햇반 그림퀴즈';
    $('#meScore').hidden = !st;
    if (st) $('#meScore').textContent = `${st.me.score}점`;
    $('#btnSnd').textContent = HCM.sfx.enabled ? '🔊' : '🔇';
    renderTimer();
  }
  function renderNet() {
    const el = $('#netPill');
    let cls = 'wait', txt = '연결 중…';
    if (C.kicked || C.stopped) { cls = 'bad'; txt = '연결 끝'; }
    else if (C.welcomed) { cls = 'ok'; txt = '연결됨'; }
    else if (C.needName && N.conn) { cls = 'ok'; txt = '입장 준비'; }
    else if (!navigator.onLine) { cls = 'bad'; txt = '인터넷 끊김'; }
    else if (N.status === 'retry') txt = C.everWelcomed ? '다시 연결 중…' : '방 찾는 중…';
    else if (N.status === 'handshake') txt = '입장 중…';
    el.className = 'net ' + cls;
    el.lastElementChild.textContent = txt;
  }
  function renderTimer() {
    const el = $('#sTimer');
    const st = C.st;
    const r = st && st.r;
    if (!r || !(st.phase === 'draw' || st.phase === 'pick')) { el.hidden = true; return; }
    el.hidden = false;
    const ms = r.paused ? C.pausedMs : Math.max(0, C.localEnd - performance.now());
    const s = Math.ceil(ms / 1000);
    el.firstElementChild.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('warn', st.phase === 'draw' && s <= 10 && !r.paused);
    if (st.phase === 'pick') $('#pickTime').textContent = `${s}초 안에 고르지 않으면 첫 번째 단어로 시작해요`;
  }
  function renderConnect() {
    const inp = $('#inRoom');
    if (document.activeElement !== inp && !inp.value && C.room) inp.value = C.room;
    let msg = '';
    const busy = !C.stopped && C.room.length === 4 && !N.conn;
    if (C.room.length !== 4) msg = '선생님 화면(TV)에 보이는 방 번호 4자리를 넣어요.';
    else if (C.hostMissing >= 2) msg = `${C.room}번 방을 찾는 중… 선생님 화면이 켜져 있는지, 방 번호가 맞는지 봐 주세요.`;
    else if (busy) msg = `${C.room}번 방에 연결하는 중…`;
    $('#connStatus').textContent = msg;
    $('#connStatus').classList.toggle('spin', busy);
  }
  function renderName() {
    const nn = C.needName || {};
    const grid = $('#rosterGrid');
    if (nn.roster && nn.roster.length) {
      grid.hidden = false;
      $('#nameForm').hidden = true;
      $('#nameTitle').textContent = '내 이름을 눌러요';
      grid.innerHTML = nn.roster.map(x => `<button class="rname ${x.t ? 'taken' : ''}" type="button" data-n="${esc(x.n)}" ${x.t ? 'disabled' : ''}>${esc(x.n)}${x.t ? '<small>들어와 있음</small>' : ''}</button>`).join('');
    } else {
      grid.hidden = true;
      $('#nameForm').hidden = false;
      $('#nameTitle').textContent = '내 이름을 알려 주세요';
      if (!$('#inName').value && C.name) $('#inName').value = C.name;
    }
    $('#nameErr').textContent = C.nameErr || (nn.locked ? '지금은 새로 들어올 수 없어요. 선생님께 말씀드려요.' : '');
  }
  function renderWait(kind) {
    const st = C.st;
    if (kind === 'pick') {
      $('#waitEmoji').textContent = '🎨';
      $('#waitTitle').textContent = `${st.r.dname} 친구가 그릴 단어를 고르는 중…`;
      $('#waitSub').textContent = '곧 그림이 시작돼요. 준비!';
    } else {
      $('#waitEmoji').textContent = '🍚';
      $('#waitTitle').textContent = st && st.r ? '선생님이 다음 문제를 준비하고 있어요' : '들어왔어요! 선생님이 곧 시작해요';
      $('#waitSub').textContent = '화면을 켜 둔 채로 기다려요';
    }
    if (st) {
      $('#myScore').innerHTML = `<b>${esc(st.me.name)}</b> · ${st.me.score}점 · ${st.me.rank}등 <small>/ ${st.me.n}명</small>`;
      $('#miniRank').innerHTML = (st.top || []).filter(x => x.s > 0).map((x, i) => `<li><span>${i + 1}</span>${esc(x.n)}<b>${x.s}</b></li>`).join('');
    } else {
      $('#myScore').innerHTML = '';
      $('#miniRank').innerHTML = '';
    }
  }
  function renderPick() {
    const r = C.st.r;
    const list = r.choices || [];
    const key = r.no + ':' + list.join(',');
    const box = $('#choices');
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = list.map((w, i) => `<button class="choice" type="button" data-i="${i}">${esc(w)}</button>`).join('');
    }
  }
  function hintHtml(h) {
    return h ? `<span class="hint"><span class="hint-t">${esc(h.t)}</span><small>${h.n}글자</small></span>` : '';
  }
  function renderPlay() {
    const st = C.st;
    const r = st.r;
    const amDrawer = r.drawer === C.pid;
    const result = st.phase === 'result';
    document.body.classList.toggle('drawing', amDrawer && !result);
    let h;
    if (result) h = r.res && r.res.canceled ? '<span class="tag">취소</span><span class="guess-t">이번 문제는 취소됐어요</span>' : `<span class="tag">정답</span><b class="word">${esc(r.word || '')}</b>`;
    else if (amDrawer) h = `<span class="tag hot">내가 그릴 단어</span><b class="word">${esc(r.word || '')}</b><span class="rule">말·글자·숫자 쓰기는 안 돼요!</span>`;
    else h = `<span class="tag">🎨 ${esc(r.dname)}</span><span class="guess-t">그림을 보고 맞혀요!</span>${hintHtml(r.hint)}`;
    if (!result && st.mode === 'instant' && r.okNames && r.okNames.length) h += `<span class="oknames">⭐ ${r.okNames.map(esc).join(', ')}</span>`;
    h += '<span class="cnt" id="cntBadge"></span>';
    const head = $('#playHead');
    if (head.dataset.h !== h) { head.innerHTML = h; head.dataset.h = h; }
    $('#tools').hidden = !(amDrawer && !result);
    $('#ansForm').hidden = amDrawer || result;
    $('#pausedOv').hidden = !(r.paused && !result);
    const ov = $('#resultOv');
    if (result) {
      const html = resultHtml(st);
      if (ov.dataset.h !== html) { ov.innerHTML = html; ov.dataset.h = html; }
      ov.hidden = false;
      if (C.resultShown !== r.no) { C.resultShown = r.no; playResultSound(st); }
    } else ov.hidden = true;
    updateEditable();
    updateAnswerEnabled();
    renderAnswerStatus();
    renderCnt();
  }
  function resultHtml(st) {
    const r = st.r;
    const res = r.res || {};
    if (res.canceled) return '<div class="res-card"><div class="res-big">🙅</div><h2>이번 문제는 취소됐어요</h2><p class="res-sum">점수는 그대로예요. 다음 문제를 기다려요.</p></div>';
    const amDrawer = r.drawer === C.pid;
    let big, title, cls = '';
    if (amDrawer) { big = '🎨'; title = res.correct ? `친구 ${res.correct}명이 맞혔어요!` : '아무도 못 맞혔어요'; cls = res.pts > 0 ? 'ok' : ''; }
    else if (res.ok) { big = '⭕'; title = '정답!'; cls = 'ok'; }
    else { big = '❌'; title = r.ans ? '아쉬워요!' : '답을 내지 않았어요'; cls = 'no'; }
    let note = '';
    if (res.rule === 'third' && res.mode === 'hard') note = amDrawer ? '맞힌 친구가 1/3 이하라서 이번엔 출제자 점수가 없어요.' : '맞힌 친구가 1/3 이하라서 출제자를 뺀 모두 +10점!';
    else if (res.rule === 'third' && res.mode === 'good') note = amDrawer ? '잘 그렸어요! 1/3 넘게 맞혀서 출제자도 +10점!' : (res.ok ? '' : '1/3 넘게 맞혀서 정답자와 출제자가 점수를 받아요.');
    return `<div class="res-card ${cls}">
      <div class="res-big">${big}</div>
      <h2>${title}</h2>
      <div class="res-word">정답 <b>${esc(r.word || '')}</b></div>
      ${amDrawer ? '' : `<div class="res-mine">내 답 <b>${esc(r.ans ? r.ans.text : '—')}</b></div>`}
      <div class="res-pts ${res.pts ? 'plus' : ''}">+${res.pts || 0}점</div>
      ${note ? `<p class="res-note">${note}</p>` : ''}
      <div class="res-sum">맞힌 친구 ${res.correct}/${res.parts}명 · 내 점수 <b>${st.me.score}점</b> (${st.me.rank}등)</div>
    </div>`;
  }
  function playResultSound(st) {
    const r = st.r;
    const res = r.res || {};
    if (res.canceled) return;
    if (r.drawer === C.pid) HCM.sfx.play(res.pts > 0 ? 'correct' : 'end');
    else HCM.sfx.play(res.ok ? 'correct' : 'wrong');
  }
  function renderCnt() {
    const el = $('#cntBadge');
    if (!el) return;
    const st = C.st;
    const r = st && st.r;
    if (!r || st.phase !== 'draw' || !r.cnt) { el.textContent = ''; return; }
    el.textContent = st.mode === 'instant' ? `⭐ 정답 ${r.cnt.cor}/${r.cnt.elig}` : `✍️ 제출 ${r.cnt.sub}/${r.cnt.elig}`;
  }
  function renderAnswerStatus() {
    const el = $('#ansStatus');
    const st = C.st;
    const r = st && st.r;
    if (!r || st.phase !== 'draw') { el.textContent = ''; return; }
    if (st.mode === 'instant') {
      if (r.ans && r.ans.ok) el.innerHTML = `<b class="good">⭕ 정답! (${esc(r.ans.text)})</b> 다른 친구들을 기다려요`;
      else if (C.ansPending) el.textContent = '확인하는 중…';
      else if (r.ans) el.innerHTML = `❌ ‘${esc(r.ans.text)}’은(는) 아니에요. 다시 써 보세요!`;
      else el.textContent = '맞히면 바로 알려 줘요. 여러 번 써 볼 수 있어요.';
    } else if (C.ansPending) el.innerHTML = `보내는 중… <b>${esc(C.ansPending)}</b>`;
    else if (r.ans) el.innerHTML = `✅ <b>${esc(r.ans.text)}</b> 제출했어요 <small>(마감 전까지 바꿀 수 있어요)</small>`;
    else el.textContent = '내 답은 나만 보여요. 마감되면 함께 공개해요.';
  }
  function updateAnswerEnabled() {
    const st = C.st;
    const r = st && st.r;
    const done = !!(st && st.mode === 'instant' && r && r.ans && r.ans.ok);
    $('#ansInput').disabled = done;
    $('#ansBtn').disabled = done;
  }
  function updateEditable() {
    const st = C.st;
    const r = st && st.r;
    const can = !!(r && st.phase === 'draw' && r.drawer === C.pid && !r.paused && !C.syncing);
    board.editable = can;
    $('#boardWrap').classList.toggle('can-draw', can);
  }
  function showFb(ok) {
    const el = $('#fb');
    el.textContent = ok ? '⭕ 정답!' : '❌ 땡!';
    el.className = 'fb ' + (ok ? 'ok' : 'no');
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('pop');
    clearTimeout(C.fbT);
    C.fbT = setTimeout(() => { el.hidden = true; }, 1300);
  }

  /* ================= 그리기 도구 ================= */
  function buildTools() {
    $('#colors').innerHTML = COLORS.map(c => `<button class="sw" type="button" data-c="${c}" style="--c:${c}" aria-label="색 ${c}"></button>`).join('');
    $('#sizes').innerHTML = SIZES.map(w => `<button class="sz" type="button" data-w="${w}" aria-label="굵기 ${w}"><i style="--d:${Math.max(6, Math.round(w / 1.8))}px"></i></button>`).join('');
    $('#colors').addEventListener('click', e => {
      const b = e.target.closest('.sw');
      if (!b) return;
      board.tool.c = b.dataset.c;
      board.tool.e = 0;
      syncTools();
    });
    $('#sizes').addEventListener('click', e => {
      const b = e.target.closest('.sz');
      if (!b) return;
      board.tool.w = +b.dataset.w;
      syncTools();
    });
    $('#tEraser').addEventListener('click', () => { board.tool.e = board.tool.e ? 0 : 1; syncTools(); });
    $('#tUndo').addEventListener('click', () => { if (board.editable) board.undo(); });
    $('#tClear').addEventListener('click', () => {
      const b = $('#tClear');
      if (!board.editable) return;
      if (b.dataset.arm === '1') {
        b.dataset.arm = '';
        b.textContent = '🗑 모두 지우기';
        board.clearLocal();
      } else {
        b.dataset.arm = '1';
        b.textContent = '한 번 더 누르면 지워져요';
        setTimeout(() => { b.dataset.arm = ''; b.textContent = '🗑 모두 지우기'; }, 2500);
      }
    });
    board.tool = { c: '#222222', w: 14, e: 0 };
    syncTools();
  }
  function syncTools() {
    $$('#colors .sw').forEach(b => b.classList.toggle('on', !board.tool.e && b.dataset.c === board.tool.c));
    $$('#sizes .sz').forEach(b => b.classList.toggle('on', +b.dataset.w === board.tool.w));
    $$('#sizes .sz i').forEach(i => { i.style.background = board.tool.e ? '#cfc4b8' : board.tool.c; });
    $('#tEraser').classList.toggle('on', !!board.tool.e);
  }

  /* ================= 이벤트 ================= */
  function bindUI() {
    document.addEventListener('pointerdown', () => HCM.sfx.unlock(), { passive: true });
    $('#roomForm').addEventListener('submit', e => {
      e.preventDefault();
      const room = $('#inRoom').value.replace(/\D/g, '').slice(0, 4);
      if (room.length !== 4) { HCM.toast('방 번호 4자리를 넣어 주세요.', 'warn'); return; }
      if (room !== C.room) {
        C.room = room;
        HCM.store.set(K.room, room);
        C.hostMissing = 0;
        C.autoJoinTried = false;
        if (N.conn) { const c = N.conn; N.conn = null; try { c.close(); } catch (er) { /* 무시 */ } }
      }
      $('#inRoom').blur();
      C.stopped = false;
      N.attempt = 0;
      scheduleRetry(0);
      render();
    });
    $('#inRoom').addEventListener('input', () => { $('#inRoom').value = $('#inRoom').value.replace(/\D/g, '').slice(0, 4); });
    $('#nameForm').addEventListener('submit', e => { e.preventDefault(); setTimeout(() => sendJoin($('#inName').value), 20); });
    $('#rosterGrid').addEventListener('click', e => {
      const b = e.target.closest('.rname');
      if (b && !b.disabled) sendJoin(b.dataset.n);
    });
    $('#btnChangeRoom').addEventListener('click', () => {
      C.room = '';
      HCM.store.del(K.room);
      C.needName = null;
      C.everWelcomed = false;
      C.st = null;
      clearTimeout(N.timer);
      if (N.conn) { const c = N.conn; N.conn = null; try { c.close(); } catch (er) { /* 무시 */ } }
      $('#inRoom').value = '';
      render();
      $('#inRoom').focus();
    });
    $('#choices').addEventListener('click', e => {
      const b = e.target.closest('.choice');
      if (!b || !C.st || !C.st.r) return;
      $$('#choices .choice').forEach(x => { x.disabled = true; });
      b.classList.add('on');
      sendMsg({ type: 'pick', rno: C.st.r.no, i: +b.dataset.i });
    });
    $('#ansForm').addEventListener('submit', e => { e.preventDefault(); setTimeout(submitAnswer, 20); });
    $('#btnSnd').addEventListener('click', () => {
      HCM.sfx.enabled = !HCM.sfx.enabled;
      HCM.store.set(K.snd, HCM.sfx.enabled ? '1' : '0');
      renderTop();
    });
    $('#btnMsgAction').addEventListener('click', () => location.reload());
  }

  buildTools();
  bindUI();
  HCM.keepAwake();
  render();
  if (C.room.length === 4) connect();
  // 시험용 창구 (자동 테스트에서만 씁니다)
  window.__hcmS = { C, N, board, reconnectNow };
})();
