// Typing Game main logic
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const screens = {
    start: $('#start-screen'),
    play: $('#play-screen'),
    result: $('#result-screen'),
  };

  const ui = {
    // start
    duration: $('#duration-input'),
    wordlist: $('#wordlist-select'),
    caseSensitive: $('#case-sensitive'),
    romajiInput: $('#romaji-input'),
    randomize: $('#randomize'),
    noRepeat: $('#no-repeat'),
    muteToggle: $('#mute-toggle'),
    volume: $('#volume'),
    startBtn: $('#start-button'),
    // play
    timerBar: $('#timer-bar'),
    timerLabel: $('#timer-label'),
    statCorrect: $('#stat-correct'),
    statTotal: $('#stat-total'),
    statAcc: $('#stat-acc'),
    statWords: $('#stat-words'),
    statCombo: $('#stat-combo'),
    wordArea: $('#word-area'),
    typingInput: $('#typing-input'),
    muteBtn: $('#mute-button'),
    quitBtn: $('#quit-button'),
    // result
    resScore: $('#res-score'),
    resCPM: $('#res-cpm'),
    resWPM: $('#res-wpm'),
    resAcc: $('#res-acc'),
    resWords: $('#res-words'),
    resHigh: $('#res-high'),
    resMistakes: $('#res-mistakes'),
    resTopList: $('#res-toplist'),
    retryBtn: $('#retry-button'),
    backBtn: $('#back-button'),
    // misc
    srLive: $('#sr-live'),
  };

  // Persistent keys
  const LS_KEY = 'typing_game_settings_v1';
  const HS_KEY_PREFIX = 'typing_game_highscore_'; // + duration
  const LB_KEY_PREFIX = 'typing_game_leaderboard_'; // + duration

  // State
  const state = {
    status: 'idle', // idle|playing|paused|result
    config: null,
    wordsAll: [],
    wordsPool: [],
    usedIdx: new Set(),
    seqIndex: 0,
    displayWord: '',
    currentWord: '',
    typed: '',
    correctKeystrokes: 0,
    totalKeystrokes: 0,
    successWords: 0,
    combo: 0,
    startTime: 0,
    durationMs: 15000,
    prevRemMs: 15000,
    rafId: 0,
    audio: null,
    mistakes: Object.create(null),
  };

  // Built-in defaults to survive missing config.json (e.g., file://)
  const DEFAULT_CONFIG = {
    gameDurationSeconds: 15,
    wordLists: [{ name: 'Default', path: 'assets/words/default.txt' }],
    randomize: true,
    romajiInput: true,
    noRepeatInSession: false,
    caseSensitive: false,
    minWordLength: 1,
    maxWordLength: 32,
    comboBonus: false,
    errorFlashMs: 150,
    successAnimMs: 200,
    sound: { enabled: true, volume: 0.6 },
  };

  // Utilities
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function now() { return performance.now(); }
  function fmtPct(v) { return `${(v * 100).toFixed(1)}%`; }

  function readQueryOverrides() {
    const q = new URLSearchParams(location.search);
    const o = {};
    if (q.has('t')) o.gameDurationSeconds = clamp(parseInt(q.get('t'), 10) || 15, 1, 600);
    if (q.has('list')) o.wordListPath = q.get('list');
    return o;
  }

  async function loadConfig() {
    let base = {};
    try {
      const res = await fetch('config.json');
      if (res.ok) {
        base = await res.json();
      } else {
        console.warn('config.json fetch failed with status', res.status);
      }
    } catch (e) {
      console.warn('config.json fetch error (likely file://):', e);
    }
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { saved = {}; }
    const query = readQueryOverrides();
    const merged = { ...DEFAULT_CONFIG, ...base, ...saved, ...query };
    // Guarantee at least one word list
    if (!Array.isArray(merged.wordLists) || merged.wordLists.length === 0) {
      const path = merged.wordListPath || 'assets/words/default.txt';
      merged.wordLists = [{ name: 'Default', path }];
      merged.wordListPath = path;
    }
    return merged;
  }

  function saveSettings(partial) {
    const prev = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const next = { ...prev, ...partial };
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  }

  function populateWordLists(cfg) {
    ui.wordlist.innerHTML = '';
    let lists = Array.isArray(cfg.wordLists) ? cfg.wordLists.filter(Boolean) : [];
    if (!lists.length) {
      const fallbackPath = cfg.wordListPath || 'assets/words/default.txt';
      console.warn('wordLists not found in config. Falling back to:', fallbackPath);
      lists = [{ name: 'Default', path: fallbackPath }];
      // keep cfg consistent in-session
      cfg.wordLists = lists;
    }
    lists.forEach((wl) => {
      const opt = document.createElement('option');
      opt.value = wl.path;
      opt.textContent = wl.name || wl.path;
      ui.wordlist.appendChild(opt);
    });
    const target = cfg.wordListPath || lists[0]?.path;
    if (target) ui.wordlist.value = target;
    // If the saved target doesn't exist in options, fall back to first
    if (ui.wordlist.value !== (target || '')) {
      const first = lists[0]?.path;
      if (first) ui.wordlist.value = first;
    }
  }

  function applySettingsToUI(cfg) {
    ui.duration.value = cfg.gameDurationSeconds;
    populateWordLists(cfg);
    ui.caseSensitive.checked = !!cfg.caseSensitive;
    ui.romajiInput.checked = !!cfg.romajiInput;
    ui.randomize.checked = !!cfg.randomize;
    ui.noRepeat.checked = !!cfg.noRepeatInSession;
    ui.muteToggle.checked = !cfg.sound?.enabled;
    ui.volume.value = cfg.sound?.volume ?? 0.6;
  }

  async function loadWords(path, cfg) {
    try {
      const res = await fetch(path);
      const text = await res.text();
      let words = text.split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      words = words.filter((w) => w.length >= (cfg.minWordLength||1) && w.length <= (cfg.maxWordLength||32));
      return words;
    } catch (e) {
      console.warn('Failed to load words:', e);
      return ['fallback', 'typing', 'game'];
    }
  }

  // Kana to Romaji conversion (simple Hepburn-like)
  const DIGRAPHS = {
    'きゃ':'kya','きゅ':'kyu','きょ':'kyo','ぎゃ':'gya','ぎゅ':'gyu','ぎょ':'gyo',
    'しゃ':'sha','しゅ':'shu','しょ':'sho','じゃ':'ja','じゅ':'ju','じょ':'jo',
    'ちゃ':'cha','ちゅ':'chu','ちょ':'cho','にゃ':'nya','にゅ':'nyu','にょ':'nyo',
    'ひゃ':'hya','ひゅ':'hyu','ひょ':'hyo','びゃ':'bya','びゅ':'byu','びょ':'byo',
    'ぴゃ':'pya','ぴゅ':'pyu','ぴょ':'pyo','みゃ':'mya','みゅ':'myu','みょ':'myo',
    'りゃ':'rya','りゅ':'ryu','りょ':'ryo',
    'キャ':'kya','キュ':'kyu','キョ':'kyo','ギャ':'gya','ギュ':'gyu','ギョ':'gyo',
    'シャ':'sha','シュ':'shu','ショ':'sho','ジャ':'ja','ジュ':'ju','ジョ':'jo',
    'チャ':'cha','チュ':'chu','チョ':'cho','ニャ':'nya','ニュ':'nyu','ニョ':'nyo',
    'ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo','ビャ':'bya','ビュ':'byu','ビョ':'byo',
    'ピャ':'pya','ピュ':'pyu','ピョ':'pyo','ミャ':'mya','ミュ':'myu','ミョ':'myo',
    'リャ':'rya','リュ':'ryu','リョ':'ryo'
  };
  const KANA_MAP = {
    'あ':'a','い':'i','う':'u','え':'e','お':'o','ア':'a','イ':'i','ウ':'u','エ':'e','オ':'o',
    'か':'ka','き':'ki','く':'ku','け':'ke','こ':'ko','カ':'ka','キ':'ki','ク':'ku','ケ':'ke','コ':'ko',
    'さ':'sa','し':'shi','す':'su','せ':'se','そ':'so','サ':'sa','シ':'shi','ス':'su','セ':'se','ソ':'so',
    'た':'ta','ち':'chi','つ':'tsu','て':'te','と':'to','タ':'ta','チ':'chi','ツ':'tsu','テ':'te','ト':'to',
    'な':'na','に':'ni','ぬ':'nu','ね':'ne','の':'no','ナ':'na','ニ':'ni','ヌ':'nu','ネ':'ne','ノ':'no',
    'は':'ha','ひ':'hi','ふ':'fu','へ':'he','ほ':'ho','ハ':'ha','ヒ':'hi','フ':'fu','ヘ':'he','ホ':'ho',
    'ま':'ma','み':'mi','む':'mu','め':'me','も':'mo','マ':'ma','ミ':'mi','ム':'mu','メ':'me','モ':'mo',
    'や':'ya','ゆ':'yu','よ':'yo','ヤ':'ya','ユ':'yu','ヨ':'yo',
    'ら':'ra','り':'ri','る':'ru','れ':'re','ろ':'ro','ラ':'ra','リ':'ri','ル':'ru','レ':'re','ロ':'ro',
    'わ':'wa','を':'o','ん':'n','ワ':'wa','ヲ':'o','ン':'n',
    'が':'ga','ぎ':'gi','ぐ':'gu','げ':'ge','ご':'go','ガ':'ga','ギ':'gi','グ':'gu','ゲ':'ge','ゴ':'go',
    'ざ':'za','じ':'ji','ず':'zu','ぜ':'ze','ぞ':'zo','ザ':'za','ジ':'ji','ズ':'zu','ゼ':'ze','ゾ':'zo',
    'だ':'da','ぢ':'ji','づ':'zu','で':'de','ど':'do','ダ':'da','ヂ':'ji','ヅ':'zu','デ':'de','ド':'do',
    'ば':'ba','び':'bi','ぶ':'bu','べ':'be','ぼ':'bo','バ':'ba','ビ':'bi','ブ':'bu','ベ':'be','ボ':'bo',
    'ぱ':'pa','ぴ':'pi','ぷ':'pu','ぺ':'pe','ぽ':'po','パ':'pa','ピ':'pi','プ':'pu','ペ':'pe','ポ':'po',
    'ゔ':'vu','ヴ':'vu'
  };
  function kanaToRomaji(s) {
    if (!s) return '';
    if (!/[ぁ-ゟ゠-ヿ]/.test(s)) return s; // no kana
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const a = s[i];
      const b = s[i+1] || '';
      const pair = a + b;
      if (DIGRAPHS[pair]) { out += DIGRAPHS[pair]; i++; continue; }
      if (a === 'っ' || a === 'ッ') {
        const next = s[i+1] || '';
        const r = DIGRAPHS[next + (s[i+2]||'')] || KANA_MAP[next] || '';
        out += r ? r[0] : '';
        continue;
      }
      if (a === 'ー') {
        const last = out[out.length-1] || '';
        if ('aiueo'.includes(last)) out += last;
        continue;
      }
      out += KANA_MAP[a] || a;
    }
    return out;
  }
  function buildInputTarget(word, cfg) { return cfg.romajiInput ? kanaToRomaji(word) : word; }

  function pickNextWord(cfg) {
    if (!state.wordsPool.length) return '';
    if (cfg.randomize) {
      // random with optional no repeat
      if (cfg.noRepeatInSession && state.usedIdx.size >= state.wordsPool.length) {
        state.usedIdx.clear();
      }
      let idx = 0;
      let guard = 0;
      do {
        idx = Math.floor(Math.random() * state.wordsPool.length);
        guard++;
        if (guard > 1000) break;
      } while (cfg.noRepeatInSession && state.usedIdx.has(idx));
      state.usedIdx.add(idx);
      return state.wordsPool[idx];
    } else {
      // Sequential order without repetition; independent of usedIdx
      const idx = state.seqIndex % state.wordsPool.length;
      state.seqIndex = (state.seqIndex + 1) % state.wordsPool.length;
      return state.wordsPool[idx];
    }
  }

  function renderWord(word, typedLen, errorAt) {
    const frag = document.createDocumentFragment();
    if (state.displayWord && state.displayWord !== state.currentWord) {
      const stack = document.createElement('div');
      stack.className = 'word-stack';
      const jp = document.createElement('div');
      jp.className = 'jp-word';
      jp.textContent = state.displayWord;
      const rom = document.createElement('div');
      rom.className = 'romaji-line';
      for (let i = 0; i < word.length; i++) {
        const span = document.createElement('span');
        span.className = 'char';
        span.textContent = word[i];
        if (i < typedLen) span.classList.add('correct');
        else span.classList.add('pending');
        if (errorAt === i) { span.classList.remove('pending'); span.classList.add('expected'); }
        rom.appendChild(span);
      }
      stack.appendChild(jp);
      stack.appendChild(rom);
      frag.appendChild(stack);
    } else {
      for (let i = 0; i < word.length; i++) {
        const span = document.createElement('span');
        span.className = 'char';
        span.textContent = word[i];
        if (i < typedLen) span.classList.add('correct');
        else span.classList.add('pending');
        if (errorAt === i) { span.classList.remove('pending'); span.classList.add('expected'); }
        frag.appendChild(span);
      }
    }
    ui.wordArea.replaceChildren(frag);
  }

  function setScreen(which) {
    Object.values(screens).forEach((el) => el.classList.add('hidden'));
    screens[which].classList.remove('hidden');
  }

  function accuracy() {
    if (state.totalKeystrokes === 0) return 1;
    return state.correctKeystrokes / state.totalKeystrokes;
  }

  function updateStatsUI() {
    ui.statCorrect.textContent = String(state.correctKeystrokes);
    ui.statTotal.textContent = String(state.totalKeystrokes);
    ui.statAcc.textContent = fmtPct(accuracy());
    ui.statWords.textContent = String(state.successWords);
    ui.statCombo.textContent = String(state.combo);
  }

  function updateTimerUI(remMs) {
    const total = state.durationMs;
    // Ensure the displayed remaining time never increases due to rounding/jitter
    const safeRem = Math.min(remMs, state.prevRemMs);
    state.prevRemMs = safeRem;
    const ratio = clamp(safeRem / total, 0, 1);
    ui.timerBar.style.transform = `scaleX(${ratio})`;
    const secs = (safeRem / 1000).toFixed(1);
    ui.timerLabel.textContent = secs;
    if (safeRem <= 5000 && safeRem > 2000) {
      ui.timerBar.style.background = 'var(--timer-warn)';
    } else if (safeRem <= 2000) {
      ui.timerBar.style.background = 'var(--timer-crit)';
    } else {
      ui.timerBar.style.background = 'var(--timer)';
    }
  }

  function endGame() {
    state.status = 'result';
    cancelAnimationFrame(state.rafId);
    ui.typingInput.blur();
    setScreen('result');
    const elapsedMin = state.durationMs / 60000;
    const cpm = Math.round(state.correctKeystrokes / elapsedMin);
    const wpm = Math.round(state.correctKeystrokes / 5 / elapsedMin);
    ui.resScore.textContent = String(state.correctKeystrokes);
    ui.resCPM.textContent = String(cpm);
    ui.resWPM.textContent = String(wpm);
    ui.resAcc.textContent = fmtPct(accuracy());
    ui.resWords.textContent = String(state.successWords);
    const hsKey = HS_KEY_PREFIX + Math.round(state.durationMs / 1000);
    const prev = parseInt(localStorage.getItem(hsKey) || '0', 10);
    const best = Math.max(prev, state.correctKeystrokes);
    localStorage.setItem(hsKey, String(best));
    ui.resHigh.textContent = String(best);
    // Mistakes summary
    const list = Object.entries(state.mistakes)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 10)
      .map(([k,c]) => `${k}: ${c}`)
      .join(' / ');
    if (ui.resMistakes) ui.resMistakes.textContent = list ? `ミスキー上位: ${list}` : 'ミスなし！';
    // Leaderboard
    try {
      updateLeaderboard({
        score: state.correctKeystrokes,
        acc: accuracy(),
        words: state.successWords,
        duration: Math.round(state.durationMs/1000),
      });
      renderLeaderboard(Math.round(state.durationMs/1000));
    } catch (e) { console.warn('leaderboard error', e); }
    // Celebration
    try { state.audio && state.audio.applause(); } catch {}
    try { launchConfetti(); } catch {}
  }

  function loop() {
    const elapsed = now() - state.startTime;
    const rem = state.durationMs - elapsed;
    updateTimerUI(rem);
    if (rem <= 0) {
      endGame();
      return;
    }
    state.rafId = requestAnimationFrame(loop);
  }

  function normalizeChar(ch, cfg) {
    return cfg.caseSensitive ? ch : ch.toLowerCase();
  }

  function expectChar(cfg) {
    const idx = state.typed.length;
    return normalizeChar(state.currentWord[idx] || '', cfg);
  }

  function playSuccess() { state.audio && state.audio.success(); }
  function playError() { state.audio && state.audio.error(); }

  function flashError() {
    ui.wordArea.classList.remove('flash', 'shake');
    // force reflow
    void ui.wordArea.offsetWidth;
    ui.wordArea.classList.add('flash', 'shake');
  }

  function onPrintableKey(e) {
    if (e.key.length !== 1) return false;
    // Ignore when IME composing
    if (e.isComposing) return false;
    return true;
  }

  function handleKeyDown(e, cfg) {
    if (state.status !== 'playing') return;
    if (e.key === 'Escape') {
      // optional pause: for simplicity, end game to settings
      e.preventDefault();
      endGame();
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      state.typed = state.typed.slice(0, -1);
      ui.typingInput.value = state.typed;
      renderWord(state.currentWord, state.typed.length, state.typed.length);
      return;
    }

    if (!onPrintableKey(e)) return;

    e.preventDefault();
    const ch = e.key;
    const exp = expectChar(cfg);
    state.totalKeystrokes += 1;
    if (normalizeChar(ch, cfg) === exp && exp) {
      state.correctKeystrokes += 1;
      state.typed += state.currentWord[state.typed.length]; // keep original casing
      ui.typingInput.value = state.typed;
      renderWord(state.currentWord, state.typed.length, state.typed.length);
      updateStatsUI();
      if (state.typed.length === state.currentWord.length) {
        // success
        state.successWords += 1;
        state.combo += 1;
        updateStatsUI();
        successAnimation();
        playSuccess();
        nextWord(cfg);
      }
    } else {
      // wrong
      state.combo = 0;
      state.mistakes[ch] = (state.mistakes[ch] || 0) + 1;
      updateStatsUI();
      playError();
      flashError();
      renderWord(state.currentWord, state.typed.length, state.typed.length);
    }
  }

  function successAnimation() {
    const ghost = document.createElement('div');
    ghost.className = 'success-pop';
    ghost.textContent = '✔';
    ghost.style.position = 'absolute';
    const rect = ui.wordArea.getBoundingClientRect();
    ghost.style.left = rect.left + rect.width / 2 + 'px';
    ghost.style.top = rect.top + 'px';
    document.body.appendChild(ghost);
    setTimeout(() => ghost.remove(), 200);
  }

  function nextWord(cfg) {
    state.displayWord = pickNextWord(cfg) || '';
    state.currentWord = buildInputTarget(state.displayWord, cfg) || '';
    state.typed = '';
    renderWord(state.currentWord, 0, 0);
    ui.typingInput.value = '';
    document.dispatchEvent(new Event('wordChanged'));
  }

  function startGame(cfg) {
    state.status = 'playing';
    state.correctKeystrokes = 0;
    state.totalKeystrokes = 0;
    state.successWords = 0;
    state.combo = 0;
    state.usedIdx.clear();
    state.seqIndex = 0;
    state.durationMs = (parseInt(ui.duration.value, 10) || cfg.gameDurationSeconds) * 1000;
    state.prevRemMs = state.durationMs;
    state.mistakes = Object.create(null);
    setScreen('play');
    updateStatsUI();
    nextWord(cfg);
    state.startTime = now();
    cancelAnimationFrame(state.rafId);
    loop();
    ui.typingInput.focus();
  }

  // Audio: simple WebAudio-generated blips (no external assets required)
  function createAudio() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const vol = ctx.createGain();
    vol.gain.value = 0.0; // will be set by UI
    vol.connect(ctx.destination);

    const stateAudio = { muted: false, volume: 0.6 };

    function beep(freq = 660, durMs = 120, type = 'sine') {
      if (stateAudio.muted) return;
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = stateAudio.volume;
      osc.connect(g); g.connect(vol);
      osc.start();
      g.gain.setValueAtTime(stateAudio.volume, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + durMs / 1000);
      osc.stop(t0 + durMs / 1000 + 0.01);
    }

    function applause() {
      if (stateAudio.muted) return;
      const t0 = ctx.currentTime;
      const dur = 1.2;
      const bufferSize = Math.floor(ctx.sampleRate * dur);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random()*2 - 1) * 0.6;
      const src = ctx.createBufferSource();
      const g = ctx.createGain();
      src.buffer = buffer;
      g.gain.value = 0;
      src.connect(g); g.connect(vol);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(stateAudio.volume, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.1);
      src.start();
      src.stop(t0 + dur + 0.05);
    }

    return {
      success() { beep(880, 120, 'triangle'); },
      error() { beep(180, 80, 'square'); },
      applause,
      setMuted(m) { stateAudio.muted = m; },
      setVolume(v) { stateAudio.volume = clamp(v, 0, 1); vol.gain.value = 1.0; },
      resume() { ctx.resume?.(); },
    };
  }

  function bindUI(cfg) {
    ui.startBtn.addEventListener('click', () => {
      saveSettings({
        gameDurationSeconds: parseInt(ui.duration.value, 10) || cfg.gameDurationSeconds,
        wordListPath: ui.wordlist.value,
        caseSensitive: ui.caseSensitive.checked,
        romajiInput: ui.romajiInput.checked,
        randomize: ui.randomize.checked,
        noRepeatInSession: ui.noRepeat.checked,
        sound: { enabled: !ui.muteToggle.checked, volume: parseFloat(ui.volume.value) }
      });
      cfg.gameDurationSeconds = parseInt(ui.duration.value, 10) || cfg.gameDurationSeconds;
      cfg.wordListPath = ui.wordlist.value;
      cfg.caseSensitive = ui.caseSensitive.checked;
      cfg.romajiInput = ui.romajiInput.checked;
      cfg.randomize = ui.randomize.checked;
      cfg.noRepeatInSession = ui.noRepeat.checked;
      cfg.sound = { enabled: !ui.muteToggle.checked, volume: parseFloat(ui.volume.value) };
      startWithConfig(cfg);
    });

    ui.retryBtn.addEventListener('click', () => startWithConfig(state.config));
    ui.backBtn.addEventListener('click', () => { setScreen('start'); });
    ui.quitBtn.addEventListener('click', () => { endGame(); setScreen('start'); });

    // Global keybinds
    window.addEventListener('keydown', (e) => {
      if (state.status === 'idle' && (e.key === 'Enter')) {
        e.preventDefault();
        ui.startBtn.click();
      } else if (state.status === 'result' && (e.key === 'Enter')) {
        e.preventDefault();
        ui.retryBtn.click();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        ui.muteToggle.checked = !ui.muteToggle.checked;
        const muted = ui.muteToggle.checked;
        state.audio.setMuted(muted);
        ui.muteBtn.textContent = muted ? '🔇' : '🔊';
        saveSettings({ sound: { enabled: !muted, volume: parseFloat(ui.volume.value) } });
      }
    });

    // typing logic on keydown for precise control
    ui.typingInput.addEventListener('keydown', (e) => handleKeyDown(e, state.config));

    // mute/volume
    function applyAudioSettings() {
      const muted = ui.muteToggle.checked;
      const vol = parseFloat(ui.volume.value);
      state.audio.setMuted(muted);
      state.audio.setVolume(vol);
      ui.muteBtn.textContent = muted ? '🔇' : '🔊';
    }
    ui.muteToggle.addEventListener('change', () => { applyAudioSettings(); saveSettings({ sound: { enabled: !ui.muteToggle.checked, volume: parseFloat(ui.volume.value) } }); });
    ui.volume.addEventListener('input', () => { applyAudioSettings(); saveSettings({ sound: { enabled: !ui.muteToggle.checked, volume: parseFloat(ui.volume.value) } }); });
    ui.muteBtn.addEventListener('click', () => { ui.muteToggle.checked = !ui.muteToggle.checked; applyAudioSettings(); });

    // Accessibility live updates
    const live = ui.srLive;
    const announce = (msg) => { live.textContent = msg; };
    document.addEventListener('wordChanged', (e) => announce(`次の単語: ${state.displayWord || state.currentWord}`));
  }

  async function startWithConfig(cfg) {
    // words
    state.config = cfg;
    setScreen('play');
    state.wordsAll = await loadWords(cfg.wordListPath || cfg.wordLists?.[0]?.path, cfg);
    state.wordsPool = [...state.wordsAll];
    // audio
    if (!state.audio) state.audio = createAudio();
    state.audio.setMuted(!cfg.sound?.enabled);
    state.audio.setVolume(cfg.sound?.volume ?? 0.6);
    ui.muteToggle.checked = !cfg.sound?.enabled;
    ui.volume.value = cfg.sound?.volume ?? 0.6;
    // start
    startGame(cfg);
  }

  // --- Leaderboard (Top 3 per duration) ---
  function lbKeyFor(durationSec) { return LB_KEY_PREFIX + String(durationSec); }
  function loadLeaderboard(durationSec) {
    try { return JSON.parse(localStorage.getItem(lbKeyFor(durationSec)) || '[]') || []; } catch { return []; }
  }
  function saveLeaderboard(durationSec, arr) {
    localStorage.setItem(lbKeyFor(durationSec), JSON.stringify(arr));
  }
  function cmpEntry(a, b) {
    if (b.score !== a.score) return b.score - a.score; // higher score first
    if (b.acc !== a.acc) return b.acc - a.acc;         // then higher accuracy
    return (a.ts||0) - (b.ts||0);                      // then older first
  }
  function renderLeaderboard(durationSec) {
    const list = loadLeaderboard(durationSec).slice(0, 3);
    if (!ui.resTopList) return;
    ui.resTopList.innerHTML = '';
    list.forEach((e, i) => {
      const li = document.createElement('li');
      const name = e.name || '名無し';
      li.textContent = `${i+1}. ${name} — ${e.score}（精度 ${fmtPct(e.acc||0)}）`;
      ui.resTopList.appendChild(li);
    });
  }
  function updateLeaderboard(run) {
    const d = run.duration;
    const arr = loadLeaderboard(d);
    const entry = { name: '', score: run.score, acc: run.acc, words: run.words, ts: Date.now() };
    // Provisional insert and sort
    arr.push(entry);
    arr.sort(cmpEntry);
    const idx = arr.indexOf(entry);
    if (idx < 3) {
      let name = '';
      try { name = prompt('ベスト3入り！名前を入力してください（10文字まで）：') || ''; } catch {}
      name = String(name).trim().slice(0, 10) || 'Player';
      entry.name = name;
    }
    // Keep only top 3
    const top = arr.slice(0, 3);
    saveLeaderboard(d, top);
  }

  // Simple confetti burst animation
  function launchConfetti() {
    const colors = ['#ff7675','#74b9ff','#55efc4','#ffeaa7','#a29bfe','#fd79a8'];
    const N = 150;
    const frag = document.createDocumentFragment();
    const pieces = [];
    for (let i = 0; i < N; i++) {
      const el = document.createElement('div');
      el.style.position = 'fixed';
      el.style.top = '-10px';
      el.style.left = Math.random()*100 + 'vw';
      el.style.width = '8px';
      el.style.height = '12px';
      el.style.background = colors[i % colors.length];
      el.style.opacity = '0.9';
      el.style.transform = `rotate(${Math.random()*360}deg)`;
      el.style.transition = 'transform 2s linear, top 2s linear, opacity 2s';
      frag.appendChild(el);
      pieces.push(el);
    }
    document.body.appendChild(frag);
    requestAnimationFrame(() => {
      pieces.forEach((el) => {
        const fall = 100 + Math.random()*20;
        const rot = 720 + Math.random()*720;
        el.style.top = fall + 'vh';
        el.style.transform = `rotate(${rot}deg)`;
        el.style.opacity = '0';
      });
      setTimeout(() => pieces.forEach((el) => el.remove()), 2200);
    });
  }

  async function init() {
    const cfg = await loadConfig();
    state.config = cfg;
    applySettingsToUI(cfg);
    bindUI(cfg);
    setScreen('start');
  }

  window.addEventListener('load', init);
})();
