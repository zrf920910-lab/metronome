// ===========================
// Smart Metronome PWA
// ===========================

(function () {
  'use strict';

  // ─── DOM Refs ──────────────────────────
  const bpmValue    = document.getElementById('bpmValue');
  const bpmSlider   = document.getElementById('bpmSlider');
  const pendulumArm  = document.getElementById('pendulumArm');
  const pendulumWeight=document.getElementById('pendulumWeight');
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

  // Pendulum state
  let pendulumAngle = 0;
  let pendulumTargetAngle = 0;
  let pendulumLastBeatTime = 0;
  let pendulumBeatDuration = 1;       // seconds per half-swing (one beat)
  let pendulumSwingDirection = 1;     // 1=right, -1=left
  let pendulumAnimFrame = null;
  const PENDULUM_MAX_ANGLE = 22;      // degrees

  // Tap tempo state
  let tapTimes = [];
  const TAP_WINDOW_MS = 2000;
  const TAP_MIN_COUNT = 3;

  // Mic state
  let micDataArray = null;

  // ─── Audio Engine ──────────────────────
  let audioCtx = null;

  function getAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // ─── Tick Sound (for slider detent feel) ──
  let _tickBuf = null;
  function getTickBuf() {
    if (!_tickBuf) {
      const c = getAudioCtx();
      const sr = c.sampleRate;
      const len = Math.floor(sr * 0.05);
      const buf = c.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        // Mechanical switch click: sharp attack + ring
        d[i] = (Math.sin(2*Math.PI*2800*t)*0.7 + Math.sin(2*Math.PI*4200*t)*0.3
               + (Math.random()*2-1)*0.1) * Math.exp(-t*180);
      }
      _tickBuf = buf;
    }
    return _tickBuf;
  }

  let _tickReady = false;
  async function playTick() {
    try {
      const c = getAudioCtx();
      if (c.state === 'suspended') await c.resume();
      const src = c.createBufferSource();
      src.buffer = getTickBuf();
      const g = c.createGain();
      g.gain.setValueAtTime(0.5, c.currentTime);
      src.connect(g); g.connect(c.destination);
      src.start(c.currentTime);
      src.stop(c.currentTime + 0.06);
    } catch(e) {}
  }

  // Warm up tick buffer on first interaction
  function warmTick() { getTickBuf(); playTick(); document.removeEventListener('click', warmTick); }
  document.addEventListener('click', warmTick, { once: true });

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
    onBeatFire(beatNum);
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

    // Init pendulum
    pendulumLastBeatTime = ctx.currentTime;
    pendulumBeatDuration = 60.0 / bpm;
    pendulumSwingDirection = -1; // start swinging right
    pendulumAngle = -PENDULUM_MAX_ANGLE;
    updatePendulumAngle();

    scheduler();
    if (!pendulumAnimFrame) {
      pendulumAnimFrame = requestAnimationFrame(pendulumLoop);
    }
  }

  function stopMetronome() {
    isPlaying = false;
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
    resetBeatUI();
    updatePlayUI();
    // Pendulum will slow-return to center via pendulumLoop
    if (!pendulumAnimFrame) {
      pendulumAnimFrame = requestAnimationFrame(pendulumLoop);
    }
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
  let sliderLastVal = 120;
  let sliderTickTimer = 0;
  let tickAnimTimer = null;

  function flashSliderTick() {
    bpmSlider.classList.add('ticking');
    clearTimeout(tickAnimTimer);
    tickAnimTimer = setTimeout(() => bpmSlider.classList.remove('ticking'), 80);
  }

  bpmSlider.addEventListener('input', () => {
    const val = parseInt(bpmSlider.value);
    setBPM(val);
    // Tick on each BPM integer change
    if (val !== sliderLastVal) {
      sliderLastVal = val;
      playTick();
      flashSliderTick();
      if (navigator.vibrate) { try { navigator.vibrate(6); } catch(e) {} }
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

  // ─── Pendulum Animation ───────────────
  function updatePendulumAngle() {
    if (!pendulumArm) return;
    pendulumArm.style.transform = 'rotate(' + pendulumAngle.toFixed(2) + 'deg)';
  }

  function pendulumLoop() {
    if (!isPlaying || !audioCtx) {
      // Slow return to center when stopped
      if (Math.abs(pendulumAngle) > 0.1) {
        pendulumAngle *= 0.85;
        updatePendulumAngle();
        pendulumAnimFrame = requestAnimationFrame(pendulumLoop);
      } else {
        pendulumAngle = 0;
        updatePendulumAngle();
        pendulumAnimFrame = null;
      }
      return;
    }

    const now = audioCtx.currentTime;

    // Calculate swing based on time since last beat
    const elapsed = now - pendulumLastBeatTime;
    const progress = Math.min(1, elapsed / pendulumBeatDuration);

    // Natural pendulum: cos curve. At progress=0 (beat), angle is at extreme.
    // As progress goes 0→1, swing from one extreme to the other
    const swingAngle = PENDULUM_MAX_ANGLE * Math.cos(Math.PI * progress);

    pendulumAngle = pendulumSwingDirection * swingAngle;
    updatePendulumAngle();

    pendulumAnimFrame = requestAnimationFrame(pendulumLoop);
  }

  // Called by scheduler when a beat fires
  function onBeatFire(beatIndex) {
    // Flash weight
    if (pendulumWeight) {
      pendulumWeight.classList.add('beat-hit');
      setTimeout(() => pendulumWeight.classList.remove('beat-hit'), 80);
    }

    // Reverse swing direction at each beat
    pendulumSwingDirection *= -1;
    pendulumLastBeatTime = audioCtx.currentTime;
    pendulumBeatDuration = 60.0 / bpm;

    // Start pendulum loop if not running
    if (!pendulumAnimFrame) {
      pendulumAnimFrame = requestAnimationFrame(pendulumLoop);
    }
  }

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
