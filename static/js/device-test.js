/**
 * device-test.js — optional, one-time audio/video check inside the room.
 *
 * Deliberately passive: nothing (no camera, no microphone) is touched until
 * the participant presses «شروع تست».  The card shows once per browser tab per
 * classroom and can be dismissed with «بعداً»; dismissing or closing releases
 * every track and the audio context immediately.
 */

const SEEN_KEY = (roomCode) => `vc:device-test:${roomCode}`;

export function initDeviceTest({ roomCode } = {}) {
  const card = document.getElementById('device-test-card');
  if (!card) return;

  const video = document.getElementById('dt-video');
  const levelBar = document.getElementById('dt-level');
  const status = document.getElementById('dt-status');
  const body = document.getElementById('dt-body');
  const startBtn = document.getElementById('dt-start');
  const laterBtn = document.getElementById('dt-later');
  const closeBtn = document.getElementById('dt-close');

  let stream = null;
  let ctx = null;
  let analyser = null;
  let raf = 0;
  let peak = 0;

  const cleanup = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
    if (ctx) { try { ctx.close(); } catch (e) { /* already closed */ } }
    ctx = null;
    analyser = null;
  };

  const hide = () => {
    cleanup();
    card.classList.add('hidden');
    card.setAttribute('aria-hidden', 'true');
    try { sessionStorage.setItem(SEEN_KEY(roomCode), '1'); } catch (e) { /* private mode */ }
  };

  const fail = (message) => {
    if (status) status.textContent = message;
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'تلاش دوباره'; }
  };

  const meter = () => {
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const pct = Math.min(100, Math.round(rms * 320));
    if (levelBar) levelBar.style.width = `${pct}%`;
    if (pct > peak + 6) {
      peak = pct;
      if (status) {
        status.textContent = 'صدای شما شنیده می‌شود — میکروفون سالم است.';
        status.dataset.state = 'ok';
      }
    }
    raf = requestAnimationFrame(meter);
  };

  const start = async () => {
    startBtn.disabled = true;
    startBtn.textContent = 'در حال آماده‌سازی…';
    if (status) { status.textContent = 'در حال درخواست دسترسی به دوربین و میکروفون…'; status.dataset.state = ''; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        fail('مرورگر دسترسی را مسدود کرد. از آیکون قفل کنار نوار آدرس اجازه بدهید و دوباره تلاش کنید.');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        fail('دوربین یا میکروفونی پیدا نشد؛ می‌توانید بدون تست وارد شوید.');
      } else {
        fail('تست دستگاه ممکن نشد؛ می‌توانید بدون تست ادامه دهید.');
      }
      return;
    }

    body?.removeAttribute('hidden');
    if (video) {
      video.muted = true;
      video.srcObject = stream;
      video.play?.().catch(() => { /* autoplay policies */ });
    }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      meter();
      if (status) { status.textContent = 'حالا چند کلمه بلند بگویید تا سطح صدا را ببینیم.'; status.dataset.state = 'pending'; }
    } catch (e) {
      if (status) status.textContent = 'تست صدا در این مرورگر ممکن نشد؛ تصویر را بررسی کنید.';
    }
    startBtn.textContent = 'تست انجام شد';
    startBtn.disabled = true;
    laterBtn.textContent = 'بستن';
  };

  const show = () => {
    card.classList.remove('hidden');
    card.removeAttribute('aria-hidden');
    card.classList.add('is-in');
  };

  startBtn?.addEventListener('click', start);
  laterBtn?.addEventListener('click', hide);
  closeBtn?.addEventListener('click', hide);

  let seen = false;
  try { seen = sessionStorage.getItem(SEEN_KEY(roomCode)) === '1'; } catch (e) { seen = false; }
  if (seen) return;
  // let the room finish connecting before asking for attention
  setTimeout(show, 2600);
}
