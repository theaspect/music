// Interactive players for the book: falling notes onto a drum kit or a piano keyboard.
// Markup (inside a chapter):
//   <div class="player" data-kind="drums" data-bpm="70" data-steps="8"
//        data-rows="hh:RRRRRRRR;sn:..L...L.;kk:x...x..."></div>
//   <div class="player" data-kind="piano" data-bpm="90" data-range="до4-ми5"
//        data-notes="до4 до4 соль4 соль4 ля4 ля4 соль4:2"></div>
// On GitHub's own Markdown view scripts do not run, the div stays empty and the PNG above it remains.
// Modes: "Слушать" plays the pattern; "Играть" keeps it silent and judges the reader's hits, which come from
// taps on the canvas, the computer keyboard (by physical key, so any layout works) or a MIDI kit/keyboard.
(function () {
  "use strict";

  const BEATS_VISIBLE = 4; // how far ahead the falling notes are shown, in beats
  const LOOKAHEAD = 0.12; // seconds of audio scheduled ahead of the clock
  const IDLE = -0.5; // position shown while stopped: the first bar waits just above the hit line
  const COLORS = { right: "#2f72c9", left: "#e0892b", foot: "#555b66", pad: "#cfe0f7", cymbal: "#eef3fb",
                   line: "#c9c9c0", text: "#111", muted: "#666", flash: "#ffd166", bg: "#fafaf7", good: "#2a9d4b", bad: "#d64545" };

  // Rows follow the kit diagram in 3.4 (top: crash, tom, ride; bottom: hi-hat, snare, tom, floor tom) in a 760 × 250 box
  // where every pad and pedal has a column of its own, so lanes never overlap. Pedals are narrow upright
  // rectangles (x, y = top centre), which fit into the bottom row between the pads.
  const KIT = {
    cr: { name: "Крэш", x: 168, y: 70, r: 38, cymbal: true, hand: "right" },
    t1: { name: "Том 1", short: "Том 1 (выс.)", x: 380, y: 70, r: 38, hand: "right" },
    rd: { name: "Райд", x: 592, y: 70, r: 38, cymbal: true, hand: "right" },
    hh: { name: "Хай-хэт", short: "Хэт", x: 100, y: 178, r: 38, cymbal: true, hand: "right" },
    oh: { name: "Хай-хэт", x: 100, y: 178, r: 38, cymbal: true, hand: "right", pad: "hh" },
    sn: { name: "Малый", x: 305, y: 178, r: 38, hand: "left" },
    t2: { name: "Том 2", short: "Том 2 (сред.)", x: 455, y: 178, r: 38, hand: "right" },
    ft: { name: "Напольный", short: "Нап.", x: 660, y: 178, r: 38, hand: "right" },
    hp: { name: "Хэт", x: 235, y: 148, pedal: true },
    kk: { name: "Бочка", x: 525, y: 148, pedal: true },
  };

  // Computer keys by KeyboardEvent.code. Drums follow the kit rows; piano is the usual A-row layout from the lowest до.
  const DRUM_KEYS = { KeyQ: "cr", KeyW: "t1", KeyE: "rd", KeyA: "hh", KeyZ: "hp", KeyS: "sn", KeyD: "t2", Space: "kk", KeyF: "ft" };
  const KEY_LABELS = { KeyQ: "Q", KeyW: "W", KeyE: "E", KeyA: "A", KeyZ: "Z", KeyS: "S", KeyD: "D", Space: "␣", KeyF: "F",
                       KeyT: "T", KeyG: "G", KeyY: "Y", KeyH: "H", KeyU: "U", KeyJ: "J", KeyK: "K", KeyO: "O", KeyL: "L",
                       KeyP: "P", Semicolon: ";", Quote: "'" };
  const PIANO_KEYS = ["KeyA", "KeyW", "KeyS", "KeyE", "KeyD", "KeyF", "KeyT", "KeyG", "KeyY", "KeyH", "KeyU", "KeyJ",
                      "KeyK", "KeyO", "KeyL", "KeyP", "Semicolon", "Quote"];
  // General MIDI drum notes, which electronic kits send over USB.
  const GM_DRUMS = { 35: "kk", 36: "kk", 37: "sn", 38: "sn", 40: "sn", 42: "hh", 44: "hp", 46: "oh", 41: "ft", 43: "ft",
                     45: "t2", 47: "t2", 48: "t1", 50: "t1", 49: "cr", 52: "cr", 55: "cr", 57: "cr", 51: "rd", 53: "rd", 59: "rd" };

  // ---------- audio ----------
  let ctx = null;
  let noise = null;
  function audio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function envGain(t, peak, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    g.connect(ctx.destination);
    return g;
  }
  function tone(t, f0, f1, decay, peak, type) {
    const o = ctx.createOscillator();
    o.type = type || "sine";
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + decay * 0.8);
    o.connect(envGain(t, peak, decay));
    o.start(t);
    o.stop(t + decay + 0.05);
  }
  function hiss(t, decay, peak, filter, freq) {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    s.connect(f);
    f.connect(envGain(t, peak, decay));
    s.start(t);
    s.stop(t + decay + 0.05);
  }
  const DRUM_SOUND = {
    kk: (t) => tone(t, 150, 45, 0.35, 0.9),
    sn: (t) => { tone(t, 220, 160, 0.12, 0.4, "triangle"); hiss(t, 0.18, 0.5, "highpass", 1500); },
    hh: (t) => hiss(t, 0.05, 0.25, "highpass", 7000),
    oh: (t) => hiss(t, 0.35, 0.22, "highpass", 6500),
    hp: (t) => hiss(t, 0.04, 0.18, "bandpass", 5000),
    t1: (t) => tone(t, 200, 140, 0.3, 0.6),
    t2: (t) => tone(t, 160, 110, 0.32, 0.6),
    ft: (t) => tone(t, 110, 75, 0.4, 0.7),
    cr: (t) => hiss(t, 1.2, 0.3, "highpass", 4000),
    rd: (t) => { hiss(t, 0.6, 0.15, "bandpass", 8000); tone(t, 2400, 0, 0.5, 0.05, "triangle"); },
  };
  function click(t, accent) {
    tone(t, accent ? 1800 : 1200, 0, 0.05, accent ? 0.35 : 0.2, "square");
  }
  function pianoNote(t, midi, dur) {
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.08, t + Math.min(dur, 0.6));
    g.gain.setValueAtTime(0.08, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
    g.connect(ctx.destination);
    [[1, "triangle", 1], [2, "sine", 0.35], [3, "sine", 0.12]].forEach(([h, type, amp]) => {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = type;
      o.frequency.value = f * h;
      og.gain.value = amp;
      o.connect(og);
      og.connect(g);
      o.start(t);
      o.stop(t + dur + 0.3);
    });
  }

  // A piano-like voice that keeps sounding until stop() is called (for "play while pressed").
  function holdNote(f) {
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.5);
    g.connect(ctx.destination);
    const oscs = [[1, "triangle", 1], [2, "sine", 0.35], [3, "sine", 0.12]].map(([h, type, amp]) => {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = type; o.frequency.value = f * h; og.gain.value = amp;
      o.connect(og); og.connect(g); o.start(t);
      return o;
    });
    return () => {
      const s = ctx.currentTime;
      g.gain.cancelScheduledValues(s);
      g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), s);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.15);
      oscs.forEach((o) => o.stop(s + 0.2));
    };
  }
  // Press-and-hold on a canvas: `begin(x, y)` returns a stop function, or nothing when the press hits nothing.
  function holdable(canvas, begin) {
    let stop = null;
    canvas.addEventListener("pointerdown", (ev) => {
      const box = canvas.getBoundingClientRect();
      audio();
      stop = begin(ev.clientX - box.left, ev.clientY - box.top) || null;
      if (stop) { ev.preventDefault(); canvas.setPointerCapture(ev.pointerId); }
    });
    const end = () => { if (stop) { stop(); stop = null; } };
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((e) => canvas.addEventListener(e, end));
  }
  function howto(el, text) {
    const d = document.createElement("div");
    d.className = "lab-howto";
    d.textContent = text;
    el.prepend(d);
  }

  // Press-and-hold on a button: `start()` returns a stop function.
  function holdButton(btn, start) {
    let stop = null;
    btn.addEventListener("pointerdown", (ev) => {
      audio();
      stop = start() || null;
      if (stop) btn.setPointerCapture(ev.pointerId);
    });
    const end = () => { if (stop) { stop(); stop = null; } };
    ["pointerup", "pointercancel", "lostpointercapture"].forEach((e) => btn.addEventListener(e, end));
  }
  function release(g, nodes, fade) {
    const s = ctx.currentTime;
    g.gain.cancelScheduledValues(s);
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), s);
    g.gain.linearRampToValueAtTime(0, s + fade);
    nodes.forEach((n) => n.stop(s + fade + 0.05));
  }
  function holdSine(f, gain) {
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.05);
    o.connect(g); g.connect(ctx.destination); o.start(t);
    return () => release(g, [o], 0.08);
  }
  function holdBlow(f) {
    const t = ctx.currentTime, g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.15);
    g.connect(ctx.destination);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.value = f; og.gain.value = 0.28; o.connect(og); og.connect(g);
    const s = ctx.createBufferSource(), sf = ctx.createBiquadFilter(), sg = ctx.createGain();
    s.buffer = noise; s.loop = true; sf.type = "bandpass"; sf.frequency.value = f * 2; sg.gain.value = 0.07;
    s.connect(sf); sf.connect(sg); sg.connect(g);
    o.start(t); s.start(t);
    return () => release(g, [o, s], 0.15);
  }
  function holdSing(volume) {
    const t = ctx.currentTime, g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.3 * volume, t + 0.1);
    g.connect(ctx.destination);
    const o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = "sawtooth"; o.frequency.value = 220; lfo.frequency.value = 5; lg.gain.value = 3;
    lfo.connect(lg); lg.connect(o.frequency);
    f.type = "bandpass"; f.frequency.value = 800; f.Q.value = 1.5; // a rough "а" vowel
    o.connect(f); f.connect(g); o.start(t); lfo.start(t);
    return () => release(g, [o, lfo], 0.15);
  }
  const midiFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // Karplus–Strong plucked string: a burst of noise circulating through a short, slightly lossy delay line.
  function pluck(t, f, gain) {
    const rate = ctx.sampleRate, n = Math.round(rate / f), len = Math.round(rate * 2.5);
    const buf = ctx.createBuffer(1, len, rate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    for (let i = n; i < len; i++) d[i] = 0.497 * (d[i - n] + d[i - n + 1 < i ? i - n + 1 : i - n]);
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf; g.gain.value = gain;
    s.connect(g); g.connect(ctx.destination); s.start(t);
  }

  // ---------- notes ----------
  const SYL = { "до": 0, "ре": 2, "ми": 4, "фа": 5, "соль": 7, "ля": 9, "си": 11 };
  const NAMES = ["до", "до♯", "ре", "ре♯", "ми", "фа", "фа♯", "соль", "соль♯", "ля", "ля♯", "си"];
  function parseNote(s) {
    const m = /^(до|ре|ми|фа|соль|ля|си)(♯|♭|#|b)?(\d)$/.exec(s.trim());
    if (!m) throw new Error("bad note: " + s);
    const acc = m[2] === "♯" || m[2] === "#" ? 1 : m[2] ? -1 : 0;
    return { midi: 12 * (Number(m[3]) + 1) + SYL[m[1]] + acc, label: m[1] + (m[2] ? (acc > 0 ? "♯" : "♭") : "") };
  }
  const isBlack = (midi) => [1, 3, 6, 8, 10].includes(midi % 12);
  const LETTERS = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

  function parseDrums(el) {
    const steps = Number(el.dataset.steps || 8);
    const perBeat = steps / 4;
    const events = [];
    let length = 0;
    el.dataset.rows.split(";").forEach((row) => {
      const [key, pattern] = row.split(":").map((s) => s.trim());
      if (!KIT[key]) throw new Error("unknown drum: " + key);
      length = Math.max(length, pattern.length / perBeat);
      [...pattern].forEach((ch, i) => {
        if (ch === ".") return;
        const hand = ch === "R" ? "right" : ch === "L" ? "left" : KIT[key].pedal ? "foot" : KIT[key].hand;
        events.push({ beat: i / perBeat, key, hand, label: ch === "R" ? "П" : ch === "L" ? "Л" : "" });
      });
    });
    return { events, length: Math.ceil(length / 4) * 4, minGap: minGap(events) };
  }

  function parsePiano(el) {
    const events = [];
    let beat = 0;
    el.dataset.notes.trim().split(/\s+/).forEach((tok) => {
      const [notes, dur] = tok.split(":");
      const d = Number(dur || 1);
      if (notes !== "-") notes.split("+").forEach((n) => events.push({ beat, dur: d, ...parseNote(n) }));
      beat += d;
    });
    const [lo, hi] = (el.dataset.range || "до4-до5").split("-").map((n) => parseNote(n).midi);
    return { events, length: Math.ceil(beat / 4) * 4, lo, hi, minGap: minGap(events) };
  }

  function minGap(events) {
    const beats = [...new Set(events.map((e) => e.beat))].sort((a, b) => a - b);
    let gap = 1;
    for (let i = 1; i < beats.length; i++) gap = Math.min(gap, beats[i] - beats[i - 1]);
    return gap;
  }

  // ---------- player ----------
  class Player {
    constructor(el) {
      this.el = el;
      this.kind = el.dataset.kind;
      howto(el, this.kind === "piano"
        ? "Как играть: «Старт» — ноты падают к клавишам. По клавишам можно нажимать мышкой, пальцем или клавиатурой; «Играть самому» — проверить себя."
        : "Как играть: «Старт» — ноты падают к пэдам. По пэдам можно стучать мышкой, пальцем или клавиатурой; «Играть самому» — проверить себя.");
      this.song = this.kind === "piano" ? parsePiano(el) : parseDrums(el);
      this.bpm = Number(el.dataset.bpm || 70);
      this.metronome = this.kind === "drums";
      this.playing = false;
      this.mode = "listen";
      this.judged = new Map();
      this.score = { hit: 0, early: 0, miss: 0 };
      this.marks = [];
      this.build();
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    build() {
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML =
        '<span class="player-mode"><button type="button" data-mode="listen" class="on">Слушать</button>' +
        '<button type="button" data-mode="play">Играть самому</button></span>' +
        '<button type="button" class="player-play">▶ Старт</button>' +
        '<label>Темп <input type="range" min="40" max="160" step="5"> <span class="player-bpm"></span> BPM</label>' +
        '<label><input type="checkbox" class="player-click"> метроном</label>' +
        '<span class="player-score"></span>';
      this.el.append(this.canvas, bar);
      this.flashes = {};
      this.canvas.addEventListener("pointerdown", (ev) => this.tap(ev));
      const endTap = () => { if (this.stopTap) { this.stopTap(); this.stopTap = null; } };
      ["pointerup", "pointercancel", "lostpointercapture"].forEach((e) => this.canvas.addEventListener(e, endTap));
      this.button = bar.querySelector(".player-play");
      const range = bar.querySelector("input[type=range]");
      const bpmLabel = bar.querySelector(".player-bpm");
      const clickBox = bar.querySelector(".player-click");
      range.value = this.bpm;
      bpmLabel.textContent = this.bpm;
      clickBox.checked = this.metronome;
      this.button.addEventListener("click", () => (this.playing ? this.stop() : this.start()));
      range.addEventListener("input", () => { this.setBpm(Number(range.value)); bpmLabel.textContent = this.bpm; });
      clickBox.addEventListener("change", () => (this.metronome = clickBox.checked));
      this.scoreLabel = bar.querySelector(".player-score");
      bar.querySelectorAll(".player-mode button").forEach((b) => b.addEventListener("click", () => {
        bar.querySelectorAll(".player-mode button").forEach((x) => x.classList.toggle("on", x === b));
        this.mode = b.dataset.mode;
        if (this.mode === "play") { this.metronome = clickBox.checked = true; requestMidi(); }
        this.resetScore();
        if (!this.playing) this.draw(IDLE);
      }));
    }

    resize() {
      const w = this.el.clientWidth;
      const h = Math.round(this.kind === "piano" ? Math.min(420, w * 0.75) : Math.min(480, w * 0.8));
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w;
      this.h = h;
      this.draw(this.playing ? this.beatAt(ctx.currentTime) : IDLE);
    }

    // Song position in beats is anchored, so a tempo change keeps the current place.
    beatAt(time) { return this.anchorBeat + ((time - this.anchorTime) * this.bpm) / 60; }
    timeAt(beat) { return this.anchorTime + ((beat - this.anchorBeat) * 60) / this.bpm; }
    setBpm(bpm) {
      if (this.playing) {
        const now = ctx.currentTime;
        this.anchorBeat = this.beatAt(now);
        this.anchorTime = now;
      }
      this.bpm = bpm;
    }

    start() {
      audio();
      document.querySelectorAll(".player").forEach((el) => el._player !== this && el._player && el._player.stop());
      this.playing = true;
      this.button.textContent = "■ Стоп";
      this.resetScore();
      activePlayer = this;
      // Start one window early: notes fall in from the top and the metronome counts in.
      this.anchorBeat = -BEATS_VISIBLE;
      this.anchorTime = ctx.currentTime + 0.05;
      this.nextBeat = this.anchorBeat;
      this.timer = setInterval(() => this.schedule(), 25);
      this.schedule();
      const frame = () => {
        if (!this.playing) return;
        const cur = this.beatAt(ctx.currentTime);
        if (this.mode === "play") this.findMisses(cur);
        this.draw(cur);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }

    stop() {
      this.playing = false;
      clearInterval(this.timer);
      this.button.textContent = "▶ Старт";
      this.draw(IDLE);
    }

    schedule() {
      const until = this.beatAt(ctx.currentTime + LOOKAHEAD);
      const L = this.song.length;
      while (this.nextBeat < until) {
        const from = this.nextBeat;
        const to = Math.min(until, Math.floor(from) + 1);
        if (Number.isInteger(from) && this.metronome) click(this.timeAt(from), ((from % 4) + 4) % 4 === 0);
        if (from >= 0) {
          const loop = Math.floor(from / L);
          this.song.events.forEach((e) => {
            const b = e.beat + loop * L;
            if (b >= from && b < to) this.sound(e, this.timeAt(b));
          });
        }
        this.nextBeat = to;
      }
    }

    sound(e, t) {
      if (this.mode === "play") return;
      if (this.kind === "piano") pianoNote(t, e.midi, (e.dur * 60) / this.bpm * 0.95);
      else DRUM_SOUND[e.key](t);
    }

    // Every event occurrence (across loop repeats) whose beat lies in [a, b).
    occurrences(a, b) {
      const L = this.song.length;
      const out = [];
      for (let loop = Math.max(0, Math.floor(a / L) - 1); loop * L < b; loop++) {
        this.song.events.forEach((e, i) => {
          const beat = e.beat + loop * L;
          const end = beat + (e.dur || 0);
          if (end >= a && beat < b) out.push({ ...e, beat, id: loop + ":" + i });
        });
      }
      return out;
    }

    draw(cur) {
      const g = this.g;
      g.clearRect(0, 0, this.w, this.h);
      g.fillStyle = COLORS.bg;
      g.fillRect(0, 0, this.w, this.h);
      if (this.kind === "piano") this.drawPiano(cur);
      else this.drawDrums(cur);
    }

    drawDrums(cur) {
      const g = this.g, w = this.w;
      const highway = this.h * 0.5;
      const kitTop = highway + 8;
      const s = Math.min(w / 760, (this.h - kitTop) / 250);
      const ox = (w - 760 * s) / 2;
      const px = (x) => ox + x * s;
      const py = (y) => kitTop + (y - 20) * s;
      const perBeat = (highway - 40) / BEATS_VISIBLE;
      const yOf = (beat) => highway - (beat - cur) * perBeat;
      const used = new Set(this.song.events.map((e) => KIT[e.key].pad || e.key));
      const laneW = 40 * s;
      const laneX = spreadLanes([...used], 46);
      const padTop = (k) => py(KIT[k].y) - (KIT[k].pedal ? 0 : KIT[k].r * s);

      g.save();
      g.beginPath(); g.rect(0, 36, w, highway - 36); g.clip();
      for (let b = Math.ceil(cur); b <= cur + BEATS_VISIBLE; b++) {
        g.strokeStyle = b % 4 === 0 ? "#b5b5ac" : "#e4e4dc";
        g.lineWidth = b % 4 === 0 ? 2 : 1;
        g.beginPath(); g.moveTo(0, yOf(b)); g.lineTo(w, yOf(b)); g.stroke();
      }
      used.forEach((k) => {
        g.fillStyle = KIT[k].pedal ? "rgba(85,91,102,0.08)" : "rgba(47,114,201,0.06)";
        g.fillRect(px(laneX[k]) - laneW / 2, 0, laneW, highway);
      });
      this.occurrences(cur - 0.25, cur + BEATS_VISIBLE).forEach((e) => {
        const k = KIT[e.key].pad || e.key;
        const x = px(laneX[k]);
        const y = yOf(e.beat);
        g.fillStyle = this.noteColor(e, COLORS[e.hand] || COLORS.right);
        roundRect(g, x - laneW / 2 + 2, y - 7, laneW - 4, 14, 4);
        g.fill();
        if (e.key === "oh") {
          g.strokeStyle = "#fff"; g.lineWidth = 1.5;
          g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.stroke();
        }
        if (e.label) {
          g.fillStyle = "#fff"; g.font = "bold 10px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
          g.fillText(e.label, x, y + 4);
        }
      });
      g.restore();

      // lane titles and dashed links from each lane down to its pad
      used.forEach((k) => {
        g.fillStyle = COLORS.text; g.textAlign = "center";
        g.font = `bold ${Math.max(9, 11 * s)}px Segoe UI, Arial, sans-serif`;
        g.fillText(KIT[k].short || KIT[k].name, px(laneX[k]), 32);
        g.strokeStyle = KIT[k].pedal ? COLORS.foot : COLORS.right;
        g.globalAlpha = 0.35; g.lineWidth = 2; g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(px(laneX[k]), highway); g.lineTo(px(KIT[k].x), padTop(k)); g.stroke();
        g.setLineDash([]); g.globalAlpha = 1;
      });
      g.strokeStyle = COLORS.text; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, highway); g.lineTo(w, highway); g.stroke();
      this.liveMarks().forEach((m) => {
        if (laneX[m.key] === undefined) return;
        g.globalAlpha = m.fade;
        g.fillStyle = COLORS.bad;
        roundRect(g, px(laneX[m.key]) - laneW / 2 + 2, highway - 7 + m.offset * perBeat, laneW - 4, 14, 4);
        g.fill();
        g.globalAlpha = 1;
      });

      // the kit: a ring closes in during the beat before a hit, the pad flashes on the hit
      const flash = new Set(this.occurrences(cur - 0.15, cur + 0.001)
        .filter((e) => this.playing && e.beat <= cur).map((e) => KIT[e.key].pad || e.key));
      const manual = this.manualFlashes();
      this.targets = [];
      Object.entries(KIT).forEach(([k, kit]) => {
        if (kit.pad) return;
        const on = manual.get(k) || (flash.has(k) && this.mode === "listen" && COLORS.flash);
        g.globalAlpha = used.has(k) ? 1 : 0.35;
        if (kit.pedal) {
          const r = { x: px(kit.x) - 20 * s, y: py(kit.y), w: 40 * s, h: 70 * s };
          g.fillStyle = on || "#9aa1ad";
          roundRect(g, r.x, r.y, r.w, r.h, 6 * s);
          g.fill(); g.strokeStyle = COLORS.foot; g.lineWidth = 2; g.stroke();
          label(g, kit.name, px(kit.x), py(kit.y) + 84 * s, s);
          this.keyHint(k, px(kit.x), py(kit.y) + 40 * s, s);
          this.targets.push({ key: k, inside: (x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h });
        } else {
          const cx = px(kit.x), cy = py(kit.y), r = kit.r * s;
          g.fillStyle = on || (kit.cymbal ? COLORS.cymbal : COLORS.pad);
          g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
          g.strokeStyle = COLORS.right; g.lineWidth = 2; g.stroke();
          label(g, kit.name, cx, cy + 4 * s, s);
          this.keyHint(k, cx, cy + 20 * s, s);
          this.targets.push({ key: k, inside: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r });
        }
        g.globalAlpha = 1;
      });
      if (this.playing) {
        this.occurrences(cur, cur + 1).filter((e) => e.beat > cur).forEach((e) => {
          const kit = KIT[KIT[e.key].pad || e.key];
          const left = e.beat - cur; // 1 → 0 as the hit approaches
          g.strokeStyle = COLORS[e.hand] || COLORS.right;
          g.globalAlpha = 1 - left * 0.7;
          g.lineWidth = 3;
          if (kit.pedal) {
            const grow = 1 + left * 0.8;
            roundRect(g, px(kit.x) - 20 * s * grow, py(kit.y) + 35 * s - 35 * s * grow, 40 * s * grow, 70 * s * grow, 6 * s);
            g.stroke();
          } else {
            g.beginPath(); g.arc(px(kit.x), py(kit.y), kit.r * s * (1 + left), 0, Math.PI * 2); g.stroke();
          }
          g.globalAlpha = 1;
        });
      }
      this.legend(["П — правая рука", COLORS.right], ["Л — левая", COLORS.left], ["серый — нога", COLORS.foot]);
    }

    // A tap on a pad, pedal or key plays it right away, whether or not the loop is running.
    tap(ev) {
      const box = this.canvas.getBoundingClientRect();
      const x = ev.clientX - box.left, y = ev.clientY - box.top;
      const target = (this.targets || []).find((tg) => tg.inside(x, y));
      if (!target) return;
      ev.preventDefault();
      this.stopTap = this.hit(target.key);
      if (this.stopTap) this.canvas.setPointerCapture(ev.pointerId);
    }

    // One hit from any input: sound, flash, and in Play mode a verdict against the nearest expected note.
    // A piano key keeps sounding until the returned function is called; drums are one-shot.
    hit(key, soundKey) {
      audio();
      activePlayer = this;
      let stop;
      if (this.kind === "piano") stop = holdNote(midiFreq(key));
      else DRUM_SOUND[soundKey || key](ctx.currentTime);
      let color = COLORS.flash;
      if (this.mode === "play" && this.playing) color = this.judge(key) ? COLORS.good : COLORS.bad;
      this.flashes[key] = { at: performance.now(), color };
      if (!this.playing) {
        this.draw(IDLE);
        setTimeout(() => !this.playing && this.draw(IDLE), 250);
      }
      return stop;
    }

    tolerance() {
      // At most 0.1 s, and never so wide that two neighbouring notes overlap.
      return Math.min((0.1 * this.bpm) / 60, this.song.minGap * 0.45);
    }

    judge(key) {
      const cur = this.beatAt(ctx.currentTime);
      const tol = this.tolerance();
      const same = (e) => (this.kind === "piano" ? e.midi === key : (KIT[e.key].pad || e.key) === key);
      const near = this.occurrences(cur - tol, cur + tol + 0.001)
        .filter((e) => same(e) && !this.judged.has(e.id) && Math.abs(e.beat - cur) <= tol)
        .sort((a, b) => Math.abs(a.beat - cur) - Math.abs(b.beat - cur))[0];
      if (near) {
        this.judged.set(near.id, "hit");
        this.score.hit++;
      } else {
        this.score.early++;
        this.marks.push({ key, at: performance.now() });
      }
      this.showScore();
      return Boolean(near);
    }

    findMisses(cur) {
      const tol = this.tolerance();
      this.occurrences(cur - 2, cur - tol).forEach((e) => {
        if (e.beat < 0 || e.beat >= cur - tol || this.judged.has(e.id)) return;
        this.judged.set(e.id, "miss");
        this.score.miss++;
        const key = this.kind === "piano" ? e.midi : KIT[e.key].pad || e.key;
        this.flashes[key] = { at: performance.now(), color: COLORS.bad };
        this.showScore();
      });
    }

    resetScore() {
      this.judged.clear();
      this.marks = [];
      this.score = { hit: 0, early: 0, miss: 0 };
      this.showScore();
    }
    showScore() {
      const { hit, early, miss } = this.score;
      this.scoreLabel.textContent = this.mode === "play" ? `вовремя ${hit} · не вовремя ${early} · пропущено ${miss}` : "";
    }

    noteColor(e, normal) {
      const verdict = this.mode === "play" && this.judged.get(e.id);
      return verdict === "hit" ? COLORS.good : verdict === "miss" ? COLORS.bad : normal;
    }

    // Off-time hits flash on the hit line of their lane and fade out.
    liveMarks() {
      const now = performance.now();
      this.marks = this.marks.filter((m) => now - m.at < 600);
      return this.marks.map((m) => ({ key: m.key, fade: 1 - (now - m.at) / 600, offset: 0 }));
    }

    manualFlashes() {
      const now = performance.now();
      const out = new Map();
      Object.entries(this.flashes).forEach(([k, f]) => {
        if (now - f.at < 200) out.set(this.kind === "piano" ? Number(k) : k, f.color);
      });
      return out;
    }

    keyHint(padKey, x, y, s) {
      if (this.mode !== "play") return;
      const code = Object.keys(DRUM_KEYS).find((c) => DRUM_KEYS[c] === padKey);
      if (!code) return;
      this.g.fillStyle = COLORS.muted;
      this.g.font = `${Math.max(9, 11 * s)}px Segoe UI, Arial, sans-serif`;
      this.g.textAlign = "center";
      this.g.fillText(code === "Space" ? "Space" : KEY_LABELS[code], x, y);
    }

    drawPiano(cur) {
      const g = this.g, w = this.w;
      const keysH = Math.min(150, this.h * 0.36);
      const lettersH = 22;
      const top = this.h - keysH - lettersH;
      const { lo, hi } = this.song;
      const whites = [];
      for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
      const kw = w / whites.length;
      const keyX = {};
      whites.forEach((m, i) => (keyX[m] = { x: i * kw, w: kw }));
      for (let m = lo; m <= hi; m++) {
        if (isBlack(m)) keyX[m] = { x: keyX[m - 1].x + kw * 0.69, w: kw * 0.62 };
      }
      const perBeat = top / BEATS_VISIBLE;
      const yOf = (beat) => top - (beat - cur) * perBeat;

      for (let b = Math.ceil(cur); b <= cur + BEATS_VISIBLE; b++) {
        g.strokeStyle = b % 4 === 0 ? "#b5b5ac" : "#e4e4dc";
        g.lineWidth = b % 4 === 0 ? 2 : 1;
        g.beginPath(); g.moveTo(0, yOf(b)); g.lineTo(w, yOf(b)); g.stroke();
      }
      const sounding = new Set();
      this.occurrences(cur - 8, cur + BEATS_VISIBLE).forEach((e) => {
        if (this.playing && this.mode === "listen" && e.beat <= cur && cur < e.beat + e.dur) sounding.add(e.midi);
        const y0 = yOf(e.beat), y1 = yOf(e.beat + e.dur);
        if (y1 > top || !keyX[e.midi]) return;
        const k = keyX[e.midi];
        g.fillStyle = this.noteColor(e, isBlack(e.midi) ? "#1f4f8f" : COLORS.right);
        roundRect(g, k.x + 3, y1 + 1, k.w - 6, Math.min(y0, top) - y1 - 2, 5);
        g.fill();
        g.fillStyle = "#fff"; g.textAlign = "center";
        g.font = `bold ${Math.min(13, k.w * 0.35)}px Segoe UI, Arial, sans-serif`;
        if (Math.min(y0, top) - y1 > 16) g.fillText(e.label, k.x + k.w / 2, Math.min(y0, top) - 8);
      });

      const manual = this.manualFlashes();
      const keyFill = (m, idle) => manual.get(m) || (sounding.has(m) ? COLORS.flash : idle);
      this.targets = [];
      for (let m = lo; m <= hi; m++) {
        const k = keyX[m];
        const bottom = top + (isBlack(m) ? keysH * 0.6 : keysH);
        const target = { key: m, inside: (x, y) => x >= k.x && x <= k.x + k.w && y >= top && y <= bottom };
        if (isBlack(m)) this.targets.unshift(target); else this.targets.push(target);
      }
      // keys in the style of the keyboard diagram in 1.2: rounded, light outlines, grey "black" keys, до tinted
      const font = (size, bold) => `${bold ? "bold " : ""}${size}px Segoe UI, Arial, sans-serif`;
      g.textAlign = "center";
      whites.forEach((m) => {
        const k = keyX[m];
        const isDo = m % 12 === 0;
        g.fillStyle = keyFill(m, isDo ? "#e3eaf7" : "#fff");
        roundRect(g, k.x + 1, top, k.w - 2, keysH, 6);
        g.fill();
        g.strokeStyle = "#cfcfc6"; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = "#222";
        g.font = font(Math.min(16, kw * 0.33), isDo);
        g.fillText(NAMES[m % 12], k.x + k.w / 2, top + keysH - 14);
        g.fillStyle = "#555";
        g.font = font(Math.min(13, kw * 0.3));
        g.fillText(LETTERS[m % 12], k.x + k.w / 2, top + keysH + 16);
      });
      this.pianoKeyCodes = {};
      const base = lo + ((12 - (lo % 12)) % 12);
      PIANO_KEYS.forEach((code, i) => { if (base + i <= hi) this.pianoKeyCodes[code] = base + i; });
      for (let m = lo; m <= hi; m++) {
        if (!isBlack(m)) continue;
        const k = keyX[m];
        g.fillStyle = keyFill(m, "#c5c5bc");
        roundRect(g, k.x, top - 1, k.w, keysH * 0.62 + 1, 4);
        g.fill();
        if (k.w > 30) {
          g.fillStyle = "#333";
          g.font = font(Math.min(11, k.w * 0.24));
          g.fillText(NAMES[m % 12], k.x + k.w / 2, top + keysH * 0.62 - 8);
        }
      }
      if (this.mode === "play") {
        Object.entries(this.pianoKeyCodes).forEach(([code, m]) => {
          const k = keyX[m];
          g.fillStyle = isBlack(m) ? "#1f4f8f" : COLORS.right;
          g.font = font(12, true);
          g.fillText(KEY_LABELS[code], k.x + k.w / 2, top + (isBlack(m) ? keysH * 0.3 : keysH * 0.62));
        });
      }
      this.liveMarks().forEach((m) => {
        const k = keyX[m.key];
        if (!k) return;
        g.globalAlpha = m.fade;
        g.fillStyle = COLORS.bad;
        roundRect(g, k.x + 3, top - 10 + m.offset * perBeat, k.w - 6, 10, 3);
        g.fill();
        g.globalAlpha = 1;
      });
      g.strokeStyle = "#8a8a82"; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(0, top - 1); g.lineTo(w, top - 1); g.stroke();
    }

    legend(...items) {
      const g = this.g;
      g.font = "11px Segoe UI, Arial, sans-serif";
      g.textAlign = "left";
      let x = 8;
      items.forEach(([text, color]) => {
        g.fillStyle = color; g.fillRect(x, 8, 10, 10);
        g.fillStyle = COLORS.text; g.fillText(text, x + 14, 17);
        x += g.measureText(text).width + 30;
      });
    }
  }

  // Lanes sit above their pads; where pads overlap horizontally, neighbours are pushed apart just enough.
  function spreadLanes(keys, gap) {
    const order = keys.map((k) => ({ k, x: KIT[k].x })).sort((a, b) => a.x - b.x);
    for (let i = 1; i < order.length; i++) order[i].x = Math.max(order[i].x, order[i - 1].x + gap);
    const overflow = order.length ? order[order.length - 1].x - 720 : 0;
    if (overflow > 0) order.forEach((o) => (o.x -= overflow));
    for (let i = order.length - 2; i >= 0; i--) order[i].x = Math.min(order[i].x, order[i + 1].x - gap);
    return Object.fromEntries(order.map((o) => [o.k, o.x]));
  }

  // Two small arrowheads either side of (x, y): "this can be dragged sideways".
  function arrows(g, x, y, text) {
    g.fillStyle = COLORS.right; g.strokeStyle = COLORS.right; g.lineWidth = 2;
    [-1, 1].forEach((d) => {
      const tip = x + d * 26, base = x + d * 16;
      g.beginPath(); g.moveTo(tip, y); g.lineTo(base, y - 6); g.lineTo(base, y + 6); g.closePath(); g.fill();
    });
    if (text) {
      g.font = "bold 12px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
      g.fillText(text, x, y - 10);
    }
  }

  function plural(n, one, few, many) {
    if (n % 1) return few;
    const d = n % 10, dd = n % 100;
    return d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function label(g, text, x, y, s) {
    g.fillStyle = COLORS.text;
    g.font = `bold ${Math.max(9, 12 * s)}px Segoe UI, Arial, sans-serif`;
    g.textAlign = "center";
    g.fillText(text, x, y);
  }


  // ---------- ruler experiment (1.1.1) ----------
  // A plastic ruler ~2 mm thick, clamped at the table edge: a cantilever, whose first mode is
  // f = 1.875² / (2π) · √(E·h² / (12·ρ)) / L² ≈ 0.51 / L² (L in metres; E = 3 GPa, ρ = 1190 kg/m³).
  const RULER_K = 0.513;
  // The second bending mode of a cantilever is (4.694 / 1.875)² ≈ 6.27 times the first: this is the hum one hears
  // from a long ruler, pulsing with the slow swing, together with the slap against the table edge on every swing.
  const SECOND_MODE = 6.27;
  const RULER_CM = 30;

  class RulerLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: тяните линейку вправо или влево — меняется свисающий конец. Щёлкните по линейке — она задрожит.");
      this.free = 20; // cm hanging over the edge
      this.pluckedAt = null;
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML =
        '<button type="button" class="player-play">Щёлкнуть</button>' +
        '<span class="player-score lab-info"></span>';
      el.append(this.canvas, bar);
      this.info = bar.querySelector(".lab-info");
      bar.querySelector("button").addEventListener("click", () => this.pluck());
      // Drag the ruler sideways to push it out over the edge or back onto the table; a short click flicks it.
      let press = null;
      this.canvas.addEventListener("pointerdown", (ev) => {
        press = { x: ev.clientX, free: this.free, moved: false };
        this.canvas.setPointerCapture(ev.pointerId);
        ev.preventDefault();
      });
      this.canvas.addEventListener("pointermove", (ev) => {
        if (!press) return;
        const dx = ev.clientX - press.x;
        if (!press.moved && Math.abs(dx) > 4) press.moved = true;
        if (!press.moved) return;
        const free = Math.max(3, Math.min(28, Math.round(press.free + dx / this.cm)));
        if (free !== this.free) { this.free = free; this.pluckedAt = null; this.update(); }
      });
      const end = () => { if (press && !press.moved) this.pluck(); press = null; };
      ["pointerup", "pointercancel"].forEach((e) => this.canvas.addEventListener(e, end));
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    freq() { return RULER_K / (this.free / 100) ** 2; }

    resize() {
      const w = this.el.clientWidth, h = Math.round(Math.min(260, w * 0.45));
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      this.update();
    }

    update() {
      const f = this.freq();
      const f2 = Math.round(f * SECOND_MODE);
      this.info.textContent = `≈ ${f < 20 ? f.toFixed(1).replace(".", ",") : Math.round(f)} колебаний в секунду — ` +
        (f < 20 ? `само качание не слышно (ниже 20), слышны стук о стол и гул второго изгиба ≈ ${f2} Гц`
                : `глазом не уследить, ухо слышит гудение; второй изгиб ≈ ${f2} Гц`);
      this.draw(0);
    }

    pluck() {
      audio();
      const f = this.freq();
      const t = ctx.currentTime;
      hiss(t, 0.03, 0.3, "bandpass", 2500); // the flick of a finger
      if (f < 20) {
        // the slow swing itself is inaudible: what sounds is a slap on every swing and the pulsing second mode
        const tau = 1.4, len = 3;
        for (let k = 1; k / f < len; k++) {
          const level = Math.exp(-k / f / tau);
          if (level < 0.05) break;
          hiss(t + k / f, 0.025, 0.35 * level, "bandpass", 1200);
        }
        const o = ctx.createOscillator(), g2 = ctx.createGain();
        o.type = "triangle";
        o.frequency.value = f * SECOND_MODE;
        const curve = new Float32Array(300);
        for (let i = 0; i < curve.length; i++) {
          const s = (i / (curve.length - 1)) * len;
          curve[i] = 0.25 * Math.exp(-s / tau) * Math.abs(Math.cos(2 * Math.PI * f * s));
        }
        g2.gain.setValueCurveAtTime(curve, t, len);
        o.connect(g2); g2.connect(ctx.destination);
        o.start(t); o.stop(t + len);
      }
      if (f >= 20) {
        // a short ruler buzzes: louder against the table at low notes, fading in about a second
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = Math.min(4000, f * 6);
        o.connect(filter);
        filter.connect(envGain(t, 0.35, 1.2));
        o.start(t);
        o.stop(t + 1.3);
      }
      this.pluckedAt = performance.now();
      const frame = () => {
        const age = (performance.now() - this.pluckedAt) / 1000;
        this.draw(age);
        if (this.pluckedAt && age < 3) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }

    draw(age) {
      const g = this.g, w = this.w, h = this.h;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, w, h);
      const cm = (w - 40) / 40; // pixels per centimetre; 40 cm of scene
      this.cm = cm;
      const edge = 20 + 12 * cm; // table edge
      const y0 = h * 0.42;
      const freeLen = this.free * cm;
      // table and hand
      g.fillStyle = "#f6f6f2"; g.strokeStyle = COLORS.line; g.lineWidth = 1.5;
      g.fillRect(0, y0 + 4, edge, h - y0); g.strokeRect(-1, y0 + 4, edge + 1, h - y0);
      const clamp = edge - (RULER_CM - this.free) * cm; // where the ruler's far end lies on the table
      g.fillStyle = "#7eaee6"; g.strokeStyle = COLORS.right;
      roundRect(g, Math.max(4, edge - 7 * cm), y0 - 18, 5 * cm, 16, 5); g.fill(); g.stroke();
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
      g.fillText("рука прижимает", Math.max(4, edge - 7 * cm) + 2.5 * cm, y0 - 24);

      const f = this.freq();
      const amp = this.pluckedAt ? Math.exp(-age / (f < 20 ? 1.4 : 0.5)) * Math.min(h * 0.32, freeLen * 0.5) : 0;
      const shape = (x) => { const s = x / freeLen; return (s * s * (3 - s)) / 2; }; // bent cantilever
      const ruler = (tip, alpha) => {
        g.globalAlpha = alpha;
        g.strokeStyle = COLORS.right; g.lineWidth = 7; g.lineCap = "butt";
        g.beginPath(); g.moveTo(Math.max(0, clamp), y0); g.lineTo(edge, y0);
        for (let x = 0; x <= freeLen; x += 4) g.lineTo(edge + x, y0 + tip * shape(x));
        g.stroke();
        g.globalAlpha = 1;
      };
      if (amp > 0.5 && f > 15) {
        // too fast for the screen (and the eye): draw the blur between the extreme positions
        for (let i = -4; i <= 4; i++) ruler((amp * i) / 4, 0.12);
        ruler(0, 0.6);
      } else {
        ruler(amp * Math.cos(2 * Math.PI * f * age), 1);
      }
      // length marker
      g.strokeStyle = COLORS.muted; g.lineWidth = 1;
      g.beginPath(); g.moveTo(edge, h - 22); g.lineTo(edge + freeLen, h - 22); g.stroke();
      g.fillStyle = COLORS.text; g.font = "bold 12px Segoe UI, Arial, sans-serif";
      g.fillText(`${this.free} см свободно`, edge + freeLen / 2, h - 8);
      if (!this.pluckedAt || age > 2) arrows(g, edge + freeLen - 10, y0 - 30, "тяните");
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
    }
  }


  // ---------- octaves (1.3): the 12 notes of one octave; switching the octave doubles or halves every frequency ----------
  const OCTAVES = [["контроктава", "контроктавы", 1], ["большая", "большой октавы", 2], ["малая", "малой октавы", 3],
                   ["первая", "первой октавы", 4], ["вторая", "второй октавы", 5], ["третья", "третьей октавы", 6],
                   ["четвёртая", "четвёртой октавы", 7]];
  const hz = (f) => (f < 100 ? f.toFixed(1).replace(".", ",") : String(Math.round(f)));

  class OctaveLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: выберите октаву кнопками сверху, затем нажмите и держите клавишу — звучит нота, а над клавиатурой видна её волна.");
      this.oct = 3; // index in OCTAVES: the first octave
      this.pc = 9; // ля
      this.down = null;
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      const pick = document.createElement("div");
      pick.className = "player-controls";
      pick.innerHTML = '<span class="player-mode">' +
        OCTAVES.map(([name], i) => `<button type="button" data-oct="${i}"${i === this.oct ? ' class="on"' : ""}>${name}</button>`).join("") + "</span>";
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<button type="button" class="player-play lab-all">▶ Эта нота во всех октавах</button>' +
        '<button type="button" class="lab-sum">440 + 440 + 440 = 1320 Гц</button><span class="player-score lab-info"></span>';
      el.append(pick, this.canvas, bar);
      this.info = bar.querySelector(".lab-info");
      pick.querySelectorAll("[data-oct]").forEach((b) => b.addEventListener("click", () => {
        pick.querySelectorAll("[data-oct]").forEach((x) => x.classList.toggle("on", x === b));
        this.oct = Number(b.dataset.oct);
        this.freq = null;
        this.draw();
      }));
      bar.querySelector(".lab-all").addEventListener("click", () => this.playAll());
      holdButton(bar.querySelector(".lab-sum"), () => {
        this.freq = 1320;
        this.text = "1320 Гц — это уже не ля, а почти ми третьей октавы: частоты умножаются, а не складываются";
        this.draw();
        return holdNote(1320);
      });
      holdable(this.canvas, (x, y) => {
        const m = ChordLab.prototype.keyAt.call(this, x, y);
        if (m === undefined) return;
        this.pc = m % 12;
        this.down = m;
        this.freq = null;
        this.draw();
        const stop = holdNote(this.noteFreq(this.pc, this.oct));
        return () => { stop(); this.down = null; this.draw(); };
      });
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    // notes of the octave as MIDI-like numbers on a fixed one-octave keyboard (до … си), so the layout never moves
    noteFreq(pc, oct) { return midiFreq(12 * (OCTAVES[oct][2] + 1) + pc); }

    resize() {
      const w = this.el.clientWidth, h = Math.round(Math.min(300, w * 0.5));
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      this.lo = 0; this.hi = 11;
      ChordLab.prototype.layout.call(this);
      this.top = Math.round(h * 0.38); this.keysH = h - this.top - 6;
      this.draw();
    }

    playAll() {
      audio();
      const t = ctx.currentTime + 0.05;
      OCTAVES.forEach((o, i) => {
        const f = this.noteFreq(this.pc, i);
        pianoNote(t + i * 0.55, 69 + 12 * Math.log2(f / 440), 0.5);
        setTimeout(() => { this.oct = i; this.freq = null; this.syncButtons(); this.draw(); }, (t + i * 0.55 - ctx.currentTime) * 1000);
      });
    }
    syncButtons() {
      this.el.querySelectorAll("[data-oct]").forEach((x) => x.classList.toggle("on", Number(x.dataset.oct) === this.oct));
    }

    draw() {
      const g = this.g, w = this.w;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, w, this.h);
      const f = this.freq || this.noteFreq(this.pc, this.oct);
      // the wave: 1/55 s of it, so ля of the contra-octave shows one period and each octave up doubles the count
      const waveH = this.top - 30, mid = 8 + waveH / 2, periods = f / 55;
      g.strokeStyle = COLORS.right; g.lineWidth = periods > 30 ? 1 : 2;
      g.beginPath();
      for (let x = 0; x <= w - 16; x += 0.5) {
        const y = mid - (waveH / 2 - 4) * Math.sin((2 * Math.PI * periods * x) / (w - 16));
        if (x === 0) g.moveTo(8 + x, y); else g.lineTo(8 + x, y);
      }
      g.stroke();
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
      g.fillText(`${periods % 1 ? periods.toFixed(1).replace(".", ",") : periods} ${plural(periods, "колебание", "колебания", "колебаний")} за 1/55 секунды`, 8, this.top - 8);
      // one octave of keys with their frequencies
      const { top, keysH, kw } = this;
      g.textAlign = "center";
      for (let m = 0; m <= 11; m++) {
        if (isBlack(m)) continue;
        const k = this.keys[m], on = m === this.pc;
        g.fillStyle = m === this.down ? COLORS.flash : on ? "#e3eaf7" : "#fff";
        roundRect(g, k.x + 1, top, k.w - 2, keysH, 6); g.fill();
        g.strokeStyle = on ? COLORS.right : "#cfcfc6"; g.lineWidth = on ? 2.5 : 1.5; g.stroke();
        g.fillStyle = "#222"; g.font = `${on ? "bold " : ""}${Math.min(15, kw * 0.22)}px Segoe UI, Arial, sans-serif`;
        g.fillText(NAMES[m], k.x + k.w / 2, top + keysH - 30);
        g.fillStyle = COLORS.muted; g.font = `${Math.min(12, kw * 0.18)}px Segoe UI, Arial, sans-serif`;
        g.fillText(`${hz(this.noteFreq(m, this.oct))} Гц`, k.x + k.w / 2, top + keysH - 12);
      }
      for (let m = 0; m <= 11; m++) {
        if (!isBlack(m)) continue;
        const k = this.keys[m], on = m === this.pc;
        g.fillStyle = m === this.down ? COLORS.flash : on ? COLORS.right : "#c5c5bc";
        roundRect(g, k.x, top - 1, k.w, keysH * 0.6 + 1, 4); g.fill();
        g.fillStyle = on ? "#fff" : "#333"; g.font = `${Math.min(11, k.w * 0.2)}px Segoe UI, Arial, sans-serif`;
        g.fillText(NAMES[m], k.x + k.w / 2, top + keysH * 0.6 - 22);
        g.fillText(hz(this.noteFreq(m, this.oct)), k.x + k.w / 2, top + keysH * 0.6 - 8);
      }
      if (this.freq) { this.info.textContent = this.text; return; }
      const [, gen, sci] = OCTAVES[this.oct];
      const lower = this.oct > 0 ? `${hz(f / 2)} Гц октавой ниже` : "";
      const upper = this.oct < OCTAVES.length - 1 ? `${hz(f * 2)} Гц октавой выше` : "";
      this.info.textContent = `${NAMES[this.pc]} ${gen} (${LETTERS[this.pc]}${sci}) — ${hz(f)} Гц; ` + [lower, upper].filter(Boolean).join(", ");
    }
  }

  // ---------- intervals (1.5) ----------
  // Exact ratios, as on a monochord: the waves of the two notes meet again every `q` periods of the lower one.
  const INTERVALS = [["Октава", 2, 1, "до–до"], ["Квинта", 3, 2, "до–соль"], ["Кварта", 4, 3, "до–фа"],
                     ["Б. терция", 5, 4, "до–ми"], ["М. терция", 6, 5, "до–ми♭"], ["Б. секунда", 9, 8, "до–ре"],
                     ["М. секунда", 16, 15, "до–до♯"]];
  const DO4 = 261.63;

  class IntervalLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: нажмите и держите интервал — звучат обе ноты вместе. «Сыграть» — сначала по очереди, потом вместе.");
      this.pick = 1;
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<button type="button" class="player-play">▶ Сыграть</button><span class="player-score lab-info"></span>';
      el.append(this.canvas, bar);
      this.info = bar.querySelector(".lab-info");
      bar.querySelector("button").addEventListener("click", () => this.play());
      holdable(this.canvas, (x, y) => {
        if (y > this.boxBottom) return;
        this.pick = Math.max(0, Math.min(6, Math.floor((x / this.w) * 7)));
        this.draw();
        const [, pn, q] = INTERVALS[this.pick];
        const stops = [holdNote(DO4), holdNote((DO4 * pn) / q)];
        return () => stops.forEach((s) => s());
      });
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    resize() {
      const w = this.el.clientWidth, h = Math.round(Math.min(300, w * 0.5));
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      this.draw();
    }

    play() {
      audio();
      const [, pn, q] = INTERVALS[this.pick];
      const lo = DO4, hi = (DO4 * pn) / q, t = ctx.currentTime + 0.05;
      const note = (f, at, dur) => pianoNote(at, 69 + 12 * Math.log2(f / 440), dur);
      note(lo, t, 0.45); note(hi, t + 0.5, 0.45);
      note(lo, t + 1.1, 1.6); note(hi, t + 1.1, 1.6);
      this.draw();
    }

    draw() {
      const g = this.g, w = this.w, h = this.h;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, w, h);
      const n = INTERVALS.length, gap = 6, bw = (w - 16 - gap * (n - 1)) / n, bh = Math.min(72, h * 0.28), top = 8;
      this.boxBottom = top + bh;
      INTERVALS.forEach(([name, pn, q, ex], i) => {
        const x = 8 + i * (bw + gap), good = i < 5, on = i === this.pick;
        g.fillStyle = good ? "#e6f4e6" : "#f9e6e6";
        roundRect(g, x, top, bw, bh, 8); g.fill();
        g.strokeStyle = good ? "#2a9d4b" : COLORS.bad; g.lineWidth = on ? 3 : 1.5; g.stroke();
        g.textAlign = "center"; g.fillStyle = COLORS.text;
        g.font = `bold ${Math.min(13, bw * 0.13)}px Segoe UI, Arial, sans-serif`;
        g.fillText(name, x + bw / 2, top + bh * 0.32);
        g.font = `${Math.min(13, bw * 0.13)}px Segoe UI, Arial, sans-serif`;
        g.fillText(`${pn} : ${q}`, x + bw / 2, top + bh * 0.6);
        g.fillStyle = COLORS.muted; g.fillText(ex, x + bw / 2, top + bh * 0.86);
      });
      // three waves over `q` periods of the lower note (at least two), so the meeting point is always on screen
      const [name, pn, q] = INTERVALS[this.pick];
      const periods = Math.max(2, q);
      const rows = [["нижняя нота", [1]], ["верхняя нота", [pn / q]], ["вместе", [1, pn / q]]];
      const rowH = (h - top - bh - 14) / 3;
      rows.forEach(([label, ratios], r) => {
        const mid = top + bh + 10 + rowH * (r + 0.5), amp = rowH * (r === 2 ? 0.42 : 0.3);
        g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
        g.fillText(label, 8, mid - rowH * 0.38);
        g.strokeStyle = r === 2 ? (this.pick < 5 ? "#2a9d4b" : COLORS.bad) : COLORS.right;
        g.lineWidth = periods > 8 ? 1 : 1.6;
        g.beginPath();
        for (let x = 0; x <= w - 16; x += 0.5) {
          const ph = (2 * Math.PI * periods * x) / (w - 16);
          const y = ratios.reduce((s, k) => s + Math.sin(ph * k), 0) / ratios.length;
          if (x === 0) g.moveTo(8 + x, mid - amp * y); else g.lineTo(8 + x, mid - amp * y);
        }
        g.stroke();
      });
      this.info.textContent = this.pick < 5
        ? `${name}: волны сходятся каждые ${q} ${plural(q, "колебание", "колебания", "колебаний")} нижней ноты — звуки сливаются`
        : `${name}: волны сходятся лишь раз в ${q} колебаний нижней ноты — между встречами они то складываются, то гасят друг друга, слышно дрожание`;
    }
  }

  // ---------- hearing: loudness in decibels and the upper limit (1.3.1) ----------
  // Never louder than REF: a fixed, quiet level; the buttons only attenuate it.
  const REF = 0.12;
  const LEVELS = [0, -3, -10, -20, -30];
  const HEARING = [50, 100, 1000, 4000, 8000, 12000, 15000, 17000];

  class EarLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: сначала сделайте звук устройства тихим. Нажмите и держите кнопку — звучит тон.");
      this.db = 0;
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      const loud = document.createElement("div");
      loud.className = "player-controls";
      loud.innerHTML = "<b>Громкость:</b>" + LEVELS.map((d) => `<button type="button" data-db="${d}">${d === 0 ? "0" : "−" + -d} дБ</button>`).join("") +
        '<button type="button" data-two="1">1 инструмент → 2</button>';
      const high = document.createElement("div");
      high.className = "player-controls";
      high.innerHTML = "<b>Предел слуха:</b>" + HEARING.map((f) => `<button type="button" data-hz="${f}">${f >= 1000 ? f / 1000 + " кГц" : f + " Гц"}</button>`).join("") +
        '<span class="player-score lab-info"></span>';
      el.append(this.canvas, loud, high);
      this.info = high.querySelector(".lab-info");
      loud.querySelectorAll("[data-db]").forEach((b) => holdButton(b, () => this.level(Number(b.dataset.db))));
      loud.querySelector("[data-two]").addEventListener("click", () => this.two());
      high.querySelectorAll("[data-hz]").forEach((b) => holdButton(b, () => this.hear(Number(b.dataset.hz))));
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    resize() {
      const w = this.el.clientWidth, h = 120;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      this.draw();
    }

    sine(f, at, dur, gain) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain, at + 0.05);
      g.gain.setValueAtTime(gain, at + dur - 0.1);
      g.gain.linearRampToValueAtTime(0, at + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(at); o.stop(at + dur + 0.05);
    }

    level(db) {
      audio();
      this.db = db;
      const stop = holdSine(440, REF * Math.pow(10, db / 20));
      this.info.textContent = db === 0 ? "исходный уровень" :
        `${db} дБ: мощность в ${Math.round(Math.pow(10, -db / 10))} раз меньше, а на слух — примерно в ${(Math.pow(2, -db / 10)).toFixed(1).replace(".", ",").replace(",0", "")} раза тише`;
      this.draw();
      return stop;
    }

    two() {
      audio();
      const t = ctx.currentTime + 0.02, one = REF * Math.pow(10, -6 / 20);
      this.sine(440, t, 1, one);
      // two players never sound in phase: slightly different pitch, so their powers add up (+3 dB), not amplitudes
      this.sine(440, t + 1.3, 1, one);
      this.sine(440.7, t + 1.3, 1, one);
      this.db = -3;
      this.info.textContent = "второй такой же инструмент добавляет всего +3 дБ: разница едва заметна";
      this.draw();
    }

    hear(f) {
      audio();
      const stop = holdSine(f, REF * 0.5);
      this.info.textContent = `${f} Гц — ${f <= 100 ? "в маленьких динамиках может быть не слышно, лучше в наушниках" :
        f >= 12000 ? "слышите? С возрастом верхняя граница снижается, это нормально" : "это слышат все"}`;
      return stop;
    }

    draw() {
      const g = this.g, w = this.w, h = this.h;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, w, h);
      const power = Math.pow(10, this.db / 10), felt = Math.pow(2, this.db / 10);
      const bars = [["мощность", power, "#9aa1ad"], ["на слух", felt, COLORS.right]];
      const left = 90, full = w - left - 70;
      bars.forEach(([name, v, color], i) => {
        const y = 22 + i * 44;
        g.fillStyle = COLORS.text; g.font = "bold 12px Segoe UI, Arial, sans-serif"; g.textAlign = "right";
        g.fillText(name, left - 10, y + 14);
        g.fillStyle = "#e9e9e2"; roundRect(g, left, y, full, 20, 4); g.fill();
        g.fillStyle = color; roundRect(g, left, y, Math.max(3, full * v), 20, 4); g.fill();
        g.fillStyle = COLORS.muted; g.font = "12px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
        g.fillText(v === 1 ? "100 %" : `${Math.round(v * 1000) / 10} %`.replace(".", ","), left + full + 8, y + 14);
      });
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
      g.fillText(`уровень ${this.db} дБ от исходного`, left, h - 6);
    }
  }


  // ---------- chord builder (1.5, lesson 1 step 5) ----------
  const CHORD_PRESETS = [["Мажор", [60, 64, 67]], ["Минор", [60, 63, 67]], ["Минор на белых", [62, 65, 69]],
                         ["Кластер", [60, 61, 62]], ["Октава", [60, 72]], ["Квинта", [60, 67]],
                         ["Б. терция", [60, 64]], ["М. секунда", [60, 61]]];
  const STEP_NAMES = ["унисон", "малая секунда", "большая секунда", "малая терция", "большая терция", "кварта", "тритон",
                      "квинта", "малая секста", "большая секста", "малая септима", "большая септима", "октава"];
  function chordName(steps) {
    const key = steps.join("+");
    if (key === "4+3") return "мажорное трезвучие: светло и устойчиво";
    if (key === "3+4") return "минорное трезвучие: мягко и грустно";
    if (key === "1+1") return "кластер: резко, звуки «трутся»";
    if (steps.length === 1 && steps[0] <= 12) return STEP_NAMES[steps[0]];
    return "";
  }

  class ChordLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: щёлкайте по клавишам, чтобы выбрать ноты, затем нажмите и держите «Вместе». Готовые созвучия — кнопки внизу.");
      this.lo = 60; this.hi = 83; // до4 … си5
      this.chosen = new Set([60, 64, 67]);
      this.lit = new Map();
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<button type="button" class="player-play" data-act="together">▶ Вместе</button>' +
        '<button type="button" data-act="apart">▶ По очереди</button><button type="button" data-act="clear">Сбросить</button>' +
        '<span class="player-score lab-info"></span>';
      const presets = document.createElement("div");
      presets.className = "player-controls";
      presets.innerHTML = "<b>Готовые:</b>" + CHORD_PRESETS.map(([n], i) => `<button type="button" data-preset="${i}">${n}</button>`).join("");
      el.append(this.canvas, bar, presets);
      this.info = bar.querySelector(".lab-info");
      holdButton(bar.querySelector("[data-act=together]"), () => this.hold());
      bar.querySelector("[data-act=apart]").addEventListener("click", () => this.play(true));
      bar.querySelector("[data-act=clear]").addEventListener("click", () => { this.chosen.clear(); this.draw(); });
      presets.querySelectorAll("[data-preset]").forEach((b) => holdButton(b, () => {
        this.chosen = new Set(CHORD_PRESETS[Number(b.dataset.preset)][1]);
        return this.hold();
      }));
      this.canvas.addEventListener("pointerdown", (ev) => {
        const box = this.canvas.getBoundingClientRect();
        const m = this.keyAt(ev.clientX - box.left, ev.clientY - box.top);
        if (m === undefined) return;
        if (this.chosen.has(m)) this.chosen.delete(m);
        else { this.chosen.add(m); audio(); pianoNote(ctx.currentTime, m, 0.5); }
        this.draw();
      });
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    resize() {
      const w = this.el.clientWidth, h = Math.round(Math.min(190, w * 0.32));
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      this.layout();
      this.draw();
    }

    layout() {
      const whites = [];
      for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m)) whites.push(m);
      const kw = (this.w - 16) / whites.length;
      this.kw = kw;
      this.keys = {};
      whites.forEach((m, i) => (this.keys[m] = { x: 8 + i * kw, w: kw, black: false }));
      for (let m = this.lo; m <= this.hi; m++) if (isBlack(m)) this.keys[m] = { x: this.keys[m - 1].x + kw * 0.69, w: kw * 0.62, black: true };
      this.top = 8; this.keysH = this.h - 16;
    }

    keyAt(x, y) {
      const inKey = (m) => { const k = this.keys[m]; return x >= k.x && x <= k.x + k.w && y >= this.top && y <= this.top + this.keysH * (k.black ? 0.62 : 1); };
      for (let m = this.lo; m <= this.hi; m++) if (isBlack(m) && inKey(m)) return m;
      for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m) && inKey(m)) return m;
      return undefined;
    }

    // The chosen keys sound together for as long as the button is held.
    hold() {
      if (!this.chosen.size) return null;
      const notes = [...this.chosen];
      const stops = notes.map((m) => holdNote(midiFreq(m)));
      notes.forEach((m) => this.lit.set(m, Infinity));
      this.draw();
      return () => { stops.forEach((s) => s()); notes.forEach((m) => this.lit.delete(m)); this.draw(); };
    }

    play(apart) {
      if (!this.chosen.size) return;
      audio();
      const notes = [...this.chosen].sort((a, b) => a - b);
      const t = ctx.currentTime + 0.03;
      notes.forEach((m, i) => {
        const at = apart ? t + i * 0.45 : t;
        pianoNote(at, m, apart ? 0.4 : 2.5);
        setTimeout(() => { this.lit.set(m, performance.now()); this.draw(); setTimeout(() => this.draw(), 450); }, (at - ctx.currentTime) * 1000);
      });
      this.draw();
    }

    draw() {
      const g = this.g, { top, keysH, kw } = this;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, this.w, this.h);
      const now = performance.now();
      const fill = (m, idle) => (this.lit.has(m) && (this.lit.get(m) === Infinity || now - this.lit.get(m) < 400) ? COLORS.flash : this.chosen.has(m) ? (isBlack(m) ? COLORS.right : "#b7d0f0") : idle);
      g.textAlign = "center";
      for (let m = this.lo; m <= this.hi; m++) {
        if (isBlack(m)) continue;
        const k = this.keys[m];
        g.fillStyle = fill(m, "#fff");
        roundRect(g, k.x + 1, top, k.w - 2, keysH, 6); g.fill();
        g.strokeStyle = "#cfcfc6"; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = "#222"; g.font = `${m % 12 === 0 ? "bold " : ""}${Math.min(14, kw * 0.33)}px Segoe UI, Arial, sans-serif`;
        g.fillText(NAMES[m % 12], k.x + k.w / 2, top + keysH - 10);
      }
      for (let m = this.lo; m <= this.hi; m++) {
        if (!isBlack(m)) continue;
        const k = this.keys[m];
        g.fillStyle = fill(m, "#c5c5bc");
        roundRect(g, k.x, top - 1, k.w, keysH * 0.62 + 1, 4); g.fill();
      }
      const notes = [...this.chosen].sort((a, b) => a - b);
      const names = notes.map((m) => NAMES[m % 12]).join(" + ");
      const steps = notes.slice(1).map((m, i) => m - notes[i]);
      const name = chordName(steps);
      this.info.textContent = !notes.length ? "щёлкайте по клавишам, чтобы выбрать ноты" :
        notes.length === 1 ? names : `${names}: шаги ${steps.join(" + ")} ${plural(steps[steps.length - 1], "полутон", "полутона", "полутонов")}${name ? " — " + name : ""}`;
    }
  }


  // ---------- keyboard (1.2): every key sounds while pressed ----------
  class KeyboardLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: нажимайте клавиши — нота звучит, пока клавиша нажата.");
      this.lo = 60; this.hi = 84; // до4 … до6, as in the diagram
      this.down = null;
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      el.append(this.canvas);
      holdable(this.canvas, (x, y) => {
        const m = ChordLab.prototype.keyAt.call(this, x, y);
        if (m === undefined) return;
        this.down = m; this.draw();
        const stop = holdNote(440 * Math.pow(2, (m - 69) / 12));
        return () => { stop(); this.down = null; this.draw(); };
      });
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }
    resize() {
      const w = this.el.clientWidth, h = Math.round(Math.min(210, w * 0.34));
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      ChordLab.prototype.layout.call(this);
      this.keysH = this.h - 34;
      this.draw();
    }
    draw() {
      const g = this.g, { top, keysH, kw } = this;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, this.w, this.h);
      g.textAlign = "center";
      for (let m = this.lo; m <= this.hi; m++) {
        if (isBlack(m)) continue;
        const k = this.keys[m];
        g.fillStyle = m === this.down ? COLORS.flash : m % 12 === 0 ? "#e3eaf7" : "#fff";
        roundRect(g, k.x + 1, top, k.w - 2, keysH, 6); g.fill();
        g.strokeStyle = "#cfcfc6"; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = "#222"; g.font = `${m % 12 === 0 ? "bold " : ""}${Math.min(15, kw * 0.33)}px Segoe UI, Arial, sans-serif`;
        g.fillText(NAMES[m % 12], k.x + k.w / 2, top + keysH - 12);
        g.fillStyle = "#555"; g.font = `${Math.min(13, kw * 0.3)}px Segoe UI, Arial, sans-serif`;
        g.fillText(LETTERS[m % 12], k.x + k.w / 2, top + keysH + 18);
      }
      for (let m = this.lo; m <= this.hi; m++) {
        if (!isBlack(m)) continue;
        const k = this.keys[m];
        g.fillStyle = m === this.down ? COLORS.flash : "#c5c5bc";
        roundRect(g, k.x, top - 1, k.w, keysH * 0.62 + 1, 4); g.fill();
      }
    }
  }

  // ---------- bow string (1.1.1): press with a finger, pluck the sounding part ----------
  // The open string is tuned to до of the small octave; the scale comes from simple length ratios (just intonation).
  const STRING_BASE = 130.81;
  const STRING_MARKS = [
    [1, "до", "вся струна — исходный звук"],
    [15 / 16, "до♯", "15/16 струны — малая секунда выше"],
    [8 / 9, "ре", "8/9 струны — большая секунда выше"],
    [5 / 6, "ре♯", "5/6 струны — малая терция выше"],
    [4 / 5, "ми", "4/5 струны — большая терция выше"],
    [3 / 4, "фа", "3/4 струны — кварта выше"],
    [32 / 45, "фа♯", "32/45 струны — тритон выше"],
    [2 / 3, "соль", "2/3 струны — квинта выше"],
    [5 / 8, "соль♯", "5/8 струны — малая секста выше"],
    [3 / 5, "ля", "3/5 струны — большая секста выше"],
    [5 / 9, "ля♯", "5/9 струны — малая септима выше"],
    [8 / 15, "си", "8/15 струны — большая септима выше"],
    [1 / 2, "до", "половина струны — октава выше"]];
  class StringLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: тяните синий кружок-палец вдоль струны или жмите кнопки с нотами. Щёлкните по струне — она зазвучит.");
      this.part = 1; // sounding share of the string
      this.tension = 1;
      this.pluckedAt = null;
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = STRING_MARKS.map(([, name], i) => `<button type="button" data-mark="${i}">${name}</button>`).join("") +
        '<label>Натяжение <input type="range" min="50" max="200" step="5" value="100"> <span class="lab-ten">100</span> %</label>' +
        '<span class="player-score lab-info"></span>';
      el.append(this.canvas, bar);
      this.info = bar.querySelector(".lab-info");
      bar.querySelectorAll("[data-mark]").forEach((b) => b.addEventListener("click", () => { this.part = STRING_MARKS[b.dataset.mark][0]; this.pluck(); }));
      const ten = bar.querySelector("input");
      ten.addEventListener("input", () => { this.tension = ten.value / 100; bar.querySelector(".lab-ten").textContent = ten.value; this.update(); });
      // Drag the finger along the string (it snaps to the simple ratios; at the edge the whole string sounds);
      // a short click anywhere on the string plucks it.
      let press = null;
      const posAt = (ev) => (ev.clientX - this.canvas.getBoundingClientRect().left - this.x0) / this.len;
      const setFinger = (pos) => {
        let part = Math.max(0.2, Math.min(1, 1 - pos));
        const snap = STRING_MARKS.find(([share]) => Math.abs(share - part) < 0.008);
        if (snap) part = snap[0];
        this.part = part;
        this.update();
      };
      this.canvas.addEventListener("pointerdown", (ev) => {
        const y = ev.clientY - this.canvas.getBoundingClientRect().top;
        if (y > this.y0 + 30 || y < this.y0 - 36) return;
        const pos = posAt(ev);
        if (pos < -0.02 || pos > 1.02) return;
        const onFinger = Math.abs(pos - (1 - this.part)) * this.len < 18;
        press = { x: ev.clientX, pos, onFinger, moved: false };
        this.canvas.setPointerCapture(ev.pointerId);
        ev.preventDefault();
      });
      this.canvas.addEventListener("pointermove", (ev) => {
        if (!press) return;
        if (!press.moved && Math.abs(ev.clientX - press.x) > 4) press.moved = true;
        if (press.moved) setFinger(posAt(ev));
      });
      const end = () => {
        if (!press) return;
        if (!press.moved && !press.onFinger) this.pluck();
        press = null;
      };
      ["pointerup", "pointercancel"].forEach((e) => this.canvas.addEventListener(e, end));
      this.canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }
    freq() { return (STRING_BASE * Math.sqrt(this.tension)) / this.part; }
    resize() {
      const w = this.el.clientWidth, h = 170;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h; this.x0 = 30; this.len = w - 60; this.y0 = 80;
      this.update();
    }
    update() {
      const f = this.freq();
      const mark = STRING_MARKS.find(([share]) => Math.abs(share - this.part) < 0.005);
      const semis = 12 * Math.log2(1 / this.part);
      this.info.textContent = (mark ? `${mark[1]}: ${mark[2]}` : `${Math.round(this.part * 100)} % струны — на ${semis.toFixed(1).replace(".", ",")} полутона выше`) +
        `, ${Math.round(f)} Гц` +
        (this.tension !== 1 ? `; натяжение ×${this.tension.toFixed(2).replace(".", ",")} поднимает звук в √${this.tension.toFixed(2).replace(".", ",")} раза` : "");
      this.draw(0);
    }
    pluck() {
      audio();
      pluck(ctx.currentTime, this.freq(), 0.5);
      this.update();
      this.pluckedAt = performance.now();
      const frame = () => {
        const age = (performance.now() - this.pluckedAt) / 1000;
        this.draw(age);
        if (age < 2.5) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }
    draw(age) {
      const g = this.g, { x0, len, y0 } = this;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, this.w, this.h);
      const fx = x0 + len * (1 - this.part);
      // marks for the simple ratios
      STRING_MARKS.forEach(([share, name]) => {
        const x = x0 + len * (1 - share);
        const sharp = name.includes("♯"); // sharps above the string, like black keys; the rest below
        const labelY = sharp ? y0 - 40 : y0 + 44;
        g.strokeStyle = "#d8d8cf"; g.lineWidth = 1; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(x, y0 - 34); g.lineTo(x, y0 + 30); g.stroke(); g.setLineDash([]);
        g.fillStyle = sharp ? COLORS.muted : COLORS.text; g.font = `${sharp ? "" : "bold "}${sharp ? 10 : 12}px Segoe UI, Arial, sans-serif`; g.textAlign = "center";
        g.fillText(name, x + (share === 1 ? 10 : 0), labelY);
      });
      // pegs, the silent part and the vibrating part
      g.fillStyle = "#555"; g.fillRect(x0 - 8, y0 - 12, 8, 24); g.fillRect(x0 + len, y0 - 12, 8, 24);
      g.strokeStyle = "#c9c9c0"; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(fx, y0); g.stroke();
      const amp = this.pluckedAt ? 16 * Math.exp(-age / 0.8) : 0;
      const seg = len * this.part;
      for (let k = amp > 0.5 ? -3 : 0; k <= (amp > 0.5 ? 3 : 0); k++) {
        g.strokeStyle = COLORS.right; g.globalAlpha = amp > 0.5 ? 0.25 : 1; g.lineWidth = 3;
        g.beginPath();
        for (let x = 0; x <= seg; x += 3) g.lineTo(fx + x, y0 + ((amp * k) / 3) * Math.sin((Math.PI * x) / seg));
        g.stroke();
      }
      g.globalAlpha = 1;
      {
        g.fillStyle = this.part < 1 ? "#7eaee6" : "#e3eaf7"; g.strokeStyle = COLORS.right; g.lineWidth = 1.5;
        g.beginPath(); g.arc(fx, y0 - 14, 9, 0, Math.PI * 2); g.fill(); g.stroke();
        arrows(g, fx, y0 - 14, "");
      }
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
    }
  }

  // ---------- bottles (1.1.1): tap the glass or blow across the neck ----------
  // A simple model, not a measurement: blowing excites the air above the water (a Helmholtz resonator, f ∝ 1/√air);
  // tapping excites the glass, which the water makes heavier (f falls as the water rises).
  const BLOW_EMPTY = 180, TAP_EMPTY = 1400;
  const blowFreq = (level) => BLOW_EMPTY / Math.sqrt(1 - level);
  const tapFreq = (level) => TAP_EMPTY / Math.sqrt(1 + 2.5 * level);
  class BottleLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: щёлкните по бутылке — она зазвучит, в режиме «Дуть» — пока держите. Потяните бутылку вверх или вниз — изменится уровень воды.");
      this.levels = [0.15, 0.3, 0.45, 0.6, 0.72, 0.85];
      this.mode = "tap";
      this.lit = null;
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<span class="player-mode"><button type="button" data-m="tap" class="on">Стучать ложкой</button><button type="button" data-m="blow">Дуть</button></span>' +
        '<button type="button" data-organ="1">Настроить орган: до ре ми фа соль ля</button><span class="player-score lab-info"></span>';
      el.append(this.canvas, bar);
      this.info = bar.querySelector(".lab-info");
      bar.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => {
        bar.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("on", x === b));
        this.mode = b.dataset.m; this.draw();
      }));
      bar.querySelector("[data-organ]").addEventListener("click", () => {
        // levels at which blowing gives до, ре, ми, фа, соль, ля of the first octave
        this.levels = [60, 62, 64, 65, 67, 69].map((m) => 1 - (BLOW_EMPTY / (440 * Math.pow(2, (m - 69) / 12))) ** 2);
        this.mode = "blow";
        bar.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("on", x.dataset.m === "blow"));
        this.draw();
      });
      let drag = null;
      this.canvas.addEventListener("pointerdown", (ev) => {
        const box = this.canvas.getBoundingClientRect();
        const i = this.bottleAt(ev.clientX - box.left);
        if (i === undefined) return;
        drag = { i, y: ev.clientY, moved: false };
        this.canvas.setPointerCapture(ev.pointerId);
        if (this.mode === "blow") { audio(); drag.stop = this.blow(i); }
      });
      this.canvas.addEventListener("pointermove", (ev) => {
        if (!drag) return;
        if (Math.abs(ev.clientY - drag.y) > 5 && !drag.moved) {
          drag.moved = true;
          if (drag.stop) { drag.stop(); drag.stop = null; }
        }
        if (!drag.moved) return;
        const box = this.canvas.getBoundingClientRect();
        const { top, bh } = this.geom();
        this.levels[drag.i] = Math.max(0.02, Math.min(0.92, 1 - (ev.clientY - box.top - top) / bh));
        this.draw();
      });
      const end = () => {
        if (drag && drag.stop) drag.stop();
        else if (drag && !drag.moved && this.mode === "tap") this.sound(drag.i);
        drag = null;
      };
      ["pointerup", "pointercancel"].forEach((e) => this.canvas.addEventListener(e, end));
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }
    geom() {
      const n = this.levels.length, bw = Math.min(60, (this.w - 40) / n - 14);
      return { n, bw, gap: (this.w - n * bw) / (n + 1), top: 46, bh: this.h - 100 };
    }
    bottleAt(x) {
      const { n, bw, gap } = this.geom();
      for (let i = 0; i < n; i++) { const bx = gap + i * (bw + gap); if (x >= bx - 4 && x <= bx + bw + 4) return i; }
      return undefined;
    }
    resize() {
      const w = this.el.clientWidth, h = 240;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      this.draw();
    }
    blow(i) {
      const f = blowFreq(this.levels[i]);
      this.info.textContent = `дуем: ≈ ${Math.round(f)} Гц — чем больше воды, тем выше`;
      this.lit = { i, at: Infinity };
      this.draw();
      const stop = holdBlow(f);
      return () => { stop(); this.lit = null; this.draw(); };
    }

    sound(i) {
      audio();
      const t = ctx.currentTime, level = this.levels[i];
      if (this.mode === "tap") {
        const f = tapFreq(level);
        tone(t, f, 0, 0.9, 0.25); tone(t, f * 2.76, 0, 0.35, 0.06); hiss(t, 0.01, 0.15, "highpass", 5000);
        this.info.textContent = `стук: ≈ ${Math.round(f)} Гц — чем больше воды, тем ниже`;
      } else {
        const f = blowFreq(level);
        tone(t, f, 0, 1.1, 0.3); hiss(t, 1.0, 0.06, "bandpass", f * 2);
        this.info.textContent = `дуем: ≈ ${Math.round(f)} Гц — чем больше воды, тем выше`;
      }
      this.lit = { i, at: performance.now() };
      this.draw();
      setTimeout(() => this.draw(), 350);
    }
    draw() {
      const g = this.g, { n, bw, gap, top, bh } = this.geom();
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, this.w, this.h);
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
      const lit = this.lit && (this.lit.at === Infinity || performance.now() - this.lit.at < 300) ? this.lit.i : -1;
      this.levels.forEach((level, i) => {
        const x = gap + i * (bw + gap);
        g.fillStyle = i === lit ? "#fff3cc" : "#fff";
        g.fillRect(x, top, bw, bh);
        g.fillStyle = "#cfe0f7"; g.fillRect(x, top + bh * (1 - level), bw, bh * level);
        g.fillStyle = COLORS.right; g.font = "bold 14px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
        g.fillText("↕", x + bw / 2, top + bh * (1 - level) + 15);
        g.strokeStyle = COLORS.right; g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x + bw * 0.32, top - 26); g.lineTo(x + bw * 0.32, top); g.lineTo(x, top); g.lineTo(x, top + bh);
        g.lineTo(x + bw, top + bh); g.lineTo(x + bw, top); g.lineTo(x + bw * 0.68, top); g.lineTo(x + bw * 0.68, top - 26);
        g.stroke();
        const f = this.mode === "tap" ? tapFreq(level) : blowFreq(level);
        g.fillStyle = COLORS.text; g.textAlign = "center"; g.font = "bold 12px Segoe UI, Arial, sans-serif";
        g.fillText(`${Math.round(f)} Гц`, x + bw / 2, top + bh + 18);
        g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif";
        g.fillText(`${Math.round(level * 100)} % воды`, x + bw / 2, top + bh + 34);
      });
    }
  }

  // ---------- pot and film (1.1.1): sound travels through the air and makes grains jump ----------
  class PotLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: щёлкните по кастрюле или нажмите «Стукнуть»; «Спеть» звучит, пока держите. Волна показана замедленно: на самом деле звук летит тысячные доли секунды.");
      this.volume = 0.6;
      this.events = []; // {at, strength}: when a sound left the pot
      this.grains = Array.from({ length: 14 }, (_, i) => ({ x: (i + 0.5) / 14, h: 0, v: 0 }));
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<button type="button" class="player-play" data-a="hit">Стукнуть по кастрюле</button>' +
        '<button type="button" data-a="sing">Спеть «а-а-а»</button>' +
        '<label>Громкость <input type="range" min="10" max="100" value="60"></label>';
      el.append(this.canvas, bar);
      bar.querySelector("[data-a=hit]").addEventListener("click", () => this.hit());
      holdButton(bar.querySelector("[data-a=sing]"), () => this.sing());
      const vol = bar.querySelector("input");
      vol.addEventListener("input", () => (this.volume = vol.value / 100));
      this.canvas.addEventListener("pointerdown", (ev) => {
        const box = this.canvas.getBoundingClientRect();
        if (ev.clientX - box.left < this.w * 0.3) this.hit();
      });
      this.resize();
      window.addEventListener("resize", () => this.resize());
      this.loop();
    }
    resize() {
      const w = this.el.clientWidth, h = 200;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
    }
    hit() {
      audio();
      const t = ctx.currentTime, v = this.volume;
      hiss(t, 0.4, 0.25 * v, "bandpass", 3000);
      [523, 1187, 1879, 2790].forEach((f, i) => tone(t, f, 0, 1.2 - i * 0.2, (0.12 * v) / (i + 1)));
      this.events.push({ at: performance.now(), strength: v });
    }
    sing() {
      const stop = holdSing(this.volume);
      const wave = () => this.events.push({ at: performance.now(), strength: this.volume * 0.6 });
      wave();
      const timer = setInterval(wave, 250);
      return () => { clearInterval(timer); stop(); };
    }

    loop() {
      const now = performance.now();
      const travel = 700; // ms on screen for the trip from pot to bowl: slowed down, really ~1 ms
      this.events.forEach((e) => {
        if (!e.done && now - e.at >= travel) {
          e.done = true;
          this.grains.forEach((gr) => (gr.v = Math.max(gr.v, e.strength * (50 + Math.random() * 40))));
        }
      });
      this.events = this.events.filter((e) => now - e.at < travel + 200);
      this.grains.forEach((gr) => { gr.h = Math.max(0, gr.h + gr.v * 0.06); gr.v = gr.h > 0 || gr.v > 0 ? gr.v - 9.8 * 0.35 : 0; if (gr.h === 0 && gr.v < 0) gr.v = 0; });
      this.draw(now, travel);
      requestAnimationFrame(() => this.loop());
    }
    draw(now, travel) {
      const g = this.g, w = this.w, h = this.h;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, w, h);
      // pot
      const px = w * 0.06, pw = w * 0.2, py = h * 0.4, ph = h * 0.36;
      g.fillStyle = "#f6f6f2"; g.strokeStyle = "#555"; g.lineWidth = 2;
      roundRect(g, px, py, pw, ph, 8); g.fill(); g.stroke();
      g.fillStyle = COLORS.text; g.font = "bold 12px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
      g.fillText("кастрюля", px + pw / 2, py + ph / 2 + 4);
      // waves in flight
      const bx0 = w * 0.62, bx1 = w * 0.94, film = h * 0.55;
      this.events.forEach((e) => {
        const k = (now - e.at) / travel;
        if (k < 0 || k > 1) return;
        const x = px + pw + k * (bx0 - px - pw);
        g.strokeStyle = COLORS.right; g.globalAlpha = 0.3 + 0.7 * e.strength; g.lineWidth = 2.5;
        g.beginPath(); g.arc(x - 30, h * 0.55, 34, -0.7, 0.7); g.stroke(); g.globalAlpha = 1;
      });
      // bowl, film and grains
      g.fillStyle = "#f6f6f2"; g.strokeStyle = "#555"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(bx0, film); g.quadraticCurveTo(bx0, h * 0.9, (bx0 + bx1) / 2, h * 0.9);
      g.quadraticCurveTo(bx1, h * 0.9, bx1, film); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = COLORS.right; g.lineWidth = 3;
      g.beginPath(); g.moveTo(bx0 - 6, film); g.lineTo(bx1 + 6, film); g.stroke();
      g.fillStyle = COLORS.right;
      this.grains.forEach((gr) => { g.beginPath(); g.arc(bx0 + gr.x * (bx1 - bx0), film - 4 - gr.h, 3, 0, Math.PI * 2); g.fill(); });
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
      g.fillText("миска с плёнкой и крупой", (bx0 + bx1) / 2, h - 6);
      g.textAlign = "left";
    }
  }

  // Keys and MIDI go to the player last started or touched.
  let activePlayer = null;
  document.addEventListener("keydown", (ev) => {
    const p = activePlayer;
    if (!p || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName)) return;
    const key = p.kind === "piano" ? p.pianoKeyCodes && p.pianoKeyCodes[ev.code] : DRUM_KEYS[ev.code];
    if (key === undefined) return;
    ev.preventDefault();
    const stop = p.hit(key);
    if (stop) heldKeys[ev.code] = stop;
  });
  const heldKeys = {};
  document.addEventListener("keyup", (ev) => {
    if (heldKeys[ev.code]) { heldKeys[ev.code](); delete heldKeys[ev.code]; }
  });
  const heldMidi = {};

  let midiRequested = false;
  function requestMidi() {
    if (midiRequested || !navigator.requestMIDIAccess) return;
    midiRequested = true;
    navigator.requestMIDIAccess().then((access) => {
      const listen = (input) => (input.onmidimessage = (msg) => {
        const [status, note, velocity] = msg.data;
        const off = (status & 0xf0) === 0x80 || ((status & 0xf0) === 0x90 && velocity === 0);
        if (off && heldMidi[note]) { heldMidi[note](); delete heldMidi[note]; return; }
        if ((status & 0xf0) !== 0x90 || velocity === 0 || !activePlayer) return;
        if (activePlayer.kind === "piano") heldMidi[note] = activePlayer.hit(note);
        else if (GM_DRUMS[note]) activePlayer.hit(KIT[GM_DRUMS[note]].pad || GM_DRUMS[note], GM_DRUMS[note]);
      });
      access.inputs.forEach(listen);
      access.onstatechange = (ev) => ev.port.type === "input" && listen(ev.port);
    }).catch(() => {});
  }

  function init() {
    document.querySelectorAll(".lab[data-lab=ruler]").forEach((el) => el._lab || (el._lab = new RulerLab(el)));
    document.querySelectorAll(".lab[data-lab=octaves]").forEach((el) => el._lab || (el._lab = new OctaveLab(el)));
    document.querySelectorAll(".lab[data-lab=intervals]").forEach((el) => el._lab || (el._lab = new IntervalLab(el)));
    document.querySelectorAll(".lab[data-lab=ear]").forEach((el) => el._lab || (el._lab = new EarLab(el)));
    document.querySelectorAll(".lab[data-lab=chords]").forEach((el) => el._lab || (el._lab = new ChordLab(el)));
    document.querySelectorAll(".lab[data-lab=keyboard]").forEach((el) => el._lab || (el._lab = new KeyboardLab(el)));
    document.querySelectorAll(".lab[data-lab=string]").forEach((el) => el._lab || (el._lab = new StringLab(el)));
    document.querySelectorAll(".lab[data-lab=bottles]").forEach((el) => el._lab || (el._lab = new BottleLab(el)));
    document.querySelectorAll(".lab[data-lab=pot]").forEach((el) => el._lab || (el._lab = new PotLab(el)));
    document.querySelectorAll(".player").forEach((el) => {
      if (el._player) return;
      try {
        el._player = new Player(el);
      } catch (err) {
        el.textContent = "Плеер не смог разобрать запись: " + err.message;
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
