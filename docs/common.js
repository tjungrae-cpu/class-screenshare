// 교실 화면 공유 - 공통 설정
window.HB = {
  ID_PREFIX: 'hatban-ss-',
  APK_URL: 'https://github.com/tjungrae-cpu/class-screenshare/releases/latest/download/hatban-screenshare.apk',
  APP_PACKAGE: 'kr.hatban.screenshare',

  // PeerJS 연결 옵션 (?peerhost=localhost:9000 으로 테스트 서버 지정 가능)
  peerOptions() {
    const opts = {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    };
    const ph = new URLSearchParams(location.search).get('peerhost');
    if (ph) {
      const [host, port] = ph.split(':');
      Object.assign(opts, { host, port: Number(port || 9000), path: '/', secure: false });
    }
    return opts;
  },

  teacherId(code) { return this.ID_PREFIX + String(code).trim(); },

  store: {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
};
