/* Lobby pre-join: identity step → real device check step.
 *
 * Device checks are REAL: the camera preview comes from getUserMedia, the
 * mic meter from an AnalyserNode on the actual input signal, and the
 * speaker test plays a tone through the selected output device.  Nothing
 * here is simulated; unsupported capabilities are reported explicitly.
 */
import { toast } from "./toast.js";

const form = document.getElementById("join-form");
const stepJoin = document.getElementById("step-join");
const stepDevices = document.getElementById("step-devices");
const btnToDevices = document.getElementById("btn-to-devices");
const btnBack = document.getElementById("btn-back-join");
const btnJoin = document.getElementById("btn-join");

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
let micRaf = 0;

function showBrowserWarning() {
  const missing = [];
  if (!supports.media) missing.push("دسترسی به دوربین/میکروفون (getUserMedia)");
  if (!supports.rtc) missing.push("تماس تصویری (WebRTC)");
  if (!supports.ws) missing.push("ارتباط زنده (WebSocket)");
  if (!missing.length) return;
  browserWarning.hidden = false;
  browserWarning.textContent =
    "⚠️ مرورگر شما از این قابلیت‌ها پشتیبانی نمی‌کند: " +
    missing.join("، ") +
    ". برای تجربهٔ کامل از جدیدترین نسخهٔ Chrome، Edge یا Firefox استفاده کنید. ورود همچنان ممکن است.";
}

function setCamState(icon, text) {
  camStateIcon.textContent = icon;
  camStateText.textContent = text;
}

function friendlyMediaError(err) {
  const name = (err && err.name) || "";
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
    setCamState("⚠️", "پیش‌نمایش در این مرورگر ممکن نیست");
    return;
  }
  setCamState("⏳", "در حال دسترسی به دوربین…");
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
    setCamState("✅", "دوربین فعال است");
    await listDevices(); // labels become available after permission
    wireMicMeter();
  } catch (err) {
    video.srcObject = null;
    const name = (err && err.name) || "";
    setCamState("⛔", name === "NotAllowedError" ? "دسترسی داده نشد" : "دستگاه در دسترس نیست");
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
    const src = audioCtx.createMediaStreamSource(localStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      const pct = Math.min(100, Math.round((peak / 96) * 100));
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
      if (width > 8) sawSignal = true;
      if (sawSignal || Date.now() - started > 3000) return resolve();
      setTimeout(check, 120);
    };
    check();
  });
  micFeedback.textContent = sawSignal
    ? "✅ صدای شما دریافت شد — میکروفون سالم است."
    : "❌ سیگنالی از میکروفون دریافت نشد. مطمئن شوید صحبت کرده‌اید و دستگاه درست انتخاب شده است.";
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
    speakerFeedback.innerHTML = "🔊 یک بوق کوتاه پخش شد — آن را شنیدید؟";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "btn btn-sm btn-ghost";
    okBtn.textContent = "بله، شنیدم ✅";
    okBtn.onclick = () => {
      speakerFeedback.textContent = "✅ بلندگو سالم است.";
      okBtn.remove();
    };
    speakerFeedback.appendChild(document.createTextNode(" "));
    speakerFeedback.appendChild(okBtn);
  } catch {
    speakerFeedback.textContent = "❌ پخش صدا ممکن نشد.";
  }
}

function gotoStep(name) {
  const devices = name === "devices";
  stepJoin.hidden = devices;
  stepDevices.hidden = !devices;
  if (devices) {
    startPreview();
    btnJoin.focus();
  } else {
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    cancelAnimationFrame(micRaf);
    micLevel.style.width = "0%";
  }
}

if (btnToDevices) {
  btnToDevices.addEventListener("click", () => {
    // lightweight client-side gate; the server re-validates everything
    const nameInput = document.getElementById("id_display_name");
    if (nameInput && nameInput.value.trim().length < 2) {
      nameInput.focus();
      toast("نام نمایشی باید حداقل ۲ نویسه باشد.", "error");
      return;
    }
    gotoStep("devices");
  });
}
if (btnBack) btnBack.addEventListener("click", () => gotoStep("join"));
if (btnMicTest) btnMicTest.addEventListener("click", micTest);
if (btnSpeakerTest) btnSpeakerTest.addEventListener("click", speakerTest);
cameraSelect.addEventListener("change", () => { if (!stepDevices.hidden) startPreview(); });
micSelect.addEventListener("change", () => { if (!stepDevices.hidden) startPreview(); });

if (navigator.mediaDevices && "addEventListener" in navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener("devicechange", listDevices);
}

form.addEventListener("submit", () => {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (btnJoin) {
    btnJoin.disabled = true;
    btnJoin.textContent = "در حال ورود…";
  }
});

showBrowserWarning();
listDevices();
