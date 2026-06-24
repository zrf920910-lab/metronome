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
  let sliderDebounce = 0;
  bpmSlider.addEventListener('input', () => {
    const val = parseInt(bpmSlider.value);
    setBPM(val);
    // Haptic + tick on every ~4 BPM change to avoid overload
    if (Math.abs(val - sliderDebounce) >= 4) {
      hapticPulse();
      sliderDebounce = val;
    }
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
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: { ideal: 44100 }
        }
      });

      micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (micAudioCtx.state === 'suspended') await micAudioCtx.resume();
      micSource = micAudioCtx.createMediaStreamSource(micStream);

      // Analyser: FFT for spectral flux, ZERO smoothing for raw transients
      micAnalyser = micAudioCtx.createAnalyser();
      micAnalyser.fftSize = 1024;     // 512 frequency bins
      micAnalyser.smoothingTimeConstant = 0;
      micAnalyser.minDecibels = -100;
      micAnalyser.maxDecibels = 0;
      micSource.connect(micAnalyser);

      micDataArray = new Uint8Array(micAnalyser.frequencyBinCount); // 512 bins
      micPrevSpectrum = new Uint8Array(micAnalyser.frequencyBinCount);
      micPrevSpectrum.fill(0);
      micFluxBuffer = [];
      micFluxCanvasArr = [];
      micTempoBPM = null;
      micTempoConf = 0;
      micFrameCount = 0;
      micEnergyHistory = [];
      micPeakTimes = [];

      // Mic canvas — get context fresh each time
      micCtx2d = micCanvas.getContext('2d');

      micListening = true;
      micBtn.textContent = '停止监听';
      micBtn.classList.add('listening');
      micBpm.textContent = '—';
      micConfidence.textContent = '正在分析频谱...';
      micEnergyLabel.textContent = '';
      micEnergyFill.style.width = '0%';

      // Prime: get first spectrum so prev is valid
      await new Promise(r => setTimeout(r, 50));
      micAnalyser.getByteFrequencyData(micPrevSpectrum);

      requestAnimationFrame(micLoop);
    } catch (err) {
      console.error('Mic error:', err);
      micConfidence.textContent = '麦克风未授权或不可用';
    }
  }

  function stopMic() {
    micListening = false;
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (micAudioCtx) {
      micAudioCtx.close().catch(() => {});
      micAudioCtx = null;
    }
    micSource = null;
    micAnalyser = null;
    micDataArray = null;
    micPrevSpectrum = null;
    micFluxBuffer = [];
    micFluxCanvasArr = [];
    micEnergyHistory = [];
    micPeakTimes = [];
    micTempoBPM = null;
    micTempoConf = 0;
    micFrameCount = 0;
    if (micAnimFrame) cancelAnimationFrame(micAnimFrame);
    micBtn.textContent = '开始监听';
    micBtn.classList.remove('listening');
    micBpm.textContent = '—';
    micConfidence.textContent = '';
    micEnergyLabel.textContent = '';
    micEnergyFill.style.width = '0%';
  }

  function resizeMicCanvas() {
    if (!micCanvas || !micCtx2d) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = micCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (micCanvas.width !== w * dpr || micCanvas.height !== h * dpr) {
      micCanvas.width = w * dpr;
      micCanvas.height = h * dpr;
    }
  }


  // SPECTRAL FLUX ONSET DETECTION + AUTOCORRELATION TEMPO ESTIMATION
  // Based on standard MIR beat-tracking pipeline:
  //   1. Compute spectral flux (onset detection function)
  //   2. Run autocorrelation on flux signal
  //   3. Find dominant period -> BPM
  //

  // Sub-band boundaries for FFT bins (sr=44100, fftSize=1024 -> 512 bins, ~43Hz/bin)
  //   Band 0 (sub): bins 0-2   ~0-130Hz   (kick thump)
  //   Band 1 (low): bins 3-7   ~130-345Hz (kick+snare body)
  //   Band 2 (mid): bins 8-25  ~345-1100Hz (snare+toms)
  //   Band 3 (high):bins 26-100~1100-4300Hz(hihats+transients)
  //   Band 4 (top): bins 101-200~4300-8600Hz(crisp attacks)
  const SUB_BANDS = [
    { lo: 0,  hi: 2,   weight: 0.8 },
    { lo: 3,  hi: 7,   weight: 1.0 },
    { lo: 8,  hi: 25,  weight: 1.2 },
    { lo: 26, hi: 100, weight: 1.5 },
    { lo: 101,hi: 200, weight: 1.3 }
  ];

  function computeBandEnergy(spectrum, lo, hi) {
    let e = 0;
    for (let i = lo; i <= hi && i < spectrum.length; i++) {
      // Normalize 0-255 to 0-1
      e += spectrum[i] / 255;
    }
    return e / (hi - lo + 1);
  }

  function computeSpectralFlux(currSpec, prevSpec) {
    // Weighted multi-band spectral flux: sum of rectified differences
    let flux = 0;
    for (const band of SUB_BANDS) {
      const currE = computeBandEnergy(currSpec, band.lo, band.hi);
      const prevE = computeBandEnergy(prevSpec, band.lo, band.hi);
      const diff = currE - prevE;
      if (diff > 0) {
        flux += diff * band.weight;
      }
    }
    return flux;
  }

  function autocorrelateBPM(fluxValues, frameRate) {
    // fluxValues: array of {flux, time}
    // Returns {bpm, confidence} or null
    if (fluxValues.length < 60) return null; // need ~1s of data minimum

    const n = fluxValues.length;
    const minLag = Math.round(frameRate * 60 / 240); // 240 BPM -> 0.25s
    const maxLag = Math.round(frameRate * 60 / 30);  // 30 BPM  -> 2s

    if (maxLag >= n) return null;

    // Compute autocorrelation for each lag
    const acValues = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let ac = 0;
      let count = 0;
      for (let i = lag; i < n; i++) {
        ac += fluxValues[i].flux * fluxValues[i - lag].flux;
        count++;
      }
      acValues.push({ lag, ac: ac / count });
    }

    // Find peaks in autocorrelation
    // A peak is a local maximum
    const peaks = [];
    for (let i = 1; i < acValues.length - 1; i++) {
      if (acValues[i].ac > acValues[i - 1].ac && acValues[i].ac > acValues[i + 1].ac) {
        peaks.push(acValues[i]);
      }
    }

    if (peaks.length === 0) return null;

    // Sort by autocorrelation value (highest correlation first)
    peaks.sort((a, b) => b.ac - a.ac);

    // Take the best peak within reasonable range
    const best = peaks[0];
    const bpm = Math.round(frameRate * 60 / best.lag);

    if (bpm < 30 || bpm > 240) return null;

    // Confidence: ratio of best peak to mean AC
    const meanAC = acValues.reduce((s, v) => s + v.ac, 0) / acValues.length;
    const confidence = Math.min(1.0, (best.ac / Math.max(0.001, meanAC) - 1) * 2);

    return { bpm, confidence };
  }

  const TEMPO_UPDATE_INTERVAL = 15; // update tempo estimate every ~15 frames (~250ms)

  function micLoop(timestamp) {
    if (!micListening) return;

    micFrameCount++;

    // 1. Get current frequency spectrum
    micAnalyser.getByteFrequencyData(micDataArray);

    // 2. Compute spectral flux (onset detection function)
    const flux = computeSpectralFlux(micDataArray, micPrevSpectrum);

    // 3. Store in ring buffer (~10 seconds max)
    const now = timestamp || performance.now();
    micFluxBuffer.push({ time: now, flux: flux });
    micFluxCanvasArr.push(flux);
    // Keep ~10 seconds
    const cutoff = now - 10000;
    while (micFluxBuffer.length > 0 && micFluxBuffer[0].time < cutoff) {
      micFluxBuffer.shift();
    }
    // Keep canvas array same length
    while (micFluxCanvasArr.length > micFluxBuffer.length) {
      micFluxCanvasArr.shift();
    }

    // 4. Save current spectrum for next frame's flux calc
    micPrevSpectrum.set(micDataArray);

    // 5. Update energy bar (visual feedback)
    const totalEnergy = computeBandEnergy(micDataArray, 0, micDataArray.length - 1);
    const energyPct = Math.min(100, totalEnergy * 200); // scale for visibility
    micEnergyFill.style.width = energyPct + '%';

    // 6. Periodic tempo estimation via autocorrelation
    if (micFrameCount % TEMPO_UPDATE_INTERVAL === 0 && micFluxBuffer.length >= 60) {
      // Estimate effective frame rate from timestamps
      let frameRate = 60;
      if (micFluxBuffer.length >= 2) {
        const dt = micFluxBuffer[micFluxBuffer.length - 1].time - micFluxBuffer[0].time;
        frameRate = (micFluxBuffer.length - 1) / (dt / 1000);
      }

      const result = autocorrelateBPM(micFluxBuffer, frameRate);

      if (result && result.confidence > 0.15) {
        micTempoBPM = result.bpm;
        micTempoConf = result.confidence;

        micBpm.textContent = result.bpm;
        const confPct = Math.round(result.confidence * 100);
        micConfidence.textContent = '置信度 ' + confPct + '%  ·  点击数字应用此节奏';
        micEnergyLabel.textContent = '帧率:' + Math.round(frameRate) + 'fps | 通量: ' + flux.toFixed(3);

        micBpm.style.cursor = 'pointer';
        micBpm.onclick = () => {
          setBPM(result.bpm);
          if (!isPlaying) startMetronome();
        };
      }
    }

    // 7. Draw waveform + flux overlay
    drawMicComposite(timestamp);

    micAnimFrame = requestAnimationFrame(micLoop);
  }

  function drawMicComposite(timestamp) {
    if (!micCtx2d || !micCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = micCanvas.width / dpr;
    const h = micCanvas.height / dpr;
    if (w <= 1 || h <= 1) return;

    micCtx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    micCtx2d.clearRect(0, 0, w, h);

    // ── Draw frequency spectrum bar chart ──
    const barW = w / micDataArray.length;
    const maxBarH = h * 0.5;
    for (let i = 0; i < micDataArray.length; i++) {
      const val = micDataArray[i] / 255;
      const barH = val * maxBarH;
      // Color gradient based on frequency bin
      const hue = 200 + (i / micDataArray.length) * 40; // blue -> purple
      micCtx2d.fillStyle = 'hsla(' + hue + ', 80%, 55%, 0.5)';
      micCtx2d.fillRect(i * barW, maxBarH - barH, Math.max(1, barW - 0.5), barH);
    }

    // ── Draw onset detection function (flux) as a line ──
    if (micFluxCanvasArr.length > 1) {
      micCtx2d.strokeStyle = 'rgba(255,159,10,0.9)';
      micCtx2d.lineWidth = 1.5;
      micCtx2d.shadowColor = 'rgba(255,159,10,0.4)';
      micCtx2d.shadowBlur = 3;
      micCtx2d.beginPath();

      const fluxH = h * 0.4;
      const fluxY = maxBarH + 2;
      const maxFlux = Math.max(0.001, ...micFluxCanvasArr);

      for (let i = 0; i < micFluxCanvasArr.length; i++) {
        const x = (i / micFluxCanvasArr.length) * w;
        const y = fluxY + fluxH - (micFluxCanvasArr[i] / maxFlux) * fluxH;
        if (i === 0) micCtx2d.moveTo(x, y);
        else micCtx2d.lineTo(x, y);
      }
      micCtx2d.stroke();
      micCtx2d.shadowBlur = 0;

      // Label: current flux value
      const lastFlux = micFluxCanvasArr[micFluxCanvasArr.length - 1];
      micCtx2d.fillStyle = 'rgba(255,255,255,0.5)';
      micCtx2d.font = '9px -apple-system, sans-serif';
      micCtx2d.fillText('通量: ' + lastFlux.toFixed(3), 4, h - 4);
    }


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

  // ─── Audio Output Selection ──────────
  outputSelect.addEventListener('change', () => {
    setAudioSink(outputSelect.value);
  });

  // Populate output devices on first user interaction
  document.addEventListener('click', function initDevices() {
    populateOutputDevices();
  }, { once: true });

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
