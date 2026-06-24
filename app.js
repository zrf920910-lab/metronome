// ===========================
// Smart Metronome PWA
// ===========================

(function () {
  'use strict';

  // ─── DOM Refs ──────────────────────────
  const bpmValue    = document.getElementById('bpmValue');
  const bpmSlider   = document.getElementById('bpmSlider');
  const dialProgress= document.getElementById('dialProgress');
  const dialKnob    = document.getElementById('dialKnob');
  const playBtn     = document.getElementById('playBtn');
  const playIcon    = document.getElementById('playIcon');
  const pauseIcon   = document.getElementById('pauseIcon');
  const playLabel   = document.getElementById('playLabel');
  const beatValue   = document.getElementById('beatValue');
  const beatIndicators = document.getElementById('beatIndicators');
  const soundSelect = document.getElementById('soundSelect');
  const volumeSlider= document.getElementById('volumeSlider');
  const tapArea     = document.getElementById('tapArea');
  const tapBpm      = document.getElementById('tapBpm');
  const tapCount    = document.getElementById('tapCount');
  const micBtn      = document.getElementById('micBtn');
  const micBpm      = document.getElementById('micBpm');
  const micConfidence = document.getElementById('micConfidence');
  const micCanvas   = document.getElementById('micCanvas');
  const tapHint     = document.getElementById('tapHint');
  const presetBtns  = document.querySelectorAll('.preset-btn');

  // ─── State ─────────────────────────────
  let bpm = 120;
  let beatsPerBar = 4;
  let currentBeat = 0;
  let isPlaying = false;
  let volume = 0.8;
  let soundType = 'click';
  let schedulerTimer = null;
  let nextBeatTime = 0;
  let schedulerLookahead = 25;    // ms
  let scheduleAheadTime = 0.1;    // seconds

  // Tap tempo state
  let tapTimes = [];
  const TAP_WINDOW_MS = 2000;
  const TAP_MIN_COUNT = 3;

  // Mic state
  let micStream = null;
  let micAudioCtx = null;
  let micAnalyser = null;
  let micSource = null;
  let micListening = false;
  let micDataArray = null;
  let micEnergyHistory = [];
  let micPeakTimes = [];
  let micAnimFrame = null;
  let micCtx2d = null;

  // ─── Audio Engine ──────────────────────
  let audioCtx = null;

  function getAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // ─── Sound Synthesis ──────────────────
  function createClickBuffer(type) {
    const ctx = getAudioCtx();
    const sr = ctx.sampleRate;
    const duration = 0.08;
    const len = Math.floor(sr * duration);
    const buf = ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);

    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 60);
      let sample = 0;

      switch (type) {
        case 'wood': // 木鱼 — short percussive
          sample = Math.sin(2 * Math.PI * 800 * t) * 0.6 +
                   Math.sin(2 * Math.PI * 1200 * t) * 0.3 +
                   Math.sin(2 * Math.PI * 400 * t) * 0.1;
          sample *= Math.exp(-t * 80);
          break;
        case 'click': // 电子 click
          sample = Math.sin(2 * Math.PI * 1000 * t) * 0.3 +
                   Math.sin(2 * Math.PI * 1500 * t) * 0.15;
          sample *= Math.exp(-t * 50);
          sample += (Math.random() * 2 - 1) * 0.08 * Math.exp(-t * 100);
          break;
        case 'beep': // 嘀声 — sine blip
          sample = Math.sin(2 * Math.PI * 880 * t);
          sample *= Math.exp(-t * 30);
          break;
        case 'stick': // 鼓棒 — bright transient
          sample = Math.sin(2 * Math.PI * 2000 * t) * 0.3 +
                   Math.sin(2 * Math.PI * 3000 * t) * 0.1;
          sample *= Math.exp(-t * 100);
          sample += (Math.random() * 2 - 1) * 0.15 * Math.exp(-t * 150);
          break;
        case 'clave': // 响棒 — resonant wood
          sample = Math.sin(2 * Math.PI * 2500 * t) * 0.25 +
                   Math.sin(2 * Math.PI * 1800 * t) * 0.2;
          sample *= Math.exp(-t * 55);
          break;
        case 'rim': // 鼓边 — rim shot
          sample = Math.sin(2 * Math.PI * 3000 * t) * 0.15 +
                   Math.sin(2 * Math.PI * 1500 * t) * 0.25;
          sample *= Math.exp(-t * 70);
          sample += (Math.random() * 2 - 1) * 0.12 * Math.exp(-t * 120);
          break;
      }
      data[i] = sample;
    }
    return buf;
  }

  // Cache sound buffers
  const soundCache = {};
  function getSound(type) {
    if (!soundCache[type]) {
      soundCache[type] = createClickBuffer(type);
    }
    return soundCache[type];
  }

  function playClick(beatIndex) {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const buf = getSound(soundType);
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const gainNode = ctx.createGain();
    // Accent downbeat
    const accentVolume = (beatIndex === 0) ? volume : volume * 0.7;
    gainNode.gain.setValueAtTime(accentVolume, now);

    src.connect(gainNode);
    gainNode.connect(ctx.destination);
    src.start(now);
    src.stop(now + 0.1);
  }

  // ─── Scheduler ─────────────────────────
  function nextBeat() {
    const secondsPerBeat = 60.0 / bpm;
    nextBeatTime += secondsPerBeat;

    currentBeat++;
    if (currentBeat >= beatsPerBar) currentBeat = 0;
  }

  function scheduleBeat(beatNum, time) {
    playClick(beatNum);
    updateBeatUI(beatNum);
  }

  function scheduler() {
    while (nextBeatTime < audioCtx.currentTime + scheduleAheadTime) {
      scheduleBeat(currentBeat, nextBeatTime);
      nextBeat();
    }
    schedulerTimer = setTimeout(scheduler, schedulerLookahead);
  }

  function startMetronome() {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();

    currentBeat = 0;
    nextBeatTime = ctx.currentTime + 0.05;
    isPlaying = true;
    updatePlayUI();
    scheduler();
  }

  function stopMetronome() {
    isPlaying = false;
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
    resetBeatUI();
    updatePlayUI();
  }

  function togglePlay() {
    if (isPlaying) {
      stopMetronome();
    } else {
      startMetronome();
    }
  }

  // ─── UI Updates ────────────────────────
  function updatePlayUI() {
    if (isPlaying) {
      playBtn.classList.add('playing');
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
      playLabel.textContent = '停止';
    } else {
      playBtn.classList.remove('playing');
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
      playLabel.textContent = '启动';
    }
  }

  function updateBeatUI(beat) {
    const dots = beatIndicators.children;
    for (let i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('active', i === beat);
    }
    if (beat === 0 && dots.length > 0) {
      bpmValue.classList.add('beat-accent');
      setTimeout(() => bpmValue.classList.remove('beat-accent'), 80);
    }
  }

  function resetBeatUI() {
    const dots = beatIndicators.children;
    for (let i = 0; i < dots.length; i++) {
      dots[i].classList.remove('active');
    }
  }

  function setBPM(val) {
    bpm = val;
    bpmValue.textContent = bpm;
    bpmSlider.value = bpm;

    // Update dial
    const minBPM = 30, maxBPM = 240;
    const pct = (bpm - minBPM) / (maxBPM - minBPM);
    const circumference = 553;
    dialProgress.style.strokeDashoffset = circumference * (1 - pct);

    // Update preset buttons
    presetBtns.forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.bpm) === bpm);
    });

    // If playing, reset timing
    if (isPlaying) {
      currentBeat = 0;
      nextBeatTime = audioCtx.currentTime + 0.05;
      updateBeatUI(0);
    }
  }

  function setBeatsPerBar(val) {
    beatsPerBar = Math.max(1, Math.min(12, val));
    beatValue.textContent = beatsPerBar;

    // Rebuild dots
    beatIndicators.innerHTML = '';
    for (let i = 0; i < beatsPerBar; i++) {
      const dot = document.createElement('span');
      dot.className = 'beat-dot';
      beatIndicators.appendChild(dot);
    }

    if (isPlaying) {
      currentBeat = 0;
      nextBeatTime = audioCtx.currentTime + 0.05;
      updateBeatUI(0);
    }
  }

  // ─── Event Listeners ──────────────────
  bpmSlider.addEventListener('input', () => {
    setBPM(parseInt(bpmSlider.value));
  });

  playBtn.addEventListener('click', togglePlay);

  document.getElementById('beatDown').addEventListener('click', () => {
    setBeatsPerBar(beatsPerBar - 1);
  });
  document.getElementById('beatUp').addEventListener('click', () => {
    setBeatsPerBar(beatsPerBar + 1);
  });

  soundSelect.addEventListener('change', () => {
    soundType = soundSelect.value;
  });

  volumeSlider.addEventListener('input', () => {
    volume = volumeSlider.value / 100;
  });

  // Preset buttons
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setBPM(parseInt(btn.dataset.bpm));
    });
  });

  // BPM display tap — also works for tap tempo
  bpmValue.parentElement.addEventListener('click', (e) => {
    if (e.target === bpmSlider) return;
    handleTap();
  });

  // ─── Tap Tempo ────────────────────────
  tapArea.addEventListener('click', (e) => {
    e.stopPropagation();
    handleTap();
  });

  function handleTap() {
    const now = Date.now();

    // Remove old taps
    tapTimes = tapTimes.filter(t => now - t < TAP_WINDOW_MS);
    tapTimes.push(now);

    // Flash feedback
    tapArea.style.background = 'rgba(255,159,10,0.15)';
    setTimeout(() => { tapArea.style.background = ''; }, 80);

    if (tapTimes.length < TAP_MIN_COUNT) {
      tapCount.textContent = `再点 ${TAP_MIN_COUNT - tapTimes.length} 次...`;
      tapBpm.textContent = '—';
      return;
    }

    // Calculate intervals
    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) {
      intervals.push(tapTimes[i] - tapTimes[i - 1]);
    }

    // Weighted average (recent taps get more weight)
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < intervals.length; i++) {
      const w = i + 1;
      weightedSum += intervals[i] * w;
      weightTotal += w;
    }

    const avgInterval = weightedSum / weightTotal;
    const detectedBPM = Math.round(60000 / avgInterval);

    // Clamp to reasonable range
    const clampedBPM = Math.max(30, Math.min(240, detectedBPM));

    tapBpm.textContent = clampedBPM;
    tapCount.textContent = `已检测 ${tapTimes.length} 次点击`;

    // Update metronome BPM
    setBPM(clampedBPM);
  }

  // ─── Mic BPM Detection ────────────────
  micBtn.addEventListener('click', async () => {
    if (micListening) {
      stopMic();
    } else {
      await startMic();
    }
  });

  async function startMic() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false }
      });

      micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      micSource = micAudioCtx.createMediaStreamSource(micStream);

      // Analyser for energy / onset detection
      micAnalyser = micAudioCtx.createAnalyser();
      micAnalyser.fftSize = 2048;
      micAnalyser.smoothingTimeConstant = 0.3;
      micSource.connect(micAnalyser);

      micDataArray = new Uint8Array(micAnalyser.frequencyBinCount);
      micEnergyHistory = [];
      micPeakTimes = [];

      // Mic canvas
      micCtx2d = micCanvas.getContext('2d');
      resizeMicCanvas();

      micListening = true;
      micBtn.textContent = '停止监听';
      micBtn.classList.add('listening');
      micBpm.textContent = '—';
      micConfidence.textContent = '正在分析...';

      requestAnimationFrame(micLoop);
    } catch (err) {
      console.error('Mic error:', err);
      micConfidence.textContent = '无法访问麦克风';
    }
  }

  function stopMic() {
    micListening = false;
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (micAudioCtx) {
      micAudioCtx.close();
      micAudioCtx = null;
    }
    micSource = null;
    micAnalyser = null;
    micDataArray = null;
    micEnergyHistory = [];
    micPeakTimes = [];
    if (micAnimFrame) cancelAnimationFrame(micAnimFrame);
    micBtn.textContent = '开始监听';
    micBtn.classList.remove('listening');
    micBpm.textContent = '—';
    micConfidence.textContent = '';
  }

  function resizeMicCanvas() {
    const rect = micCanvas.getBoundingClientRect();
    micCanvas.width = rect.width * devicePixelRatio;
    micCanvas.height = rect.height * devicePixelRatio;
    if (micCtx2d) micCtx2d.scale(devicePixelRatio, devicePixelRatio);
  }

  function micLoop() {
    if (!micListening) return;

    micAnalyser.getByteTimeDomainData(micDataArray);

    // Calculate RMS energy
    let sum = 0;
    for (let i = 0; i < micDataArray.length; i++) {
      const val = (micDataArray[i] - 128) / 128;
      sum += val * val;
    }
    const rms = Math.sqrt(sum / micDataArray.length);

    micEnergyHistory.push({ time: performance.now(), energy: rms });
    // Keep last 5 seconds
    const cutoff = performance.now() - 5000;
    micEnergyHistory = micEnergyHistory.filter(e => e.time > cutoff);

    // Onset detection: simple threshold crossing
    const ONSET_THRESHOLD = 0.08;
    const MIN_INTER_BEAT_MS = 200; // min time between beats (300 BPM max)

    if (micEnergyHistory.length >= 2) {
      const prev = micEnergyHistory[micEnergyHistory.length - 2];
      const curr = micEnergyHistory[micEnergyHistory.length - 1];
      if (prev.energy < ONSET_THRESHOLD && curr.energy >= ONSET_THRESHOLD) {
        if (micPeakTimes.length === 0 || (curr.time - micPeakTimes[micPeakTimes.length - 1]) > MIN_INTER_BEAT_MS) {
          micPeakTimes.push(curr.time);
          // Keep last ~8 seconds of peaks
          const peakCutoff = performance.now() - 8000;
          micPeakTimes = micPeakTimes.filter(t => t > peakCutoff);
        }
      }
    }

    // Calculate BPM from inter-onset intervals
    if (micPeakTimes.length >= 3) {
      const intervals = [];
      for (let i = 1; i < micPeakTimes.length; i++) {
        intervals.push(micPeakTimes[i] - micPeakTimes[i - 1]);
      }

      // Median interval (robust to outliers)
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const detectedBPM = Math.round(60000 / median);

      if (detectedBPM >= 30 && detectedBPM <= 240) {
        micBpm.textContent = detectedBPM;

        // Confidence based on interval consistency
        let sumSqDiff = 0;
        for (const iv of intervals) {
          sumSqDiff += (iv - median) * (iv - median);
        }
        const stdDev = Math.sqrt(sumSqDiff / intervals.length);
        const cv = stdDev / median; // coefficient of variation
        const conf = Math.max(0, Math.min(100, Math.round((1 - cv) * 100)));

        micConfidence.textContent = `置信度 ${conf}%  ·  点击数字应用此节奏`;
        micBpm.style.cursor = 'pointer';

        // Click to apply
        micBpm.onclick = () => {
          setBPM(detectedBPM);
          if (!isPlaying) startMetronome();
        };
      }
    }

    // Draw waveform
    drawMicWaveform();

    micAnimFrame = requestAnimationFrame(micLoop);
  }

  function drawMicWaveform() {
    if (!micCtx2d) return;
    const w = micCanvas.width / devicePixelRatio;
    const h = micCanvas.height / devicePixelRatio;

    micCtx2d.clearRect(0, 0, w, h);
    micCtx2d.strokeStyle = 'rgba(255,159,10,0.6)';
    micCtx2d.lineWidth = 1.5;
    micCtx2d.beginPath();

    const sliceWidth = w / micDataArray.length;
    let x = 0;
    for (let i = 0; i < micDataArray.length; i++) {
      const v = micDataArray[i] / 128.0;
      const y = (v * h) / 2;
      if (i === 0) micCtx2d.moveTo(x, y);
      else micCtx2d.lineTo(x, y);
      x += sliceWidth;
    }
    micCtx2d.stroke();

    // Threshold line
    const threshY = (1 - 0.08) * h / 2 + h / 4;
    micCtx2d.strokeStyle = 'rgba(255,255,255,0.15)';
    micCtx2d.setLineDash([4, 4]);
    micCtx2d.beginPath();
    micCtx2d.moveTo(0, threshY);
    micCtx2d.lineTo(w, threshY);
    micCtx2d.stroke();
    micCtx2d.setLineDash([]);
  }

  // Handle mic canvas resize
  window.addEventListener('resize', () => {
    if (micListening) resizeMicCanvas();
  });

  // ─── Keyboard Shortcuts ───────────────
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    }
    if (e.code === 'ArrowUp') {
      e.preventDefault();
      setBPM(Math.min(240, bpm + 1));
    }
    if (e.code === 'ArrowDown') {
      e.preventDefault();
      setBPM(Math.max(30, bpm - 1));
    }
  });

  // ─── PWA Service Worker ───────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // ─── Init ─────────────────────────────
  setBPM(120);
  setBeatsPerBar(4);
  volume = volumeSlider.value / 100;

})();
