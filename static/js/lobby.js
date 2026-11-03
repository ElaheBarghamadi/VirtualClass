/* Lobby pre-join: identity step → real device check step.
 *
 * Device checks are REAL: the camera preview comes from getUserMedia, the
 * mic meter from an AnalyserNode on the actual input signal, and the
 * speaker test plays a tone through the selected output device.  Nothing
 * here is simulated; unsupported capabilities are reported explicitly.
 */
import { toast } from "./toast.js";

const form = document.getElementById("join-form");
const btnToDevices = document.getElementById("btn-to-devices");
const devicePanel = document.getElementById("device-panel");
const btnJoin = document.getElementById("btn-join");
const btnImTeacher = document.getElementById("btn-im-teacher");
const nameInput = document.getElementById("id_display_name");
const avatar = document.getElementById("join-avatar");

const video = document.getElementById("lobby-video");
const camStateIcon = document.getElementById("cam-state-icon");
const camStateText = document.getElementById("cam-state-text");
const deviceError = document.getElementById("device-error");
const browserWarning = document.getElementById("browser-warning");

const cameraSelect = document.getElementById("device-camera");
const micSelect = document.getElementById("device-mic");
const speakerSelect = document.getElementById("device-speaker");

const btnMicTest = document.getElementById("btn-mic-test");
const btnSpeakerTest = document.getElementById("btn-speaker-test");
const micLevel = document.getElementById("mic-level");
const micFeedback = document.getElementById("mic-feedback");
const speakerFeedback = document.getElementById("speaker-feedback");

const supports = {
  media: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  enumerate: !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices),
  ws: "WebSocket" in window,
  rtc: "RTCPeerConnection" in window,
  sinkId: typeof HTMLAudioElement !== "undefined" && "setSinkId" in HTMLAudioElement.prototype,
  screenShare: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
};

let localStream = null;
let audioCtx = null;
let analyser = null;
let micSource = null;
let micRaf = 0;

function showBrowserWarning() {
  const missing = [];
  if (!supports.media) missing.push("دسترسی به دوربین/میکروفون (getUserMedia)");
  if (!supports.rtc) missing.push("تماس تصویری (WebRTC)");
  if (!supports.ws) missing.push("ارتباط زنده (WebSocket)");
  if (!missing.length) return;
  browserWarning.hidden = false;
  browserWarning.textContent =
    "مرورگر شما از این قابلیت‌ها پشتیبانی نمی‌کند: " +
    missing.join("، ") +
    ". برای تجربهٔ کامل از جدیدترین نسخهٔ Chrome، Edge یا Firefox استفاده کنید. ورود همچنان ممکن است.";
}

// Emoji render as tofu on some Linux/Windows setups and clash with the icon
// set used everywhere else — states carry a small inline SVG instead.
const CAM_ICONS = {
  idle: '<path d="M4 8.5h3l1.6-2h6.8l1.6 2h3v9H4z"/><circle cx="12" cy="12.8" r="3.2"/>',
  busy: '<circle cx="12" cy="12" r="8.4" stroke-dasharray="3 3"/>',
  ok: '<circle cx="12" cy="12" r="8.4"/><path d="m8.4 12.3 2.5 2.5 4.8-5"/>',
  warn: '<path d="M12 4.4 20.4 19.6H3.6z"/><path d="M12 9.8v4"/><path d="M12 16.4v.4"/>',
  error: '<circle cx="12" cy="12" r="8.4"/><path d="M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4"/>',
};
function setCamState(state, text) {
  camStateIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + (CAM_ICONS[state] || CAM_ICONS.idle) + '</svg>';
  camStateIcon.dataset.state = state;
  camStateText.textContent = text;
}

function friendlyMediaError(err) {
  const name = (err && err.name) || "";
  if (window.self !== window.top && (name === "NotAllowedError" || name === "SecurityError")) {
    return "مرورگر دسترسی دوربین/میکروفون را داخل این پنجرهٔ توکار مسدود کرده است. صفحه را در یک تب جدید باز کنید و اجازهٔ دسترسی بدهید.";
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "دسترسی به دوربین/میکروفون توسط مرورگر مسدود شده است. روی آیکون قفل کنار نوار آدرس کلیک کنید، دسترسی را «مجاز» کنید و دوباره تلاش کنید.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "دوربین یا میکروفونی پیدا نشد. یک دستگاه متصل کنید و دوباره تلاش کنید.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "دستگاه شما در اختیار برنامهٔ دیگری است (مثلاً جلسهٔ دیگر). آن برنامه را ببندید و دوباره تلاش کنید.";
  }
  return "خطای غیرمنتظره در دسترسی به دستگاه‌ها: " + (err && err.message ? err.message : name);
}

async function listDevices() {
  if (!supports.enumerate) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (select, kind, fallback) => {
    const current = select.value;
    select.innerHTML = "";
    const items = devices.filter((d) => d.kind === kind);
    if (!items.length) {
      const opt = document.createElement("option");
      opt.textContent = fallback;
      select.appendChild(opt);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    items.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `${fallback} ${i + 1}`;
      select.appendChild(opt);
    });
    if (current && items.some((d) => d.deviceId === current)) select.value = current;
  };
  fill(cameraSelect, "videoinput", "دوربین");
  fill(micSelect, "audioinput", "میکروفون");
  fill(speakerSelect, "audiooutput", "بلندگو");
  if (!supports.sinkId) {
    speakerSelect.disabled = true;
    speakerSelect.title = "انتخاب بلندگو در این مرورگر پشتیبانی نمی‌شود";
  }
}

async function startPreview() {
  if (!supports.media) {
    setCamState("warn", "پیش‌نمایش در این مرورگر ممکن نیست");
    return;
  }
  setCamState("busy", "در حال دسترسی به دوربین…");
  deviceError.hidden = true;
  try {
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    const constraints = {
      video: cameraSelect.value ? { deviceId: { exact: cameraSelect.value } } : true,
      audio: micSelect.value ? { deviceId: { exact: micSelect.value } } : true,
    };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = localStream;
    await video.play().catch(() => {});
    setCamState("ok", "دوربین فعال است");
    await listDevices(); // labels become available after permission
    wireMicMeter();
  } catch (err) {
    video.srcObject = null;
    const name = (err && err.name) || "";
    setCamState("error", name === "NotAllowedError" ? "دسترسی داده نشد" : "دستگاه در دسترس نیست");
    deviceError.hidden = false;
    deviceError.textContent = friendlyMediaError(err);
  }
}

function wireMicMeter() {
  const track = localStream && localStream.getAudioTracks()[0];
  cancelAnimationFrame(micRaf);
  if (!track) {
    micLevel.style.width = "0%";
    return;
  }
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    // Switching devices re-enters here: drop the previous tap, otherwise every
    // change leaks a MediaStreamSource that keeps the old device alive.
    if (micSource) { try { micSource.disconnect(); } catch { /* noop */ } micSource = null; }
    const src = audioCtx.createMediaStreamSource(localStream);
    micSource = src;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      const pct = Math.min(100, Math.round((peak / 90) * 100));
      micLevel.style.width = pct + "%";
      micRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    micLevel.style.width = "0%";
  }
}

async function micTest() {
  micFeedback.textContent = "چند ثانیه صحبت کنید…";
  if (!localStream || !localStream.getAudioTracks().length) {
    await startPreview();
  }
  if (!analyser) {
    micFeedback.textContent = "میکروفون در دسترس نیست.";
    return;
  }
  // analyse the REAL signal for 3 seconds
  const started = Date.now();
  let sawSignal = false;
  await new Promise((resolve) => {
    const check = () => {
      const width = parseFloat(micLevel.style.width || "0");
      if (width > 5) sawSignal = true;   // matches the in-room meter's gate
      if (sawSignal || Date.now() - started > 3000) return resolve();
      setTimeout(check, 120);
    };
    check();
  });
  micFeedback.textContent = sawSignal
    ? "صدای شما دریافت شد — میکروفون سالم است."
    : "سیگنالی از میکروفون دریافت نشد. مطمئن شوید صحبت کرده‌اید و دستگاه درست انتخاب شده است.";
}

async function speakerTest() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.1);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 1.2);

    // route through the selected output device where the browser allows it
    if (supports.sinkId && speakerSelect.value) {
      try {
        const dest = ctx.createMediaStreamDestination();
        gain.disconnect();
        gain.connect(dest);
        const audioEl = new Audio();
        audioEl.srcObject = dest.stream;
        await audioEl.setSinkId(speakerSelect.value);
        await audioEl.play();
        osc.onended = () => audioEl.pause();
      } catch {
        speakerFeedback.textContent = "انتخاب بلندگو در این مرورگر ممکن نشد؛ صدا از دستگاه پیش‌فرض پخش شد.";
      }
    }
    speakerFeedback.textContent = "یک بوق کوتاه پخش شد — آن را شنیدید؟";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "btn btn-sm btn-ghost";
    okBtn.textContent = "بله، شنیدم";
    okBtn.onclick = () => {
      speakerFeedback.textContent = "بلندگو سالم است.";
      okBtn.remove();
    };
    speakerFeedback.appendChild(document.createTextNode(" "));
    speakerFeedback.appendChild(okBtn);
  } catch {
    speakerFeedback.textContent = "پخش صدا ممکن نشد.";
  }
}

/**
 * Optional device check.  The test is never a step you must pass: the join
 * button submits whether it is open or closed, and closing it releases the
 * camera/microphone immediately.
 */
function setDevicePanel(open) {
  if (!devicePanel || !btnToDevices) return;
  devicePanel.hidden = !open;
  btnToDevices.setAttribute("aria-expanded", String(open));
  devicePanel.classList.toggle("is-open", open);
  if (open) {
    startPreview();
  } else {
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    cancelAnimationFrame(micRaf);
    micLevel.style.width = "0%";
    setCamState("idle", "تست را دوباره باز کنید");
  }
}

if (btnToDevices) {
  btnToDevices.addEventListener("click", () => {
    setDevicePanel(devicePanel.hidden);
  });
}
if (btnMicTest) btnMicTest.addEventListener("click", micTest);
if (btnSpeakerTest) btnSpeakerTest.addEventListener("click", speakerTest);
const previewOpen = () => Boolean(devicePanel && !devicePanel.hidden);
cameraSelect.addEventListener("change", () => { if (previewOpen()) startPreview(); });
micSelect.addEventListener("change", () => { if (previewOpen()) startPreview(); });

if (navigator.mediaDevices && "addEventListener" in navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener("devicechange", listDevices);
}

if (btnImTeacher) {
  btnImTeacher.addEventListener("click", () => {
    const on = btnImTeacher.getAttribute("aria-pressed") !== "true";
    btnImTeacher.setAttribute("aria-pressed", String(on));
    document.getElementById("join-form")?.classList.toggle("teacher-mode", on);
    const label = document.getElementById("join-password-label");
    const help = document.getElementById("join-password-help");
    if (label) label.textContent = on ? "رمز معلم" : "رمز کلاس";
    if (help) {
      help.textContent = on
        ? "با رمز معلم وارد می‌شوید؛ اگر آن را ندارید، رمز کلاس را وارد کنید."
        : "رمز را میزبان کلاس به شما داده است.";
    }
    document.getElementById("id_password")?.focus();
    toast(on ? "حالت معلم — رمز را وارد کنید." : "حالت مهمان.", "info", 2200);
  });
}

// live initials avatar while typing the display name
if (nameInput && avatar) {
  const syncAvatar = () => {
    const v = nameInput.value.trim();
    avatar.textContent = v ? v.charAt(0) : "؟";
    avatar.classList.toggle("is-empty", !v);
    nameInput.parentElement?.parentElement?.classList.toggle("has-value", Boolean(v));
  };
  nameInput.addEventListener("input", syncAvatar);
  syncAvatar();
}

form.addEventListener("submit", (e) => {
  // lightweight client-side gate; the server re-validates everything
  if (nameInput && nameInput.offsetParent !== null && nameInput.value.trim().length < 2) {
    e.preventDefault();
    nameInput.focus();
    toast("نام نمایشی باید حداقل ۲ نویسه باشد.", "error");
    return;
  }
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (btnJoin) {
    btnJoin.disabled = true;
    btnJoin.querySelector("span").textContent = "در حال ورود…";
  }
});

showBrowserWarning();
listDevices();
