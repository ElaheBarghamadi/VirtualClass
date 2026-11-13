/**
 * device-test.js — optional, one-time audio/video check inside the room.
 *
 * Deliberately passive: nothing (no camera, no microphone) is touched until
 * the participant presses «شروع تست».  The card shows once per browser tab per
 * classroom and can be dismissed with «بعداً»; dismissing or closing releases
 * every track and the audio context immediately.
 */

const SEEN_KEY = (roomCode) => `vc:device-test:${roomCode}`;

/**
 * Gather ICE candidates with the classroom's own STUN/TURN list and report what
 * kind of addresses this network can offer:
 *
 * * `relay` — a TURN server answered.  This is the only kind that works on
 *   every network (mobile carriers, offices, strict NAT).
 * * `srflx` — only STUN answered: fine between friendly networks, usually
 *   fails when both sides sit behind a strict/CGNAT NAT.
 * * `host`  — nothing but local addresses: no one outside this network will
 *   ever receive your camera, no matter what the button says.
 *
 * This is the honest answer to «دوربین روشن می‌شود ولی بقیه نمی‌بینند»: local
 * preview comes straight from the device and always looks fine.
 */
export async function gatherIceReport(iceServers, timeoutMs = 5000) {
  const empty = { supported: false, types: [], relay: false, srflx: false, host: false };
  if (typeof RTCPeerConnection === 'undefined') return empty;
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: Array.isArray(iceServers) ? iceServers : [] });
  } catch (e) {
    return empty;
  }
  const counts = { host: 0, srflx: 0, relay: 0 };
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    pc.onicecandidate = (event) => {
      const line = event.candidate && event.candidate.candidate;
      if (!line) { finish(); return; }          // null candidate = gathering done
      const m = /typ (host|srflx|relay|prflx)/.exec(line);
      if (m && m[1] in counts) counts[m[1]] += 1;
    };
    setTimeout(finish, timeoutMs);
  });
  try {
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    await done;
  } catch (e) {
    /* fall through: an empty report is itself the answer */
  } finally {
    try { pc.close(); } catch (e) { /* already closed */ }
  }
  const types = Object.keys(counts).filter((k) => counts[k] > 0);
  return {
    supported: true,
    types,
    relay: counts.relay > 0,
    srflx: counts.srflx > 0,
    host: counts.host > 0,
  };
}

/** One sentence a teacher can act on, or null when the report says nothing. */
export function describeIceReport(report) {
  if (!report || !report.supported) return null;
  if (report.relay) {
    return { state: 'ok', text: 'رلهٔ سرور (TURN) در دسترس است — تصویر و صدای شما روی هر شبکه‌ای به بقیه می‌رسد.' };
  }
  if (report.srflx) {
    return {
      state: 'warn',
      text: 'شبکهٔ شما فقط با STUN جواب داد: بین شبکه‌های باز کار می‌کند، اما اگر هم‌کلاسی پشت شبکهٔ موبایل/اداری باشد ممکن است تصویر شما را نبیند (به TURN یا سرور رسانه نیاز است).',
    };
  }
  if (report.host) {
    return {
      state: 'warn',
      text: 'شبکهٔ شما هیچ آدرس عمومی برنگرداند — بدون سرور رله (TURN) یا LiveKit، هیچ هم‌کلاسی از شبکهٔ دیگر تصویر شما را نمی‌بیند.',
    };
  }
  return null;
}

export function initDeviceTest({ roomCode, iceServers } = {}) {
  const card = document.getElementById('device-test-card');
  if (!card) return;

  const video = document.getElementById('dt-video');
  const levelBar = document.getElementById('dt-level');
  const status = document.getElementById('dt-status');
  const body = document.getElementById('dt-body');
  const startBtn = document.getElementById('dt-start');
  const laterBtn = document.getElementById('dt-later');
  const closeBtn = document.getElementById('dt-close');
  const netLine = document.getElementById('dt-net');

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
    if (netLine) { netLine.setAttribute('hidden', ''); netLine.textContent = ''; }
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

    // Camera + mic are local; whether other people receive them is decided by
    // ICE.  Answer that here instead of leaving "it works for me".
    if (netLine) {
      netLine.removeAttribute('hidden');
      netLine.dataset.state = '';
      netLine.textContent = 'در حال بررسی مسیر رسیدن تصویر به هم‌کلاسی‌ها…';
      const report = await gatherIceReport(iceServers);
      const verdict = describeIceReport(report);
      if (verdict) {
        netLine.dataset.state = verdict.state;
        netLine.textContent = verdict.text;
        // One line of evidence for support: which candidate types arrived.
        console.info('[device-test] ice candidates:', report.types.join(', ') || 'none');
      } else {
        netLine.textContent = 'بررسی شبکه در این مرورگر ممکن نشد.';
      }
    }
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
