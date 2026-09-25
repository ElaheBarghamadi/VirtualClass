/**
 * lobby.js — device preview in the lobby (camera + mic level meter).
 * The selected devices are remembered for the room's media session.
 */
const video = document.getElementById('lobby-video');
const btnToggle = document.getElementById('btn-preview-toggle');
const camSelect = document.getElementById('device-camera');
const micSelect = document.getElementById('device-mic');
const micLevel = document.getElementById('mic-level');

let stream = null;
let audioCtx = null;

async function listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    fill(camSelect, devices.filter((d) => d.kind === 'videoinput'));
    fill(micSelect, devices.filter((d) => d.kind === 'audioinput'));
}

function fill(select, devices) {
    select.innerHTML = '';
    devices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `دستگاه ${i + 1}`;
        select.appendChild(opt);
    });
}

async function startPreview() {
    try {
        stream?.getTracks().forEach((t) => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({
            video: camSelect.value ? { deviceId: { exact: camSelect.value } } : true,
            audio: micSelect.value ? { deviceId: { exact: micSelect.value } } : true,
        });
        video.srcObject = stream;
        localStorage.setItem('preferred_camera', camSelect.value || '');
        localStorage.setItem('preferred_mic', micSelect.value || '');
        btnToggle.textContent = '📹 خاموش کردن پیش‌نمایش';
        startMicMeter(stream);
        await listDevices(); // labels become visible after permission
    } catch (err) {
        btnToggle.textContent = '📹 دسترسی به دوربین/میکروفون ممکن نشد';
    }
}

function stopPreview() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    micLevel.style.width = '0%';
    btnToggle.textContent = '📹 روشن کردن پیش‌نمایش';
}

function startMicMeter(mediaStream) {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(mediaStream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        (function tick() {
            if (!stream) return;
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
            micLevel.style.width = `${Math.min(100, peak * 1.6)}%`;
            requestAnimationFrame(tick);
        })();
    } catch (e) { /* meter is decorative */ }
}

btnToggle?.addEventListener('click', () => (stream ? stopPreview() : startPreview()));
camSelect?.addEventListener('change', () => stream && startPreview());
micSelect?.addEventListener('change', () => stream && startPreview());

listDevices();
