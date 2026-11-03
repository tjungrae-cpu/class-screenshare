# 교실 화면 공유 (햇반)

학생들 화면을 교사 PC에서 한눈에 보는 웹앱입니다.

- 교사용: https://tjungrae-cpu.github.io/class-screenshare/teacher.html
- 학생용: https://tjungrae-cpu.github.io/class-screenshare/student.html
- 갤럭시탭 앱: https://github.com/tjungrae-cpu/class-screenshare/releases/latest/download/hatban-screenshare.apk

## 구조
- `docs/` — 교사·학생 웹 페이지 (GitHub Pages로 배포). PeerJS(WebRTC)로 교사 PC와 학생 기기를 직접 연결합니다. 화면은 서버에 저장되지 않습니다.
- `android/` — 갤럭시탭용 앱. 안드로이드 화면 캡처(MediaProjection)로 1초마다 화면을 찍어 학생 페이지를 통해 교사에게 보냅니다.
- `.github/workflows/build-apk.yml` — `android/`가 바뀌면 APK를 자동으로 빌드해 Releases에 올립니다.
