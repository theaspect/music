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
  // iOS plays Web Audio through the "ambient" session, which the silent switch mutes; Safari 16.4+ lets a page ask
  // for "playback". Touch pointerdown does not count as a user gesture in WebKit (pointerup/touchend do), so the
  // context is also started on the first of those anywhere on the page.
  if (navigator.audioSession) { try { navigator.audioSession.type = "playback"; } catch (e) { /* older Safari */ } }
  const unlock = () => {
    audio();
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    s.connect(ctx.destination); s.start();
    ["pointerup", "touchend", "keydown"].forEach((e) => document.removeEventListener(e, unlock, true));
  };
  ["pointerup", "touchend", "keydown"].forEach((e) => document.addEventListener(e, unlock, true));

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
    const stops = new Map(); // pointerId → stop: each finger holds its own note
    canvas.addEventListener("pointerdown", (ev) => {
      const box = canvas.getBoundingClientRect();
      audio();
      const stop = begin(ev.clientX - box.left, ev.clientY - box.top);
      if (stop) { ev.preventDefault(); stops.set(ev.pointerId, stop); canvas.setPointerCapture(ev.pointerId); }
    });
    const end = (ev) => { const stop = stops.get(ev.pointerId); if (stop) { stops.delete(ev.pointerId); stop(); } };
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
    const stops = new Map();
    btn.addEventListener("pointerdown", (ev) => {
      audio();
      const stop = start();
      if (stop) { ev.preventDefault(); stops.set(ev.pointerId, stop); btn.setPointerCapture(ev.pointerId); }
    });
    const end = (ev) => { const stop = stops.get(ev.pointerId); if (stop) { stops.delete(ev.pointerId); stop(); } };
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
  function holdSing(volume, pitch = 220) {
    const t = ctx.currentTime, g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.3 * volume, t + 0.1);
    g.connect(ctx.destination);
    const o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = "sawtooth"; o.frequency.value = pitch; lfo.frequency.value = 5; lg.gain.value = pitch / 70;
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
      this.stopTaps = new Map(); // pointerId → stop, for chords played with several fingers
      const endTap = (ev) => { const stop = this.stopTaps.get(ev.pointerId); if (stop) { this.stopTaps.delete(ev.pointerId); stop(); } };
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
      const stop = this.hit(target.key);
      if (stop) { this.stopTaps.set(ev.pointerId, stop); this.canvas.setPointerCapture(ev.pointerId); }
    }

    // One hit from any input: sound, flash, and in Play mode a verdict against the nearest expected note.
    // A piano key keeps sounding until the returned function is called; drums are one-shot.
    hit(key, soundKey) {
      audio();
      activePlayer = this;
      activeSynth = null;
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

  // Brackets under the white keys of each octave, labelled with its Russian name (как на схеме клавиатуры в 1.2).
  const OCTAVE_NAMES = ["субконтроктава", "контроктава", "большая октава", "малая октава", "первая октава", "вторая октава", "третья октава", "четвёртая октава", "пятая октава"];
  // The one way to name an octave (o = Math.floor(midi / 12); до первой октавы is midi 60, o = 5): full «первая октава»,
  // mid «первая», short «перв.» for tight spots. Scientific pitch (C4) only as a second form in explanations.
  const OCTAVE_SHORT = { "субконтроктава": "субконтр.", "контроктава": "контр.", "большая": "больш.", "малая": "мал.", "первая": "перв.",
                         "вторая": "втор.", "третья": "трет.", "четвёртая": "четв.", "пятая": "пят." };
  function octaveName(o, form) {
    const full = OCTAVE_NAMES[o - 1] || "", mid = full.replace(" октава", "");
    return form === "full" ? full : form === "short" ? OCTAVE_SHORT[mid] || mid : mid;
  }
  function octaveBrackets(g, keys, lo, hi, y) {
    for (let o = Math.floor(lo / 12); o <= Math.floor(hi / 12); o++) {
      const whites = [];
      for (let m = Math.max(lo, o * 12); m <= Math.min(hi, o * 12 + 11); m++) if (!isBlack(m)) whites.push(keys[m]);
      if (!whites.length) continue;
      const x1 = whites[0].x + 3, x2 = whites[whites.length - 1].x + whites[whites.length - 1].w - 3;
      g.strokeStyle = "#b8b8ae"; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(x1, y - 5); g.lineTo(x1, y); g.lineTo(x2, y); g.lineTo(x2, y - 5); g.stroke();
      g.fillStyle = COLORS.muted; g.textAlign = "center";
      g.font = `${whites.length > 2 ? 11 : 9}px Segoe UI, Arial, sans-serif`;
      g.fillText(octaveName(o, whites.length > 2 ? "full" : "mid"), (x1 + x2) / 2, y + 13);
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
  // A ruler clamped at the table edge is a cantilever, whose first mode is
  // f = 1.875² / (2π) · √(E·h² / (12·ρ)) / L² = K / L² (L in metres). Typical values, not measurements:
  //   plastic (acrylic) h = 2 mm, E = 3 GPa, ρ = 1190 kg/m³  → K ≈ 0.51
  //   wood along the grain h ≈ 3 mm, E ≈ 10 GPa, ρ ≈ 650 kg/m³ → K ≈ 1.90
  //   steel strip of a GOST 427 measuring ruler h = 0.5 mm (0.4–0.6), E = 200 GPa, ρ = 7850 kg/m³ → K ≈ 0.41
  // Damping (seconds for the swing to fade) and timbre differ too: steel rings on, wood dies at once.
  const RULER_MATERIALS = {
    plastic: { name: "Пластик, 2 мм", K: 0.513, tauLow: 1.4, tauHigh: 0.5, ring: 1.2, bright: 6, color: "#2f72c9" },
    wood: { name: "Дерево, 3 мм", K: 1.90, tauLow: 0.5, tauHigh: 0.25, ring: 0.45, bright: 3, color: "#b07a3c" },
    steel: { name: "Сталь, 0,5 мм (ГОСТ 427)", K: 0.408, tauLow: 3, tauHigh: 1.6, ring: 2.6, bright: 12, color: "#7d8793" },
  };
  // The second bending mode of a cantilever is (4.694 / 1.875)² ≈ 6.27 times the first: this is the hum one hears
  // from a long ruler, pulsing with the slow swing, together with the slap against the table edge on every swing.
  const SECOND_MODE = 6.27;
  const RULER_CM = 30;

  // What one hears from a ruler: its swing once that is audible (from 20 Hz), otherwise the hum of the second mode.
  const rulerFreq = (cm, K) => K / (cm / 100) ** 2;
  const rulerHeard = (cm, K) => (rulerFreq(cm, K) >= 20 ? rulerFreq(cm, K) : rulerFreq(cm, K) * SECOND_MODE);
  // Free lengths (3–28 cm) at which the heard pitch is exactly a white note, per material.
  const rulerNotesCache = {};
  function rulerNotes(K) {
    if (rulerNotesCache[K]) return rulerNotesCache[K];
    const out = [];
    for (let m = 12; m <= 108; m++) {
      if (isBlack(m)) continue;
      const f = midiFreq(m);
      const swing = Math.sqrt(K / f) * 100, hum = Math.sqrt((K * SECOND_MODE) / f) * 100;
      if (swing >= 3 && swing <= 28 && rulerFreq(swing, K) >= 20) out.push({ cm: swing, m });
      if (hum >= 3 && hum <= 28 && rulerFreq(hum, K) < 20) out.push({ cm: hum, m });
    }
    return (rulerNotesCache[K] = out);
  }
  const cmText = (cm) => (Math.round(cm * 10) / 10).toString().replace(".", ",");

  class RulerLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: тяните линейку вправо или влево — меняется свисающий конец; тяните вниз — оттягиваете его, можно одновременно. Отпустите — чем сильнее оттянули, тем больше размах и громче звук; щелчок — самый сильный.");
      this.free = 20; // cm hanging over the edge
      this.mat = RULER_MATERIALS.plastic;
      this.pluckedAt = null;
      this.canvas = document.createElement("canvas");
      this.canvas.style.touchAction = "none"; // the ruler is dragged both ways: sideways for length, down to pull
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML =
        '<button type="button" class="player-play">Щёлкнуть</button>' +
        '<button type="button" data-scale="1">▶ Ноты по очереди</button>' +
        '<span class="player-mode">' + Object.entries(RULER_MATERIALS).map(([k, m], i) =>
          `<button type="button" data-mat="${k}"${i === 0 ? ' class="on"' : ""}>${m.name}</button>`).join("") + "</span>" +
        '<span class="player-score lab-info"></span>';
      el.append(this.canvas, bar);
      this.info = bar.querySelector(".lab-info");
      // the scale from the nearest до below the current pitch, the ruler sliding to each note by itself
      bar.querySelector("[data-scale]").addEventListener("click", () => {
        audio();
        clearTimeout(this.scaleTimer);
        const K = this.mat.K, swing = rulerFreq(this.free, K) >= 20;
        const notes = rulerNotes(K).filter((n) => (rulerFreq(n.cm, K) >= 20) === swing).sort((a, b) => a.m - b.m);
        const now = Math.round(69 + 12 * Math.log2(rulerHeard(this.free, K) / 440));
        const dos = notes.filter((n) => n.m % 12 === 0 && n.m <= now);
        const from = dos.length ? dos[dos.length - 1].m : notes.length ? notes[0].m : null;
        const run = notes.filter((n) => from !== null && n.m >= from && n.m <= from + 12);
        const step = (i) => {
          if (i >= run.length) return;
          this.free = run[i].cm; this.pluckedAt = null; this.update(); this.pluck();
          this.scaleTimer = setTimeout(() => step(i + 1), 700);
        };
        step(0);
      });
      bar.querySelectorAll("[data-mat]").forEach((b) => b.addEventListener("click", () => {
        bar.querySelectorAll("[data-mat]").forEach((x) => x.classList.toggle("on", x === b));
        this.mat = RULER_MATERIALS[b.dataset.mat];
        this.pluckedAt = null;
        this.update();
      }));
      bar.querySelector("button").addEventListener("click", () => this.pluck());
      // Drag the ruler sideways to push it out over the edge or back onto the table; a short click flicks it.
      let press = null;
      this.canvas.addEventListener("pointerdown", (ev) => {
        if (press) return; // the ruler follows one finger; extra touches are ignored
        const box = this.canvas.getBoundingClientRect(), x = ev.clientX - box.left, y = ev.clientY - box.top;
        if (y > this.sceneH - 72 && y < this.sceneH && x > this.edge) {
          // the note scale: move the ruler to the tick under the pointer (or to that length), no flick
          const L = (x - this.edge) / this.cm;
          const near = rulerNotes(this.mat.K).reduce((a, b) => (!a || Math.abs(b.cm - L) < Math.abs(a.cm - L) ? b : a), null);
          const free = near && Math.abs(near.cm - L) * this.cm < 12 ? near.cm : Math.round(L * 10) / 10;
          this.free = Math.max(3, Math.min(28, free)); this.pluckedAt = null; this.update();
          ev.preventDefault();
          return;
        }
        press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, free: this.free, mode: null };
        this.canvas.setPointerCapture(ev.pointerId);
        ev.preventDefault();
      });
      this.canvas.addEventListener("pointermove", (ev) => {
        if (!press || ev.pointerId !== press.id) return;
        const dx = ev.clientX - press.x, dy = ev.clientY - press.y;
        // both at once: sideways changes the length, down pulls the tip
        if (!press.mode && Math.hypot(dx, dy) > 4) press.mode = "drag";
        if (!press.mode) return;
        this.pull = Math.max(0, Math.min(this.maxAmp || 60, dy));
        this.pluckedAt = null;
        let free = Math.max(3, Math.min(28, press.free + dx / this.cm));
        const notes = rulerNotes(this.mat.K);
        const near = notes.length ? notes.reduce((a, b) => (Math.abs(b.cm - free) < Math.abs(a.cm - free) ? b : a)) : null;
        free = near && Math.abs(near.cm - free) < 0.3 ? near.cm : Math.round(free * 10) / 10; // snap to a note within 3 mm
        if (free !== this.free) { this.free = free; this.update(); } else this.draw(0);
      });
      const end = (ev) => {
        if (!press || ev.pointerId !== press.id) return;
        if (press.mode) {
          // a real pull (more than 8 px down) plucks with its strength; a sideways slide with a shaky hand does not
          const strength = this.pull > 8 ? this.pull / (this.maxAmp || 60) : 0;
          this.pull = null;
          if (strength) this.pluck(strength); else this.draw(0);
        } else this.pluck(1);
        press = null;
      };
      ["pointerup", "pointercancel"].forEach((e) => this.canvas.addEventListener(e, end));
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    freq() { return rulerFreq(this.free, this.mat.K); }

    resize() {
      const w = this.el.clientWidth, sceneH = Math.round(Math.min(260, w * 0.45)), h = sceneH + 240;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h; this.sceneH = sceneH;
      this.update();
      // the bending modes below the scene move continuously, but only while the lab is on screen
      if (!this.observer && window.IntersectionObserver) {
        this.observer = new IntersectionObserver(([entry]) => {
          this.visible = entry.isIntersecting;
          const tick = () => {
            if (!this.visible) return;
            this.draw(this.pluckedAt ? (performance.now() - this.pluckedAt) / 1000 : 0);
            requestAnimationFrame(tick);
          };
          if (this.visible) requestAnimationFrame(tick);
        });
        this.observer.observe(this.canvas);
      }
    }

    update() {
      const f = this.freq();
      const f2 = Math.round(f * SECOND_MODE);
      const heard = rulerHeard(this.free, this.mat.K);
      this.info.textContent = `слышно ${nearestNote(heard)} (${hz(heard)} Гц). ` +
        `≈ ${f < 20 ? f.toFixed(1).replace(".", ",") : Math.round(f)} колебаний в секунду — ` +
        (f < 20 ? `само качание не слышно (ниже 20), слышны стук о стол и гул второго изгиба ≈ ${f2} Гц`
                : `глазом не уследить, ухо слышит гудение; второй изгиб ≈ ${f2} Гц`);
      this.draw(0);
    }

    // strength 0…1: how far the tip was pulled down; a click is the strongest
    pluck(strength = 1) {
      audio();
      this.strength = strength;
      const f = this.freq();
      const t = ctx.currentTime;
      hiss(t, 0.03, 0.3 * strength, "bandpass", 2500); // the flick of a finger, or the release
      if (f < 20) {
        // the slow swing itself is inaudible: what sounds is a slap on every swing and the pulsing second mode
        const tau = this.mat.tauLow, len = Math.min(5, tau * 2.2);
        for (let k = 1; k / f < len; k++) {
          const level = Math.exp(-k / f / tau);
          if (level < 0.05) break;
          hiss(t + k / f, 0.025, 0.35 * level * strength, "bandpass", 1200);
        }
        const o = ctx.createOscillator(), g2 = ctx.createGain();
        o.type = "triangle";
        o.frequency.value = f * SECOND_MODE;
        const curve = new Float32Array(300);
        for (let i = 0; i < curve.length; i++) {
          const s = (i / (curve.length - 1)) * len;
          curve[i] = 0.25 * strength * Math.exp(-s / tau) * Math.abs(Math.cos(2 * Math.PI * f * s));
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
        filter.frequency.value = Math.min(8000, f * this.mat.bright);
        o.connect(filter);
        filter.connect(envGain(t, Math.max(0.001, 0.35 * strength), this.mat.ring));
        o.start(t);
        o.stop(t + this.mat.ring + 0.1);
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
      const g = this.g, w = this.w, h = this.sceneH;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, w, this.h);
      this.drawModes(h);
      const cm = (w - 40) / 40; // pixels per centimetre; 40 cm of scene
      this.cm = cm;
      const edge = 20 + 12 * cm; // table edge
      this.edge = edge;
      const y0 = h * 0.42;
      const freeLen = this.free * cm;
      // table and hand
      g.fillStyle = "#f6f6f2"; g.strokeStyle = COLORS.line; g.lineWidth = 1.5;
      g.fillRect(0, y0 + 4, edge, h - y0 - 8); g.strokeRect(-1, y0 + 4, edge + 1, h - y0 - 8);
      const clamp = edge - (RULER_CM - this.free) * cm; // where the ruler's far end lies on the table
      g.fillStyle = "#7eaee6"; g.strokeStyle = COLORS.right;
      roundRect(g, Math.max(4, edge - 7 * cm), y0 - 18, 5 * cm, 16, 5); g.fill(); g.stroke();
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
      g.fillText("рука прижимает", Math.max(4, edge - 7 * cm) + 2.5 * cm, y0 - 24);

      const f = this.freq();
      this.maxAmp = Math.min(h * 0.32, freeLen * 0.5);
      const amp = this.pluckedAt ? Math.exp(-age / (f < 20 ? this.mat.tauLow : this.mat.tauHigh)) * this.maxAmp * (this.strength ?? 1) : 0;
      const shape = (x) => { const s = x / freeLen; return (s * s * (3 - s)) / 2; }; // bent cantilever
      const ruler = (tip, alpha) => {
        g.globalAlpha = alpha;
        g.strokeStyle = this.mat.color; g.lineWidth = this.mat === RULER_MATERIALS.steel ? 4 : this.mat === RULER_MATERIALS.wood ? 9 : 7;
        g.lineCap = "butt";
        g.beginPath(); g.moveTo(Math.max(0, clamp), y0); g.lineTo(edge, y0);
        for (let x = 0; x <= freeLen; x += 4) g.lineTo(edge + x, y0 + tip * shape(x));
        g.stroke();
        g.globalAlpha = 1;
      };
      if (this.pull != null) {
        // pulled down and held: the ruler bends after the finger, the size of the swing to come
        ruler(this.pull, 1);
        g.fillStyle = COLORS.right; g.font = "bold 12px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
        g.fillText(`отпустите — размах ${Math.round((this.pull / this.maxAmp) * 100)} %`, edge + freeLen, y0 + this.pull + 22);
      } else if (amp > 0.5 && f > 15) {
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
      // white-note lengths as ticks on the length scale; only до is labelled, the rest would crowd at short lengths
      rulerNotes(this.mat.K).forEach(({ cm: L, m }) => {
        const x = edge + L * cm;
        g.strokeStyle = m % 12 === 0 ? COLORS.right : "#b8b8ae"; g.lineWidth = m % 12 === 0 ? 2 : 1;
        g.beginPath(); g.moveTo(x, h - 28); g.lineTo(x, h - 16); g.stroke();
        if (m % 12 === 0) {
          g.fillStyle = COLORS.right; g.font = "bold 10px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
          g.fillText("до", x, h - 32);
        }
      });
      // octaves as brackets above the ticks: each is shorter than the previous, though not by half as on a string
      // (a ruler's pitch grows as 1/L², so one octave up is a √2 ≈ 1.41 times shorter length)
      const K = this.mat.K, Lhum = Math.sqrt(K / 20) * 100;
      const groups = {};
      rulerNotes(K).forEach(({ cm: L, m }) => {
        const key = `${rulerFreq(L, K) >= 20 ? "s" : "h"}${Math.floor(m / 12)}`;
        (groups[key] = groups[key] || []).push(L);
      });
      Object.entries(groups).forEach(([key, Ls]) => {
        if (Ls.length < 2) return;
        const xa = edge + Math.min(...Ls) * cm + 2, xb = edge + Math.max(...Ls) * cm - 2, y = h - 44;
        if (xb - xa < 8) return;
        g.strokeStyle = "#b8b8ae"; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(xa, y + 4); g.lineTo(xa, y); g.lineTo(xb, y); g.lineTo(xb, y + 4); g.stroke();
        const o = Number(key.slice(1));
        g.fillStyle = COLORS.muted; g.font = "9px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
        g.fillText(octaveName(o, xb - xa > 60 ? "mid" : "short"), (xa + xb) / 2, y - 3);
      });
      if (Lhum > 3 && Lhum < 28) {
        const xb = edge + Lhum * cm;
        g.strokeStyle = COLORS.bad; g.lineWidth = 1; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(xb, h - 70); g.lineTo(xb, h - 16); g.stroke(); g.setLineDash([]);
        g.fillStyle = COLORS.bad; g.font = "10px Segoe UI, Arial, sans-serif";
        g.textAlign = "right"; g.fillText("слышно качание ←", xb - 4, h - 62);
        g.textAlign = "left"; g.fillText("→ слышен гул 2-го изгиба", xb + 4, h - 62);
      }
      g.fillStyle = COLORS.text; g.font = "bold 12px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
      const note = nearestNote(rulerHeard(this.free, this.mat.K));
      g.fillText(`${cmText(this.free)} см свободно — ${note}`, edge + freeLen / 2, h - 2);
      if (!this.pluckedAt || age > 2) arrows(g, edge + freeLen - 10, y0 - 30, "тяните");
    }

    // The first two bending modes of a clamped ruler, in slow motion: the second bends as an S around a node
    // that stays still, about 0.78 of the free length from the edge, and moves 6.27 times as often.
    // The first three bending modes of a clamped ruler, in slow motion. A clamped–free beam allows only shapes with
    // βL = 1.875, 4.694, 7.855, 10.996…; frequency grows as (βL)², hence 1 : 6.27 : 17.5 : 34.4 : 56.8 — not whole
    // numbers, unlike a string (1 : 2 : 3 …), which is why a ruler buzzes rather than sounds a clean note.
    drawModes(top) {
      const g = this.g, w = this.w, f = this.freq();
      g.strokeStyle = COLORS.line; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, top + 0.5); g.lineTo(w, top + 0.5); g.stroke();
      const now = performance.now() / 1000;
      const panels = [[1, "1-й: целиком", 1, []], [2, "2-й: волной", 6.27, [0.7834]], [3, "3-й: двумя волнами", 17.55, [0.5035, 0.8677]]];
      const third = w / 3;
      panels.forEach(([n, title, ratio, nodes], i) => {
        const x0 = 12 + i * third, len = third - 34, y = top + 64;
        g.fillStyle = COLORS.text; g.font = `bold ${Math.min(12, w / 70)}px Segoe UI, Arial, sans-serif`; g.textAlign = "left";
        g.fillText(`${title} — ${hz(f * ratio)} Гц`, x0, top + 18);
        g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif";
        g.fillText(n === 1 ? "основное качание" : `в ${String(ratio).replace(".", ",")} раза чаще первого`, x0, top + 32);
        g.fillStyle = "#f6f6f2"; g.strokeStyle = COLORS.line; g.fillRect(x0, y - 14, 8, 28); g.strokeRect(x0, y - 14, 8, 28);
        const shapeAt = (s) => cantilever(n, s) / cantilever(n, 1);
        const line = (k, alpha, width) => {
          g.globalAlpha = alpha; g.strokeStyle = this.mat.color; g.lineWidth = width;
          g.beginPath();
          for (let s = 0; s <= 1.0001; s += 0.02) g.lineTo(x0 + 8 + s * len, y - 22 * k * shapeAt(s));
          g.stroke(); g.globalAlpha = 1;
        };
        line(1, 0.15, 3); line(-1, 0.15, 3);
        line(Math.sin(2 * Math.PI * 0.4 * Math.sqrt(ratio) * now), 1, 3.5);
        nodes.forEach((s) => {
          g.fillStyle = COLORS.bad; g.beginPath(); g.arc(x0 + 8 + s * len, y, 3.5, 0, Math.PI * 2); g.fill();
        });
      });
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
      g.fillText("красные точки не двигаются. Дальше — 4-й изгиб в 34,4 раза чаще, 5-й в 56,8… Числа нецелые, поэтому линейка", 12, top + 110);
      g.fillText("не звучит чистой нотой, а гудит и дребезжит; у струны такие колебания идут ровно в 2, 3, 4 раза чаще. Показано замедленно.", 12, top + 124);
      // The sum, drawn twice. Left: the ruler itself, bent by all three modes at once (same slow motion as the panels
      // above, so the sum of what they show is visible). Right: the tip's motion in time. Sizes are illustrative.
      const modes = [[1, 1, "#7eaee6"], [2, 0.35, "#e0892b"], [3, 0.15, "#8e44ad"]];
      const ratios = [1, 6.27, 17.55];
      const vis = (n) => 0.4 * Math.sqrt(ratios[n - 1]); // the panels' slow-motion speeds
      g.fillStyle = COLORS.text; g.font = "bold 12px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
      g.fillText("Сумма: линейка гнётся всеми изгибами сразу", 12, top + 148);
      const lw = Math.round(w * 0.42), rx0 = 12, rlen = lw - 40, ry = top + 192;
      g.fillStyle = "#f6f6f2"; g.strokeStyle = COLORS.line; g.fillRect(rx0, ry - 16, 10, 32); g.strokeRect(rx0, ry - 16, 10, 32);
      const bend = (n, s) => cantilever(n, s) / cantilever(n, 1);
      const shapeAt = (s, only) => modes.reduce((sum, [n, a]) =>
        only && only !== n ? sum : sum + a * bend(n, s) * Math.sin(2 * Math.PI * vis(n) * now), 0);
      modes.forEach(([n, , color]) => {
        g.strokeStyle = color; g.lineWidth = 1.2; g.globalAlpha = 0.8; g.beginPath();
        for (let s = 0; s <= 1.0001; s += 0.01) g.lineTo(rx0 + 10 + s * rlen, ry - 24 * shapeAt(s, n));
        g.stroke(); g.globalAlpha = 1;
      });
      g.strokeStyle = this.mat.color; g.lineWidth = 5; g.beginPath();
      for (let s = 0; s <= 1.0001; s += 0.01) g.lineTo(rx0 + 10 + s * rlen, ry - 24 * shapeAt(s));
      g.stroke();
      // right: the tip in time, with the true ratios 1 : 6.27 : 17.55, scrolling slowly
      const tx0 = lw + 10, tlen = w - lw - 22, ty = ry;
      g.strokeStyle = "#e4e4dc"; g.lineWidth = 1; g.beginPath(); g.moveTo(tx0, ty); g.lineTo(tx0 + tlen, ty); g.stroke();
      g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif";
      g.fillText("кончик линейки во времени", tx0, top + 164);
      const periods = 2, shift = now * 0.25;
      const part = (i, x) => modes[i][1] * 24 * Math.sin(2 * Math.PI * ratios[i] * (periods * x / tlen + shift));
      modes.forEach(([, , color], i) => {
        g.strokeStyle = color; g.lineWidth = 1.2; g.beginPath();
        for (let x = 0; x <= tlen; x += 1) g.lineTo(tx0 + x, ty - part(i, x));
        g.stroke();
      });
      g.strokeStyle = this.mat.color; g.lineWidth = 2.5; g.beginPath();
      for (let x = 0; x <= tlen; x += 1) g.lineTo(tx0 + x, ty - modes.reduce((s, m, i) => s + part(i, x), 0));
      g.stroke();
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif";
      g.fillText("тонкие — 1-й (голубой), 2-й (оранжевый) и 3-й (фиолетовый) изгибы, толстая — их сумма: так линейка и движется, и такой звук мы слышим", 12, top + 234);
    }
  }

  // Mode shapes of a clamped–free beam (Euler–Bernoulli): s is the share of the free length from the clamp.
  function cantilever(n, s) {
    const [b, sigma] = [[1.875104, 0.734096], [4.694091, 1.018467], [7.854757, 0.999224]][n - 1];
    const x = b * s;
    return Math.cosh(x) - Math.cos(x) - sigma * (Math.sinh(x) - Math.sin(x));
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
        this.pc = m; // 0…12: 12 is до of the next octave
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
      this.lo = 0; this.hi = 12;
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
      for (let m = 0; m <= 12; m++) {
        if (isBlack(m)) continue;
        const k = this.keys[m], on = m === this.pc;
        g.fillStyle = m === this.down ? COLORS.flash : on ? "#e3eaf7" : m === 12 ? "#f1f1ea" : "#fff";
        roundRect(g, k.x + 1, top, k.w - 2, keysH, 6); g.fill();
        g.strokeStyle = on ? COLORS.right : "#cfcfc6"; g.lineWidth = on ? 2.5 : 1.5; g.stroke();
        g.fillStyle = "#222"; g.font = `${on ? "bold " : ""}${Math.min(15, kw * 0.22)}px Segoe UI, Arial, sans-serif`;
        g.fillText(NAMES[m % 12], k.x + k.w / 2, top + keysH - 30);
        if (m === 12) {
          g.fillStyle = COLORS.muted; g.font = `${Math.min(10, kw * 0.15)}px Segoe UI, Arial, sans-serif`;
          g.fillText("следующая", k.x + k.w / 2, top + keysH * 0.68);
          g.fillText("октава", k.x + k.w / 2, top + keysH * 0.68 + 12);
          g.strokeStyle = COLORS.right; g.lineWidth = 2; g.setLineDash([4, 3]);
          g.beginPath(); g.moveTo(k.x, top - 4); g.lineTo(k.x, top + keysH + 4); g.stroke(); g.setLineDash([]);
        }
        g.fillStyle = COLORS.muted; g.font = `${Math.min(12, kw * 0.18)}px Segoe UI, Arial, sans-serif`;
        g.fillText(`${hz(this.noteFreq(m, this.oct))} Гц`, k.x + k.w / 2, top + keysH - 12);
      }
      for (let m = 0; m <= 12; m++) {
        if (!isBlack(m)) continue;
        const k = this.keys[m], on = m === this.pc;
        g.fillStyle = m === this.down ? COLORS.flash : on ? COLORS.right : "#c5c5bc";
        roundRect(g, k.x, top - 1, k.w, keysH * 0.6 + 1, 4); g.fill();
        g.fillStyle = on ? "#fff" : "#333"; g.font = `${Math.min(11, k.w * 0.2)}px Segoe UI, Arial, sans-serif`;
        g.fillText(NAMES[m], k.x + k.w / 2, top + keysH * 0.6 - 22);
        g.fillText(hz(this.noteFreq(m, this.oct)), k.x + k.w / 2, top + keysH * 0.6 - 8);
      }
      if (this.freq) { this.info.textContent = this.text; return; }
      const next = this.pc === 12;
      const octIdx = this.oct + (next ? 1 : 0);
      const [, gen, sci] = OCTAVES[Math.min(octIdx, OCTAVES.length - 1)];
      const genText = octIdx < OCTAVES.length ? gen : "следующей октавы";
      const lower = `${hz(f / 2)} Гц октавой ниже`;
      const upper = `${hz(f * 2)} Гц октавой выше`;
      this.info.textContent = `${NAMES[this.pc % 12]} ${genText} (${LETTERS[this.pc % 12]}${octIdx < OCTAVES.length ? sci : OCTAVES[OCTAVES.length - 1][2] + 1})` +
        (next ? ", уже из следующей октавы" : "") + ` — ${hz(f)} Гц; ${lower}, ${upper}`;
    }
  }

  // ---------- intervals (1.5) ----------
  // Exact ratios, as on a monochord: the waves of the two notes meet again every `q` periods of the lower one.
  // [name, p, q, example, semitones from до]
  const INTERVALS = [["Октава", 2, 1, "до–до", 12], ["Квинта", 3, 2, "до–соль", 7], ["Кварта", 4, 3, "до–фа", 5],
                     ["Б. терция", 5, 4, "до–ми", 4], ["М. терция", 6, 5, "до–ми♭", 3], ["Б. секунда", 9, 8, "до–ре", 2],
                     ["М. секунда", 16, 15, "до–до♯", 1]];
  // A tiny keyboard from до to до with the pressed keys in blue, to sit inside an interval box.
  function miniKeys(g, x, y, w, h, pressed) {
    const kw = w / 8;
    const white = [0, 2, 4, 5, 7, 9, 11, 12];
    white.forEach((m, i) => {
      g.fillStyle = pressed.includes(m) ? COLORS.right : "#fff";
      g.fillRect(x + i * kw, y, kw, h);
      g.strokeStyle = "#b8b8ae"; g.lineWidth = 0.8; g.strokeRect(x + i * kw, y, kw, h);
    });
    [[1, 0], [3, 1], [6, 3], [8, 4], [10, 5]].forEach(([m, after]) => {
      g.fillStyle = pressed.includes(m) ? COLORS.right : "#8f8f86";
      g.fillRect(x + (after + 1) * kw - kw * 0.3, y, kw * 0.6, h * 0.6);
    });
    // the eighth key is до of the next octave
    g.strokeStyle = COLORS.right; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x + 7 * kw, y - 2); g.lineTo(x + 7 * kw, y + h + 2); g.stroke();
  }
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
      // beats close up: до and до a few hertz higher, as pure tones — the slow wobble that turns into roughness
      const beats = document.createElement("div");
      beats.className = "player-controls";
      beats.innerHTML = "<b>Биения крупным планом:</b>" + [2, 6, 17].map((d) =>
        `<button type="button" data-beat="${d}">до + до на ${d} Гц выше${d === 17 ? " (как малая секунда)" : ""}</button>`).join("");
      el.append(this.canvas, bar, beats);
      this.info = bar.querySelector(".lab-info");
      bar.querySelector("button").addEventListener("click", () => { this.demo = null; this.play(); });
      beats.querySelectorAll("[data-beat]").forEach((b) => holdButton(b, () => {
        this.demo = Number(b.dataset.beat);
        this.draw();
        const stops = [holdSine(DO4, 0.15), holdSine(DO4 + this.demo, 0.15)];
        return () => stops.forEach((s) => s());
      }));
      holdable(this.canvas, (x, y) => {
        if (y > this.boxBottom) return;
        this.pick = Math.max(0, Math.min(6, Math.floor((x / this.w) * 7)));
        this.demo = null;
        this.draw();
        const [, pn, q] = INTERVALS[this.pick];
        const stops = [holdNote(DO4), holdNote((DO4 * pn) / q)];
        return () => stops.forEach((s) => s());
      });
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    resize() {
      const w = this.el.clientWidth, h = Math.round(Math.min(400, w * 0.6));
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
      const n = INTERVALS.length, gap = 6, bw = (w - 16 - gap * (n - 1)) / n, bh = Math.min(96, h * 0.36), top = 8;
      this.boxBottom = top + bh;
      INTERVALS.forEach(([name, pn, q, ex, semis], i) => {
        const x = 8 + i * (bw + gap), good = i < 5, on = i === this.pick;
        g.fillStyle = good ? "#e6f4e6" : "#f9e6e6";
        roundRect(g, x, top, bw, bh, 8); g.fill();
        g.strokeStyle = good ? "#2a9d4b" : COLORS.bad; g.lineWidth = on ? 3 : 1.5; g.stroke();
        g.textAlign = "center"; g.fillStyle = COLORS.text;
        g.font = `bold ${Math.min(13, bw * 0.13)}px Segoe UI, Arial, sans-serif`;
        g.fillText(name, x + bw / 2, top + bh * 0.22);
        g.font = `${Math.min(13, bw * 0.13)}px Segoe UI, Arial, sans-serif`;
        g.fillText(`${pn} : ${q}`, x + bw / 2, top + bh * 0.42);
        g.fillStyle = COLORS.muted; g.fillText(ex, x + bw / 2, top + bh * 0.6);
        miniKeys(g, x + 6, top + bh * 0.68, bw - 12, bh * 0.24, [0, semis]);
      });
      // Top: each note over q periods of the lower one, with a line at the start of every period of each: where a
      // grey (lower) and a dashed blue (upper) line coincide, the waves start together again — marked green.
      const [name, pn, q] = INTERVALS[this.pick];
      const f1 = DO4, f2 = this.demo ? DO4 + this.demo : (DO4 * pn) / q;
      const x0 = 8, len = w - 16, rowsTop = top + bh + 10, shortH = (h - rowsTop) * 0.44;
      const periods = this.demo ? 4 : Math.max(2, q), ratio = f2 / f1;
      const xAt = (per) => x0 + (per / periods) * len; // per: periods of the lower note
      for (let k = 0; k <= periods; k++) {
        const meet = !this.demo && Math.abs(k * ratio - Math.round(k * ratio)) < 1e-6;
        g.strokeStyle = meet ? "#2a9d4b" : "#c9c9c0"; g.lineWidth = meet ? 2.5 : 1;
        g.beginPath(); g.moveTo(xAt(k), rowsTop); g.lineTo(xAt(k), rowsTop + shortH); g.stroke();
      }
      for (let k = 0; k <= periods * ratio + 1e-9; k++) {
        g.strokeStyle = "#7eaee6"; g.lineWidth = 1; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(xAt(k / ratio), rowsTop + shortH / 2); g.lineTo(xAt(k / ratio), rowsTop + shortH); g.stroke(); g.setLineDash([]);
      }
      [[1, rowsTop + shortH * 0.25, "нижняя нота — серые линии"], [ratio, rowsTop + shortH * 0.75, "верхняя нота — синие пунктирные"]].forEach(([k, mid, label]) => {
        g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
        g.fillText(label, x0 + 2, mid - shortH * 0.16);
        g.strokeStyle = COLORS.right; g.lineWidth = periods > 8 ? 1 : 1.6; g.beginPath();
        for (let x = 0; x <= len; x += 0.5) g.lineTo(x0 + x, mid - shortH * 0.17 * Math.sin(2 * Math.PI * k * periods * x / len));
        g.stroke();
      });
      // Bottom: the sum over real time with its loudness (the envelope): it wobbles when the notes beat.
      const span = this.demo ? 1 : 0.2, by = rowsTop + shortH + 22, bh2 = h - by - 6, mid = by + bh2 / 2;
      g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
      g.fillText(`вместе за ${span === 1 ? "1 секунду" : "0,2 секунды"}: серое — сумма волн, цветное — её громкость`, x0 + 2, by - 6);
      const N = Math.round(len * 4), dt = span / N, s = new Float32Array(N);
      for (let i = 0; i < N; i++) s[i] = (Math.sin(2 * Math.PI * f1 * i * dt) + Math.sin(2 * Math.PI * f2 * i * dt)) / 2;
      g.strokeStyle = "#c9c9c0"; g.lineWidth = 0.6; g.beginPath();
      for (let i = 0; i < N; i++) g.lineTo(x0 + (i / N) * len, mid - (bh2 / 2 - 4) * s[i]);
      g.stroke();
      const win = Math.max(2, Math.round(1 / f1 / dt)), env = new Float32Array(N);
      for (let i = 0; i < N; i++) { let m = 0; for (let j = Math.max(0, i - win); j < Math.min(N, i + win); j++) m = Math.max(m, Math.abs(s[j])); env[i] = m; }
      g.strokeStyle = this.demo || this.pick >= 5 ? COLORS.bad : "#2a9d4b"; g.lineWidth = 2.5;
      [1, -1].forEach((sign) => {
        g.beginPath();
        for (let i = 0; i < N; i += 2) g.lineTo(x0 + (i / N) * len, mid - sign * (bh2 / 2 - 4) * env[i]);
        g.stroke();
      });
      const diff = Math.round(f2 - f1);
      if (this.demo) {
        this.info.textContent = `до и до на ${this.demo} Гц выше: громкость пульсирует ${this.demo} ${plural(this.demo, "раз", "раза", "раз")} в секунду — это биения` +
          (this.demo >= 15 ? ". Так быстро, что пульсаций по отдельности не разобрать — слышна шероховатость, как у малой секунды" : ", их хорошо слышно как «вау-вау»");
      } else {
        this.info.textContent = this.pick < 5
          ? `${name}: ${Math.round(f1)} и ${Math.round(f2)} Гц. Волны снова начинаются вместе каждые ${q} ${plural(q, "колебание", "колебания", "колебаний")} нижней ноты (зелёные линии), громкость суммы ровная — биений нет, звуки сливаются`
          : `${name}: ${Math.round(f1)} и ${Math.round(f2)} Гц, разница ${diff} Гц. Волны сходятся лишь раз в ${q} колебаний нижней ноты, громкость суммы качается ${diff} раз в секунду (красная линия) — это биения, на слух шероховатость. Медленные биения — кнопками ниже`;
      }
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
      this.lo = 60; this.hi = 84; // до4 … до6
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
      const w = this.el.clientWidth, h = Math.round(Math.min(190, w * 0.32)) + 24;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      this.layout();
      this.keysH -= 24; // room for the octave brackets
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
      octaveBrackets(g, this.keys, this.lo, this.hi, top + keysH + 8);
      const notes = [...this.chosen].sort((a, b) => a - b);
      const names = notes.map((m, i) => NAMES[m % 12] + (i && m - notes[0] >= 12 ? " (октавой выше)" : "")).join(" + ");
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
      const w = this.el.clientWidth, h = Math.round(Math.min(210, w * 0.34)) + 24;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      ChordLab.prototype.layout.call(this);
      this.keysH = this.h - 58;
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
      octaveBrackets(g, this.keys, this.lo, this.hi, top + keysH + 32);
    }
  }

  // ---------- bow string (1.1.1): press with a finger, pluck the sounding part ----------
  // The open string is tuned to до of the small octave; the scale comes from simple length ratios (just intonation).
  const STRING_BASE = 130.81;
  const STRING_MARKS = [
    [1, "до", "вся струна — исходный звук", "вся"],
    [15 / 16, "до♯", "15/16 струны — малая секунда выше", "15/16"],
    [8 / 9, "ре", "8/9 струны — большая секунда выше", "8/9"],
    [5 / 6, "ре♯", "5/6 струны — малая терция выше", "5/6"],
    [4 / 5, "ми", "4/5 струны — большая терция выше", "4/5"],
    [3 / 4, "фа", "3/4 струны — кварта выше", "3/4"],
    [32 / 45, "фа♯", "32/45 струны — тритон выше", "32/45"],
    [2 / 3, "соль", "2/3 струны — квинта выше", "2/3"],
    [5 / 8, "соль♯", "5/8 струны — малая секста выше", "5/8"],
    [3 / 5, "ля", "3/5 струны — большая секста выше", "3/5"],
    [5 / 9, "ля♯", "5/9 струны — малая септима выше", "5/9"],
    [8 / 15, "си", "8/15 струны — большая септима выше", "8/15"],
    [1 / 2, "до", "половина струны — октава выше", "1/2"]];
  // The second octave: every share halved. Only its white notes get labels; the marks sit twice as close.
  const STRING_MARKS_2 = [
    [15 / 32, "до♯", "15/32 струны — до♯ на октаву выше, чем при 15/16 струны", "15/32", 2],
    [4 / 9, "ре", "4/9 струны — ре на октаву выше, чем при 8/9 струны", "4/9", 2],
    [5 / 12, "ре♯", "5/12 струны — ре♯ на октаву выше, чем при 5/6 струны", "5/12", 2],
    [2 / 5, "ми", "2/5 струны — ми на октаву выше, чем при 4/5 струны", "2/5", 2],
    [3 / 8, "фа", "3/8 струны — фа на октаву выше, чем при 3/4 струны", "3/8", 2],
    [16 / 45, "фа♯", "16/45 струны — фа♯ на октаву выше, чем при 32/45 струны", "16/45", 2],
    [1 / 3, "соль", "1/3 струны — соль на октаву выше, чем при 2/3 струны", "1/3", 2],
    [5 / 16, "соль♯", "5/16 струны — соль♯ на октаву выше, чем при 5/8 струны", "5/16", 2],
    [3 / 10, "ля", "3/10 струны — ля на октаву выше, чем при 3/5 струны", "3/10", 2],
    [5 / 18, "ля♯", "5/18 струны — ля♯ на октаву выше, чем при 5/9 струны", "5/18", 2],
    [4 / 15, "си", "4/15 струны — си на октаву выше, чем при 8/15 струны", "4/15", 2],
    [1 / 4, "до", "четверть струны — две октавы выше", "1/4", 2]];
  const STRING_ALL = [...STRING_MARKS, ...STRING_MARKS_2];
  // Semitones above the open string for every mark, to place it in equal temperament as well.
  const STRING_SEMIS = [...STRING_MARKS.map((_, i) => i), ...STRING_MARKS_2.map((_, j) => 13 + j)];
  const cents = (justShare, eqShare) => Math.round(1200 * Math.log2(justShare / eqShare));
  class StringLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: тяните синий кружок-палец вдоль струны или жмите кнопки с нотами. Щёлкните по струне — она зазвучит, или оттяните её вверх или вниз и отпустите: чем дальше, тем громче.");
      this.part = 1; // sounding share of the string
      this.tension = 1;
      this.pluckedAt = null;
      this.canvas = document.createElement("canvas");
      this.canvas.style.touchAction = "none"; // the finger-dot is dragged sideways, the string is pulled up or down
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<span class="player-mode"><button type="button" data-o="1" class="on">малая октава</button><button type="button" data-o="2">первая октава</button></span>' +
        STRING_MARKS.map(([, name], i) => `<button type="button" data-mark="${i}"${i === 12 ? ' title="до следующей октавы"' : ""}>${i === 12 ? "до ↑" : name}</button>`).join("") +
        '<label>Натяжение <input type="range" min="50" max="200" step="5" value="100"> <span class="lab-ten">100</span> %</label>' +
        '<button type="button" class="player-play" data-scale="1">▶ Гамма по очереди</button>' +
        '<span class="player-mode"><button type="button" data-t="just" class="on">Чистый строй</button><button type="button" data-t="equal">Как на фортепиано</button></span>' +
        '<span class="player-score lab-info"></span>';
      el.append(this.canvas, bar);
      this.info = bar.querySelector(".lab-info");
      // just intonation (simple ratios) or equal temperament (every semitone the same, 2^(1/12)), as on a piano
      this.tuning = "just";
      bar.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => {
        bar.querySelectorAll("[data-t]").forEach((x) => x.classList.toggle("on", x === b));
        const mark = this.marks().find(([share]) => Math.abs(share - this.part) < 0.003);
        const semis = mark ? mark[5] : null;
        this.tuning = b.dataset.t;
        if (semis !== null) this.part = this.marks().find((m) => m[5] === semis)[0]; // the finger follows its note
        this.update();
      }));
      // the scale до … до of the chosen octave, the finger stepping along the marks of the current tuning
      bar.querySelector("[data-scale]").addEventListener("click", () => {
        audio();
        clearTimeout(this.scaleTimer);
        const white = [0, 2, 4, 5, 7, 9, 11, 12];
        const step = (i) => {
          if (i >= white.length) return;
          this.part = this.marks()[white[i]][0] / this.octave;
          this.pluck();
          this.scaleTimer = setTimeout(() => step(i + 1), 450);
        };
        step(0);
      });
      this.octave = 1; // which octave the note buttons put the finger in
      bar.querySelectorAll("[data-o]").forEach((b) => b.addEventListener("click", () => {
        bar.querySelectorAll("[data-o]").forEach((x) => x.classList.toggle("on", x === b));
        this.octave = Number(b.dataset.o);
      }));
      bar.querySelectorAll("[data-mark]").forEach((b) => b.addEventListener("click", () => {
        this.part = this.marks()[Number(b.dataset.mark)][0] / this.octave;
        this.pluck();
      }));
      const ten = bar.querySelector("input");
      ten.addEventListener("input", () => { this.tension = ten.value / 100; bar.querySelector(".lab-ten").textContent = ten.value; this.update(); });
      // Drag the finger along the string (it snaps to the simple ratios; at the edge the whole string sounds);
      // a short click anywhere on the string plucks it.
      const presses = new Map(); // pointerId → press: one finger can hold the finger-dot while another plucks
      const posAt = (ev) => (ev.clientX - this.canvas.getBoundingClientRect().left - this.x0) / this.len;
      const setFinger = (pos) => {
        let part = Math.max(1 / 64, Math.min(1, 1 - pos));
        const snap = this.marks().find(([share]) => Math.abs(share - part) < (share < 0.5 ? 0.005 : 0.008));
        if (snap) part = snap[0];
        this.part = part;
        this.update();
      };
      this.canvas.addEventListener("pointerdown", (ev) => {
        const y = ev.clientY - this.canvas.getBoundingClientRect().top;
        if ((y > this.y0 + 30 && y < this.y0 + 100) || (y < this.y0 - 30 && y > this.y0 - 64)) {
          // a click on a note's label moves the finger there, without plucking
          const pos = posAt(ev);
          const near = this.marks().reduce((a, m) => (!a || Math.abs(1 - m[0] - pos) < Math.abs(1 - a[0] - pos) ? m : a), null);
          if (near && Math.abs(1 - near[0] - pos) * this.len < 16) { this.part = near[0]; this.update(); ev.preventDefault(); }
          return;
        }
        if (y > this.y0 + 30 || y < this.y0 - 36) return;
        const pos = posAt(ev);
        if (pos < -0.02 || pos > 1.02) return;
        const onFinger = Math.abs(pos - (1 - this.part)) * this.len < 18 && ![...presses.values()].some((q) => q.onFinger);
        presses.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, pos, onFinger, moved: false, pulling: false });
        this.canvas.setPointerCapture(ev.pointerId);
        ev.preventDefault();
      });
      this.canvas.addEventListener("pointermove", (ev) => {
        const press = presses.get(ev.pointerId);
        if (!press) return;
        if (press.onFinger) { // the finger-dot is dragged along the string
          if (!press.moved && Math.abs(ev.clientX - press.x) > 4) press.moved = true;
          if (press.moved) setFinger(posAt(ev));
          return;
        }
        // any other touch on the sounding part pulls the string up or down, like a real pluck
        const dy = ev.clientY - press.y;
        if (!press.pulling && Math.abs(dy) > 4) press.pulling = true;
        if (!press.pulling) return;
        const at = Math.max(1 - this.part + 0.02, Math.min(0.98, press.pos));
        this.pull = { at, dy: Math.max(-30, Math.min(30, dy)) };
        this.pluckedAt = null;
        this.draw(0);
      });
      const end = (ev) => {
        const press = presses.get(ev.pointerId);
        if (!press) return;
        presses.delete(ev.pointerId);
        if (press.onFinger) return;
        if (press.pulling && this.pull) {
          const strength = Math.abs(this.pull.dy) / 30;
          this.pull = null;
          if (strength > 0.05) this.pluck(strength); else this.draw(0);
        } else this.pluck(1);
      };
      ["pointerup", "pointercancel"].forEach((e) => this.canvas.addEventListener(e, end));
      this.canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }
    freq() { return (STRING_BASE * Math.sqrt(this.tension)) / this.part; }
    // Marks in the current tuning: [share, name, description, label, octave, semitones, just share].
    marks() {
      return STRING_ALL.map((m, i) => {
        const semis = STRING_SEMIS[i];
        if (this.tuning === "just") return [m[0], m[1], m[2], m[3], m[4], semis, m[0]];
        const eq = Math.pow(2, -semis / 12);
        const c = cents(m[0], eq);
        return [eq, m[1], `${eq.toFixed(3).replace(".", ",")} струны — как на фортепиано; в чистом строе ${m[3]}, ` +
          (c === 0 ? "совпадает" : `разница ${Math.abs(c)} ${plural(Math.abs(c), "цент", "цента", "центов")} (на фортепиано ${c > 0 ? "выше" : "ниже"})`),
          semis % 12 === 0 ? m[3] : eq.toFixed(3).replace(".", ","), m[4], semis, m[0]];
      });
    }
    resize() {
      const w = this.el.clientWidth, h = 222;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h; this.x0 = 30; this.len = w - 60; this.y0 = 92;
      this.update();
    }
    update() {
      const f = this.freq();
      const mark = this.marks().find(([share]) => Math.abs(share - this.part) < 0.003);
      const semis = 12 * Math.log2(1 / this.part);
      this.info.textContent = (mark ? `${mark[1]}: ${mark[2]}` : `${Math.round(this.part * 100)} % струны — на ${semis.toFixed(1).replace(".", ",")} полутона выше`) +
        `, ${Math.round(f)} Гц` +
        (this.tension !== 1 ? `; натяжение ×${this.tension.toFixed(2).replace(".", ",")} поднимает звук в √${this.tension.toFixed(2).replace(".", ",")} раза` : "");
      this.draw(0);
    }
    // strength 0…1: how far the string was pulled; a click is the strongest
    pluck(strength = 1) {
      audio();
      this.strength = strength;
      pluck(ctx.currentTime, this.freq(), 0.5 * strength);
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
      // the other tuning as faint ticks, to see how far each note moves
      this.marks().forEach(([share, , , , , , just]) => {
        const other = this.tuning === "just" ? null : just;
        if (other === null || Math.abs(other - share) < 1e-6) return;
        const xo = x0 + len * (1 - other);
        g.strokeStyle = "#e08a2b"; g.lineWidth = 1.5; g.globalAlpha = 0.6;
        g.beginPath(); g.moveTo(xo, y0 - 8); g.lineTo(xo, y0 + 8); g.stroke(); g.globalAlpha = 1;
      });
      this.marks().forEach(([share, name, , frac, oct]) => {
        const x = x0 + len * (1 - share);
        const sharp = name.includes("♯"); // sharps above the string, like black keys; the rest below
        const labelY = sharp ? y0 - 40 : y0 + 44;
        if (oct === 2) {
          // second octave: ticks for every note, small labels for the white ones only
          g.strokeStyle = "#d8d8cf"; g.lineWidth = 1; g.setLineDash([3, 3]);
          g.beginPath(); g.moveTo(x, y0 - (sharp ? 20 : 34)); g.lineTo(x, y0 + 30); g.stroke(); g.setLineDash([]);
          if (sharp) return;
          const row = ["ми", "соль", "си"].includes(name) ? 24 : 0; // white notes in two rows, they sit close
          g.strokeStyle = "#e4e4dc"; g.beginPath(); g.moveTo(x, y0 + 30); g.lineTo(x, labelY + row - 10); g.stroke();
          g.fillStyle = COLORS.text; g.font = "bold 10px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
          g.fillText(name, x, labelY + row);
          g.fillStyle = COLORS.muted; g.font = "9px Segoe UI, Arial, sans-serif";
          g.fillText(frac, x, labelY + row + 11);
          return;
        }
        g.strokeStyle = "#d8d8cf"; g.lineWidth = 1; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(x, y0 - 34); g.lineTo(x, y0 + 30); g.stroke(); g.setLineDash([]);
        g.fillStyle = sharp ? COLORS.muted : COLORS.text; g.font = `${sharp ? "" : "bold "}${sharp ? 10 : 12}px Segoe UI, Arial, sans-serif`; g.textAlign = "center";
        g.fillText(name, x + (share === 1 ? 10 : 0), labelY);
        // the share of the string that sounds, under the name (above it for sharps)
        g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif";
        g.fillText(frac, x + (share === 1 ? 10 : 0), sharp ? labelY - 12 : labelY + 13);
      });
      // the two octaves of marks, as brackets under the labels
      // Octaves of the string: the open string is до of the small octave (o = 4), each next octave is half as long.
      // Beyond the labelled second octave only ticks are drawn, while they stay at least 3 px apart, and a bracket is
      // labelled while its name fits (full, then mid, then short form).
      g.font = "11px Segoe UI, Arial, sans-serif";
      for (let k = 0; ; k++) {
        const a = 1 - Math.pow(2, -k), b = 1 - Math.pow(2, -k - 1);
        const xa = x0 + len * a + 2, xb = x0 + len * b - 2, width = xb - xa, y = y0 + 106, o = 4 + k;
        if (width < 10) break;
        if (k >= 2 && (len * Math.pow(2, -k - 1)) / 12 >= 3) {
          STRING_MARKS.slice(1).forEach(([share]) => {
            const x = x0 + len * (1 - share * Math.pow(2, -k));
            g.strokeStyle = "#cfcfc6"; g.lineWidth = 1;
            g.beginPath(); g.moveTo(x, y0 - 8); g.lineTo(x, y0 + 8); g.stroke();
          });
        }
        g.strokeStyle = "#b8b8ae"; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(xa, y - 5); g.lineTo(xa, y); g.lineTo(xb, y); g.lineTo(xb, y - 5); g.stroke();
        const long = k === 0 ? "малая октава: от всей струны до половины" : k === 1 ? "первая октава: от половины до четверти" : octaveName(o, "full");
        const label = [long, octaveName(o, "full"), octaveName(o, "mid"), octaveName(o, "short")].find((s) => g.measureText(s).width + 6 <= width);
        if (label) { g.fillStyle = COLORS.muted; g.textAlign = "center"; g.fillText(label, (xa + xb) / 2, y + 14); }
      }
      // pegs, the silent part and the vibrating part
      g.fillStyle = "#555"; g.fillRect(x0 - 8, y0 - 12, 8, 24); g.fillRect(x0 + len, y0 - 12, 8, 24);
      g.strokeStyle = "#c9c9c0"; g.lineWidth = 3;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(fx, y0); g.stroke();
      const amp = this.pluckedAt ? 16 * Math.exp(-age / 0.8) * (this.strength ?? 1) : 0;
      const seg = len * this.part;
      if (this.pull) { // held: the string bent to a triangle at the pulling point
        const px = x0 + len * this.pull.at, py = y0 + this.pull.dy;
        g.strokeStyle = COLORS.right; g.lineWidth = 3;
        g.beginPath(); g.moveTo(fx, y0); g.lineTo(px, py); g.lineTo(x0 + len, y0); g.stroke();
        g.fillStyle = COLORS.right; g.font = "bold 12px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
        g.fillText(`отпустите — сила ${Math.round((Math.abs(this.pull.dy) / 30) * 100)} %`, px, y0 - 58);
      }
      for (let k = this.pull ? 1 : amp > 0.5 ? -3 : 0; k <= (this.pull ? 0 : amp > 0.5 ? 3 : 0); k++) {
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
  // tapping excites the glass, which the water makes heavier (f falls as the water rises, here by about an octave).
  const BLOW_EMPTY = 180, TAP_EMPTY = 1150, TAP_WATER = 4.8;
  const blowFreq = (level) => BLOW_EMPTY / Math.sqrt(1 - level);
  const tapFreq = (level) => TAP_EMPTY / Math.sqrt(1 + TAP_WATER * level);
  const levelFor = (mode, f) => (mode === "blow" ? 1 - (BLOW_EMPTY / f) ** 2 : ((TAP_EMPTY / f) ** 2 - 1) / TAP_WATER);
  const BOTTLES_START = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]; // an even staircase of water, not a scale
  // The nearest note to a frequency, with "≈" when it is more than 10 cents off.
  function nearestNote(f) {
    const exact = 69 + 12 * Math.log2(f / 440), m = Math.round(exact);
    return (Math.abs(exact - m) * 100 > 10 ? "≈ " : "") + NAMES[((m % 12) + 12) % 12];
  }
  const sciName = (f) => { const m = Math.round(69 + 12 * Math.log2(f / 440)); return LETTERS[m % 12] + (Math.floor(m / 12) - 1); };

  // Water levels (2–92 %) at which a bottle sounds a white note, for blowing or for tapping.
  function bottleNoteLevels(mode) {
    const out = [];
    for (let m = 36; m <= 96; m++) {
      if (isBlack(m)) continue;
      const level = levelFor(mode, midiFreq(m));
      if (level >= 0.02 && level <= 0.92) out.push({ level, m });
    }
    return out;
  }

  // The organ: like the pipes of an organ, each bottle is tuned to one note, eight of them make the scale до…до.
  // Blowing: до of the first octave to до of the second; tapping sounds an octave higher: до of the second to the third.
  const BOTTLE_ORGAN = { blow: [60, 62, 64, 65, 67, 69, 71, 72], tap: [72, 74, 76, 77, 79, 81, 83, 84] };

  class BottleLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: щёлкните по бутылке — она зазвучит, в режиме «Дуть» — пока держите; можно несколькими пальцами. Уровень воды тяните сбоку от бутылки, за стрелку ↕ или риски нот.");
      this.levels = [...BOTTLES_START];
      this.mode = "tap";
      this.lit = new Map(); // bottle → time it lit up (Infinity while blown)
      this.canvas = document.createElement("canvas");
      this.canvas.style.touchAction = "none";
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<span class="player-mode"><button type="button" data-m="tap" class="on">Стучать ложкой</button><button type="button" data-m="blow">Дуть</button></span>' +
        '<button type="button" data-organ="1">Настроить как орган: до ре ми фа соль ля си до</button>' +
        '<button type="button" data-reset="1">Вернуть как было</button>' +
        '<button type="button" class="player-play" data-scale="1">▶ По очереди</button><span class="player-score lab-info"></span>';
      el.append(this.canvas, bar);
      this.info = bar.querySelector(".lab-info");
      bar.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => {
        bar.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("on", x === b));
        this.mode = b.dataset.m; this.draw();
      }));
      // The organ is tuned for the current mode; the mode itself is left alone.
      bar.querySelector("[data-organ]").addEventListener("click", () => {
        this.levels = BOTTLE_ORGAN[this.mode].map((m) => levelFor(this.mode, midiFreq(m)));
        this.info.textContent = "У органа каждая труба звучит одной нотой, а мелодию играют на наборе труб, настроенных по гамме. " +
          "Здесь трубы — бутылки: вода подобрана так, что они дают до, ре, ми, фа, соль, ля, си и до следующей октавы" +
          (this.mode === "blow" ? " (от до первой октавы). Уровни идут неровно: чем выше нота, тем меньше воды нужно доливать."
                                : " (при стуке на октаву выше — от до второй октавы). Чем выше нота, тем меньше воды.") +
          " Настройка — для текущего режима: в другом бутылки зазвучат иначе.";
        this.draw();
      });
      // every bottle in turn, left to right: knocked, or blown for a moment
      bar.querySelector("[data-scale]").addEventListener("click", () => {
        audio();
        clearTimeout(this.scaleTimer);
        const step = (i) => {
          if (i >= this.levels.length) return;
          if (this.mode === "tap") this.sound(i);
          else { const stop = this.blow(i); setTimeout(stop, 380); }
          this.scaleTimer = setTimeout(() => step(i + 1), 450);
        };
        step(0);
      });
      bar.querySelector("[data-reset]").addEventListener("click", () => {
        this.levels = [...BOTTLES_START];
        this.info.textContent = "Исходная настройка: вода налита ровной лесенкой. Звуки идут по порядку, но шаги между ними неравные " +
          "и в ноты не попадают — поэтому под бутылками «≈».";
        this.draw();
      });
      // every finger works its own bottle: a tap knocks, a hold blows, a vertical drag pours
      const drags = new Map();
      this.canvas.addEventListener("pointerdown", (ev) => {
        const box = this.canvas.getBoundingClientRect();
        const i = this.bottleAt(ev.clientX - box.left);
        if (i === undefined) {
          // beside the bottles: set the water of the nearest one to this height, silently, and keep dragging it
          const { top, bh } = this.geom(), y = ev.clientY - box.top;
          if (y < top || y > top + bh) return;
          const near = this.nearestBottle(ev.clientX - box.left);
          drags.set(ev.pointerId, { i: near, y: ev.clientY, outside: true });
          this.canvas.setPointerCapture(ev.pointerId);
          this.pour(near, ev.clientY);
          return;
        }
        const drag = { i, y: ev.clientY }; // inside a bottle: sound only, no pouring
        drags.set(ev.pointerId, drag);
        this.canvas.setPointerCapture(ev.pointerId);
        if (this.mode === "blow") { audio(); drag.stop = this.blow(i); }
      });
      this.canvas.addEventListener("pointermove", (ev) => {
        const drag = drags.get(ev.pointerId);
        if (drag && drag.outside) this.pour(drag.i, ev.clientY);
      });
      const end = (ev) => {
        const drag = drags.get(ev.pointerId);
        if (!drag) return;
        drags.delete(ev.pointerId);
        if (drag.stop) drag.stop();
        else if (!drag.outside && this.mode === "tap") this.sound(drag.i);
      };
      ["pointerup", "pointercancel"].forEach((e) => this.canvas.addEventListener(e, end));
      this.resize();
      window.addEventListener("resize", () => this.resize());
    }

    // Water level of bottle i from a pointer height, snapped to the nearest note mark.
    pour(i, clientY) {
      const box = this.canvas.getBoundingClientRect();
      const { top, bh } = this.geom();
      let level = Math.max(0.02, Math.min(0.92, 1 - (clientY - box.top - top) / bh));
      const marks = bottleNoteLevels(this.mode);
      const near = marks.reduce((a, b) => (Math.abs(b.level - level) < Math.abs(a.level - level) ? b : a));
      if (Math.abs(near.level - level) < 0.02) level = near.level; // snap to a note
      this.levels[i] = level;
      this.draw();
    }
    nearestBottle(x) {
      const { n, bw, gap } = this.geom();
      let best = 0;
      for (let i = 1; i < n; i++) if (Math.abs(gap + i * (bw + gap) + bw / 2 - x) < Math.abs(gap + best * (bw + gap) + bw / 2 - x)) best = i;
      return best;
    }

    geom() {
      const n = this.levels.length, bw = Math.min(56, (this.w - 40) / n - 16);
      return { n, bw, gap: (this.w - n * bw) / (n + 1), top: 46, bh: this.h - 130 };
    }
    bottleAt(x) {
      const { n, bw, gap } = this.geom();
      for (let i = 0; i < n; i++) { const bx = gap + i * (bw + gap); if (x >= bx && x <= bx + bw) return i; }
      return undefined;
    }
    resize() {
      const w = this.el.clientWidth, h = 270;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      this.draw();
    }
    blow(i) {
      const f = blowFreq(this.levels[i]);
      this.info.textContent = `дуем: ≈ ${Math.round(f)} Гц — чем больше воды, тем выше`;
      this.lit.set(i, Infinity);
      this.draw();
      const stop = holdBlow(f);
      return () => { stop(); this.lit.delete(i); this.draw(); };
    }

    sound(i) {
      audio();
      const t = ctx.currentTime, f = tapFreq(this.levels[i]);
      tone(t, f, 0, 0.9, 0.25); tone(t, f * 2.76, 0, 0.35, 0.06); hiss(t, 0.01, 0.15, "highpass", 5000);
      this.info.textContent = `стук: ≈ ${Math.round(f)} Гц — чем больше воды, тем ниже`;
      this.lit.set(i, performance.now());
      this.draw();
      setTimeout(() => this.draw(), 350);
    }
    draw() {
      const g = this.g, { bw, gap, top, bh } = this.geom();
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, this.w, this.h);
      const now = performance.now();
      this.levels.forEach((level, i) => {
        const x = gap + i * (bw + gap);
        const lit = this.lit.has(i) && (this.lit.get(i) === Infinity || now - this.lit.get(i) < 300);
        g.fillStyle = lit ? "#fff3cc" : "#fff";
        g.fillRect(x, top, bw, bh);
        g.fillStyle = "#cfe0f7"; g.fillRect(x, top + bh * (1 - level), bw, bh * level);
        g.fillStyle = COLORS.right; g.font = "bold 15px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
        g.fillText("↕", x - 9, top + bh * (1 - level) + 5);
        g.strokeStyle = COLORS.right; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x - 4, top + bh * (1 - level)); g.lineTo(x, top + bh * (1 - level)); g.stroke();
        // white-note levels as marks on the glass; до is labelled
        bottleNoteLevels(this.mode).forEach(({ level: L, m }) => {
          const y = top + bh * (1 - L), isDo = m % 12 === 0;
          g.strokeStyle = isDo ? COLORS.right : "#9aa1ad"; g.lineWidth = isDo ? 2 : 1;
          g.beginPath(); g.moveTo(x + bw - (isDo ? 10 : 6), y); g.lineTo(x + bw + (isDo ? 8 : 5), y); g.stroke();
          if (isDo) { g.fillStyle = COLORS.right; g.font = "bold 9px Segoe UI, Arial, sans-serif"; g.textAlign = "left"; g.fillText("до", x + bw + 9, y + 3); }
        });
        g.strokeStyle = COLORS.right; g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x + bw * 0.32, top - 26); g.lineTo(x + bw * 0.32, top); g.lineTo(x, top); g.lineTo(x, top + bh);
        g.lineTo(x + bw, top + bh); g.lineTo(x + bw, top); g.lineTo(x + bw * 0.68, top); g.lineTo(x + bw * 0.68, top - 26);
        g.stroke();
        const f = this.mode === "tap" ? tapFreq(level) : blowFreq(level);
        g.textAlign = "center";
        g.fillStyle = COLORS.text; g.font = "bold 12px Segoe UI, Arial, sans-serif";
        g.fillText(`${Math.round(f)} Гц`, x + bw / 2, top + bh + 18);
        g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif";
        g.fillText(`${Math.round(level * 100)} % воды`, x + bw / 2, top + bh + 33);
        g.fillStyle = COLORS.right; g.font = "bold 12px Segoe UI, Arial, sans-serif";
        g.fillText(nearestNote(f), x + bw / 2, top + bh + 50);
        // the octave, so the last до is visibly the next one
        g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif";
        g.fillText(octaveName(Math.floor(Math.round(69 + 12 * Math.log2(f / 440)) / 12), "mid"), x + bw / 2, top + bh + 64);
      });
    }
  }

  // ---------- pot and film (1.1.1): sound reaches a film stretched over a bowl and makes the grains jump ----------
  // A round membrane vibrates in rings: the axisymmetric modes J0(j₀ₙ·r/R) with j₀ₙ = 2.405, 5.520, 8.654, 11.79, so their
  // frequencies go 1 : 2.30 : 3.60 : 4.90 and all scale as 1/R. The film's fundamental for a 20 cm bowl is set near 95 Hz
  // (wave speed ≈ 25 m/s, a plausible guess for cling film, not a measurement). A grain leaves the film where its
  // acceleration exceeds g; then it flies under real gravity at the bowl's scale and lands with a tick. On nodal rings the
  // film stays still: grains do not jump there and slowly gather — Chladni's figures.
  const J0_ZEROS = [2.4048, 5.5201, 8.6537, 11.7915];
  const FILM_WAVE = 24.8; // m/s
  function besselJ0(x) {
    let sum = 0, term = 1;
    for (let k = 0; k < 40; k++) {
      if (k) term *= -(x * x) / (4 * k * k);
      sum += term;
      if (Math.abs(term) < 1e-12) break;
    }
    return sum;
  }
  const FILM_AMP = 0.0006; // m: the film's swing at full volume, on resonance — a fraction of a millimetre
  const SING_PITCHES = [["низко", 110], ["средне", 220], ["высоко", 440]];

  class PotLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: щёлкните по кастрюле или нажмите «Стукнуть»; «Спеть» звучит, пока держите, — низко, средне или высоко. Меняйте размер миски и смотрите, где крупа прыгает, а где собирается.");
      this.db = -6; this.volume = Math.pow(10, this.db / 20);
      this.diameter = 20; // cm
      this.meter = 0;
      this.waves = []; // sounds in flight from the pot: {at, strength}
      this.hits = []; // knocks that reached the film: {at, strength}
      this.sing = null; // {pitch, strength, from}
      this.grains = Array.from({ length: 36 }, (_, i) => ({ x: -0.92 + (1.84 * (i + 0.5)) / 36 + (Math.random() - 0.5) * 0.03, y: 0, vy: 0, vx: 0 }));
      this.ticks = 0; this.tickWindow = 0;
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<button type="button" class="player-play" data-a="hit">Стукнуть по кастрюле</button>' +
        "<b>Спеть:</b>" + SING_PITCHES.map(([n, f]) => `<button type="button" data-sing="${f}">${n}, ${f} Гц</button>`).join("") +
        '<label>Громкость <input type="range" data-v="db" min="-40" max="0" step="1" value="-6"> <span class="lab-db">−6</span> дБ</label>' +
        '<label>Миска <input type="range" data-v="d" min="12" max="30" step="1" value="20"> <span class="lab-d">20</span> см</label>' +
        '<span class="player-score lab-info"></span>';
      el.append(this.canvas, bar);
      this.info = bar.querySelector(".lab-info");
      bar.querySelector("[data-a=hit]").addEventListener("click", () => this.hit());
      bar.querySelectorAll("[data-sing]").forEach((b) => holdButton(b, () => this.startSing(Number(b.dataset.sing))));
      bar.querySelector("[data-v=db]").addEventListener("input", (e) => {
        this.db = Number(e.target.value); this.volume = Math.pow(10, this.db / 20);
        bar.querySelector(".lab-db").textContent = String(this.db).replace("-", "−");
      });
      bar.querySelector("[data-v=d]").addEventListener("input", (e) => {
        this.diameter = Number(e.target.value); bar.querySelector(".lab-d").textContent = this.diameter; this.describe();
      });
      this.canvas.addEventListener("pointerdown", (ev) => {
        const box = this.canvas.getBoundingClientRect();
        if (ev.clientX - box.left < this.w * 0.3) this.hit();
      });
      this.resize();
      window.addEventListener("resize", () => this.resize());
      if (window.IntersectionObserver) {
        new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; if (this.visible && !this.looping) this.loop(); }).observe(this.canvas);
      } else { this.visible = true; this.loop(); }
      this.describe();
    }

    modeFreqs() { const R = this.diameter / 200; return J0_ZEROS.map((j) => (j * FILM_WAVE) / (2 * Math.PI * R)); }
    // response of mode n to a sung pitch: a resonance with quality ~8
    response(f, fn) { const r = f / fn, q = 8; return 1 / Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2); }

    describe(extra) {
      const fs = this.modeFreqs().map((f) => Math.round(f)).join(", ");
      this.info.textContent = `Собственные частоты плёнки на миске ${this.diameter} см: ≈ ${fs} Гц.` + (extra ? " " + extra : "");
    }

    resize() {
      const w = this.el.clientWidth, h = 230;
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
      this.waves.push({ at: performance.now(), strength: v, kind: "hit" });
      this.meter = Math.max(this.meter, v);
    }

    startSing(pitch) {
      audio();
      const stop = holdSing(this.volume, pitch);
      const sing = { pitch, strength: this.volume, from: performance.now() + 700 };
      this.sing = sing;
      const fn = this.modeFreqs(), best = fn.reduce((a, f) => (Math.abs(f - pitch) < Math.abs(a - pitch) ? f : a));
      this.describe(`Поёте ${pitch} Гц; ближайшая собственная частота — ${Math.round(best)} Гц` +
        (Math.abs(best - pitch) / pitch < 0.12 ? " — резонанс: плёнка раскачивается сильно." : ". Попробуйте другой размер миски или высоту."));
      const timer = setInterval(() => { this.waves.push({ at: performance.now(), strength: this.volume * 0.6, kind: "sing" }); this.meter = Math.max(this.meter, this.volume * 0.6); }, 250);
      this.waves.push({ at: performance.now(), strength: this.volume * 0.6, kind: "sing" });
      return () => { clearInterval(timer); stop(); if (this.sing === sing) this.sing = null; };
    }

    // The film's swing (m) and its speed (m/s) at r ∈ [0, 1] of the radius, summed over active excitations.
    filmAt(r, now) {
      const fn = this.modeFreqs();
      let amp = 0, vel = 0, acc = 0;
      this.hits.forEach((hit) => {
        const age = (now - hit.at) / 1000;
        fn.forEach((f, n) => {
          const a = FILM_AMP * 0.6 * hit.strength * [1, 0.6, 0.4, 0.3][n] * Math.exp(-age / 0.25) * Math.abs(besselJ0(J0_ZEROS[n] * r));
          const w = 2 * Math.PI * f;
          amp += a; vel += a * w; acc += a * w * w;
        });
      });
      if (this.sing && now >= this.sing.from) {
        const w = 2 * Math.PI * this.sing.pitch;
        const shape = fn.reduce((s, f, n) => s + this.response(this.sing.pitch, f) / 8 * besselJ0(J0_ZEROS[n] * r), 0);
        const a = FILM_AMP * this.sing.strength * Math.abs(shape);
        amp += a; vel += a * w; acc += a * w * w;
      }
      return { amp, vel, acc };
    }

    loop() {
      this.looping = true;
      let last = performance.now();
      const step = () => {
        if (!this.visible) { this.looping = false; return; }
        const now = performance.now(), dt = Math.min(0.033, (now - last) / 1000);
        last = now;
        this.update(now, dt);
        this.draw(now);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    update(now, dt) {
      const travel = 700; // ms on screen from pot to bowl: slowed down, really ~1.5 ms for half a metre
      this.waves = this.waves.filter((wv) => {
        if (now - wv.at < travel) return true;
        if (wv.kind === "hit") this.hits.push({ at: now, strength: wv.strength });
        return false;
      });
      this.hits = this.hits.filter((h) => now - h.at < 2000);
      this.meter *= Math.pow(0.97, dt * 60);
      const bowlPx = this.bowlW || 300, pxPerM = bowlPx / (this.diameter / 100), gPx = 9.81 * pxPerM;
      if (now - this.tickWindow > 100) { this.tickWindow = now; this.ticks = 0; }
      this.grains.forEach((gr) => {
        if (gr.y <= 0 && gr.vy <= 0) {
          const f = this.filmAt(Math.abs(gr.x), now);
          if (f.acc > 9.81) { // the film pulls away faster than gravity: the grain is thrown
            gr.vy = f.vel * (0.6 + 0.4 * Math.random()) * pxPerM;
            // drift towards smaller swing: grains wander to the nodal rings
            const d = 0.02, side = this.filmAt(Math.min(1, Math.abs(gr.x) + d), now).amp - this.filmAt(Math.max(0, Math.abs(gr.x) - d), now).amp;
            gr.vx = (-Math.sign(side) * Math.sign(gr.x || 1) * 0.15 + (Math.random() - 0.5) * 0.25) * Math.min(1, f.vel / 0.3);
          } else { gr.vy = 0; gr.vx = 0; gr.y = 0; }
        }
        if (gr.vy !== 0 || gr.y > 0) {
          gr.vy -= gPx * dt;
          gr.y += gr.vy * dt;
          gr.x += gr.vx * dt;
          if (Math.abs(gr.x) > 0.94) { gr.x = Math.sign(gr.x) * 0.94; gr.vx = -gr.vx; }
          if (gr.y <= 0) { // landing: a tick, louder for a harder fall, a few dozen a second at most
            const speed = -gr.vy / pxPerM;
            gr.y = 0; gr.vy = 0;
            if (speed > 0.05 && this.ticks < 4 && ctx) { this.ticks++; hiss(ctx.currentTime, 0.006, Math.min(0.06, speed * 0.08) * (0.5 + this.volume), "highpass", 5000); }
          }
        }
      });
    }

    draw(now) {
      const g = this.g, w = this.w, h = this.h;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, w, h);
      // pot
      const px = w * 0.04, pw = w * 0.17, py = h * 0.42, ph = h * 0.34;
      g.fillStyle = "#f6f6f2"; g.strokeStyle = "#555"; g.lineWidth = 2;
      roundRect(g, px, py, pw, ph, 8); g.fill(); g.stroke();
      g.fillStyle = COLORS.text; g.font = "bold 12px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
      g.fillText("кастрюля", px + pw / 2, py + ph / 2 + 4);
      // level meter
      const mx = px, my = 12, mw = Math.min(w * 0.4, 240), mh = 10;
      const level = this.meter > 0.0001 ? Math.max(-40, 20 * Math.log10(this.meter)) : -40;
      g.fillStyle = "#e9e9e2"; roundRect(g, mx, my, mw, mh, 3); g.fill();
      g.fillStyle = level > -6 ? COLORS.bad : COLORS.right; roundRect(g, mx, my, Math.max(2, (mw * (level + 40)) / 40), mh, 3); g.fill();
      g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif";
      [-40, -20, 0].forEach((d) => g.fillText(String(d).replace("-", "−"), mx + (mw * (d + 40)) / 40, my + mh + 11));
      g.textAlign = "left"; g.fillStyle = COLORS.text; g.font = "bold 11px Segoe UI, Arial, sans-serif";
      g.fillText(`уровень: ${level <= -40 ? "тишина" : Math.round(level).toString().replace("-", "−") + " дБ"}`, mx + mw + 10, my + 9);
      // bowl sized by its diameter
      const maxW = w * 0.5, bw = (maxW * this.diameter) / 30, cx = w * 0.7, bx0 = cx - bw / 2, bx1 = cx + bw / 2, film = h * 0.56;
      this.bowlW = bw;
      const travel = 700;
      this.waves.forEach((wv) => {
        const k = (now - wv.at) / travel;
        if (k < 0 || k > 1) return;
        const x = px + pw + k * (bx0 - px - pw);
        g.strokeStyle = COLORS.right; g.globalAlpha = 0.3 + 0.7 * wv.strength; g.lineWidth = 2.5;
        g.beginPath(); g.arc(x - 30, h * 0.55, 34, -0.7, 0.7); g.stroke(); g.globalAlpha = 1;
      });
      g.fillStyle = "#f6f6f2"; g.strokeStyle = "#555"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(bx0, film); g.quadraticCurveTo(bx0, h * 0.9, cx, h * 0.9); g.quadraticCurveTo(bx1, h * 0.9, bx1, film); g.closePath(); g.fill(); g.stroke();
      // the film: its swing magnified and slowed down so the rings are visible
      const shown = (x) => {
        const r = Math.abs(x), fn = this.modeFreqs(), tt = now / 1000;
        let u = 0;
        this.hits.forEach((hit) => fn.forEach((f, n) => {
          u += hit.strength * [1, 0.6, 0.4, 0.3][n] * Math.exp(-(now - hit.at) / 250) * besselJ0(J0_ZEROS[n] * r) * Math.sin(2 * Math.PI * (0.8 + n * 0.5) * tt);
        }));
        if (this.sing && now >= this.sing.from) u += this.sing.strength * fn.reduce((s, f, n) => s + this.response(this.sing.pitch, f) / 8 * besselJ0(J0_ZEROS[n] * r), 0) * Math.sin(2 * Math.PI * 1.2 * tt);
        return u * 12;
      };
      g.strokeStyle = COLORS.right; g.lineWidth = 3; g.beginPath();
      for (let i = 0; i <= 120; i++) { const x = -1 + (2 * i) / 120; g.lineTo(cx + (x * bw) / 2, film + shown(x)); }
      g.stroke();
      g.fillStyle = "#8a5a2b";
      this.grains.forEach((gr) => { g.beginPath(); g.arc(cx + (gr.x * bw) / 2, film - 3 + shown(gr.x) * (gr.y > 0 ? 0 : 1) - gr.y, 2.6, 0, Math.PI * 2); g.fill(); });
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
      g.fillText(`миска ${this.diameter} см с плёнкой и крупой`, cx, h - 6);
      g.textAlign = "left"; g.font = "10px Segoe UI, Arial, sans-serif";
      g.fillText("плёнка показана увеличенной и замедленной (на деле — доли миллиметра, сотни раз в секунду),", 8, 44);
      g.fillText("волна до миски — тоже замедленно; крупа прыгает в настоящем времени", 8, 57);
    }
  }

  // ---------- synthesizer (4.2): oscillator → filter → amplifier, driven by an envelope and an LFO ----------
  // data-stages picks the blocks shown: "osc", "filter", "env", "lfo", or several, comma-separated.
  // Every block is played with the sound, so what changes on the graph is heard at once.
  const WAVES = [["sine", "Синус"], ["triangle", "Треугольник"], ["sawtooth", "Пила"], ["square", "Меандр"]];
  const WAVE_TEXT = {
    sine: "синус — одна чистая частота без обертонов: звук мягкий и глуховатый, как свист",
    triangle: "треугольник — слабые нечётные обертоны: мягко, чуть ярче синуса, похоже на флейту",
    sawtooth: "пила — все обертоны подряд: ярко и жужжаще, из неё фильтром лепят почти любой звук",
    square: "меандр — только нечётные обертоны: «пустой», гнусавый звук, как у кларнета или старых приставок",
  };
  // Relative strength of harmonic n (1 = the fundamental) for each wave.
  const harmonic = (type, n) => type === "sine" ? (n === 1 ? 1 : 0) : type === "sawtooth" ? 1 / n :
    type === "square" ? (n % 2 ? 1 / n : 0) : (n % 2 ? 1 / (n * n) : 0);
  const waveAt = (type, x) => { // one period over x ∈ [0, 1)
    const f = x - Math.floor(x);
    return type === "sine" ? Math.sin(2 * Math.PI * f) : type === "square" ? (f < 0.5 ? 1 : -1) :
      type === "sawtooth" ? 1 - 2 * f : 1 - 4 * Math.abs(f - 0.5);
  };
  // Low-pass response of a resonant filter (a 2-pole approximation), resonance given in dB like Web Audio's Q.
  const lowpass = (f, fc, qDb) => { const q = Math.pow(10, qDb / 20), r = f / fc; return 1 / Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2); };
  const SYNTH_DEFAULTS = {
    osc: { type: "sawtooth", cutoff: 12000, q: 0, a: 0.01, d: 0.1, s: 0.9, r: 0.15, lfoRate: 5, lfoDepth: 0, lfoTarget: "pitch" },
    filter: { type: "sawtooth", cutoff: 700, q: 6, a: 0.01, d: 0.1, s: 0.9, r: 0.2, lfoRate: 5, lfoDepth: 0, lfoTarget: "pitch" },
    env: { type: "sawtooth", cutoff: 3000, q: 1, a: 0.4, d: 0.5, s: 0.5, r: 0.9, lfoRate: 5, lfoDepth: 0, lfoTarget: "pitch" },
    lfo: { type: "sawtooth", cutoff: 1500, q: 4, a: 0.02, d: 0.2, s: 0.9, r: 0.3, lfoRate: 5, lfoDepth: 0.5, lfoTarget: "pitch" },
  };
  // lfoDepth is 0…1 of the target's range: ±1 semitone of pitch, or ±3 octaves of filter cutoff.
  const SYNTH_PRESETS = [
    ["Мягкий бас", { type: "triangle", cutoff: 500, q: 2, a: 0.01, d: 0.25, s: 0.7, r: 0.2, lfoRate: 5, lfoDepth: 0, lfoTarget: "pitch" }],
    ["Яркий лид", { type: "sawtooth", cutoff: 4500, q: 8, a: 0.01, d: 0.2, s: 0.8, r: 0.3, lfoRate: 5.5, lfoDepth: 0.15, lfoTarget: "pitch" }],
    ["Пэд", { type: "sawtooth", cutoff: 1200, q: 2, a: 0.9, d: 0.6, s: 0.8, r: 1.6, lfoRate: 0.3, lfoDepth: 0.25, lfoTarget: "filter" }],
    ["Колокольчик", { type: "sine", cutoff: 12000, q: 0, a: 0.005, d: 1.4, s: 0, r: 1.2, lfoRate: 5, lfoDepth: 0, lfoTarget: "pitch" }],
    ["Вау", { type: "sawtooth", cutoff: 900, q: 14, a: 0.02, d: 0.2, s: 0.9, r: 0.3, lfoRate: 2.5, lfoDepth: 0.6, lfoTarget: "filter" }],
  ];

  class SynthLab {
    constructor(el) {
      this.el = el;
      this.stages = (el.dataset.stages || "osc").split(",").map((s) => s.trim());
      const all = this.stages.length > 1;
      this.p = { ...SYNTH_DEFAULTS[this.stages[0]] };
      howto(el, all
        ? "Как играть: нажимайте клавиши — звук держится, пока клавиша нажата, можно несколькими пальцами или клавишами компьютера. Тяните точки на графиках, выбирайте волну и готовые пресеты."
        : {
            osc: "Как играть: выберите форму волны и нажимайте клавиши. Слева — форма волны, справа — её обертоны.",
            filter: "Как играть: нажимайте клавиши и тяните синюю точку: влево-вправо — частота среза, вверх-вниз — резонанс.",
            env: "Как играть: тяните точки огибающей — атаку, спад с удержанием и затухание — и держите клавиши разное время.",
            lfo: "Как играть: держите клавишу и тяните точку: влево-вправо — скорость покачивания, вверх-вниз — глубина. Цель — высота или фильтр.",
          }[this.stages[0]]);
      this.lo = 48; this.hi = 72; // до малой октавы … до второй
      this.voices = new Map(); // midi → voice
      this.lastOn = null; this.lastOff = null; // for the moving dot on the envelope
      this.canvas = document.createElement("canvas");
      this.canvas.style.touchAction = "none";
      this.g = this.canvas.getContext("2d");
      const bar = document.createElement("div");
      bar.className = "player-controls";
      const want = (s) => this.stages.includes(s);
      bar.innerHTML = (want("osc") ? '<span class="player-mode">' + WAVES.map(([k, n]) =>
          `<button type="button" data-wave="${k}"${k === this.p.type ? ' class="on"' : ""}>${n}</button>`).join("") + "</span>" : "") +
        (want("lfo") ? '<span class="player-mode"><button type="button" data-lfo="pitch" class="on">LFO → высота</button>' +
          '<button type="button" data-lfo="filter">LFO → фильтр</button></span>' : "") +
        '<span class="player-score lab-info"></span>';
      const extra = document.createElement("div");
      if (all) {
        extra.className = "player-controls";
        extra.innerHTML = "<b>Пресеты:</b>" + SYNTH_PRESETS.map(([n], i) => `<button type="button" data-preset="${i}">${n}</button>`).join("");
      }
      el.append(this.canvas, bar, extra);
      this.info = bar.querySelector(".lab-info");
      bar.querySelectorAll("[data-wave]").forEach((b) => b.addEventListener("click", () => this.set({ type: b.dataset.wave })));
      bar.querySelectorAll("[data-lfo]").forEach((b) => b.addEventListener("click", () => this.set({ lfoTarget: b.dataset.lfo })));
      extra.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
        this.set({ ...SYNTH_PRESETS[Number(b.dataset.preset)][1] });
        this.info.textContent = `Пресет «${SYNTH_PRESETS[Number(b.dataset.preset)][0]}»: все настройки блоков разом. Нажимайте клавиши.`;
      }));
      // one pointer per finger: on a key it plays, on a handle it drags
      const presses = new Map();
      this.canvas.addEventListener("pointerdown", (ev) => {
        const box = this.canvas.getBoundingClientRect();
        const x = ev.clientX - box.left, y = ev.clientY - box.top;
        audio();
        activeSynth = this;
        activePlayer = null;
        const handle = (this.handles || []).find((h) => Math.hypot(h.x - x, h.y - y) < 18);
        const m = handle ? undefined : ChordLab.prototype.keyAt.call(this, x, y);
        if (!handle && m === undefined) return;
        ev.preventDefault();
        this.canvas.setPointerCapture(ev.pointerId);
        presses.set(ev.pointerId, handle ? { handle } : { m, stop: this.noteOn(m) });
      });
      this.canvas.addEventListener("pointermove", (ev) => {
        const press = presses.get(ev.pointerId);
        if (!press || !press.handle) return;
        const box = this.canvas.getBoundingClientRect();
        press.handle.drag(ev.clientX - box.left, ev.clientY - box.top);
      });
      const end = (ev) => {
        const press = presses.get(ev.pointerId);
        if (!press) return;
        presses.delete(ev.pointerId);
        if (press.stop) press.stop();
      };
      ["pointerup", "pointercancel", "lostpointercapture"].forEach((e) => this.canvas.addEventListener(e, end));
      this.resize();
      window.addEventListener("resize", () => this.resize());
      if (window.IntersectionObserver) {
        new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; if (this.visible) this.loop(); }).observe(this.canvas);
      }
      this.describe();
    }

    set(change) {
      Object.assign(this.p, change);
      this.el.querySelectorAll("[data-wave]").forEach((b) => b.classList.toggle("on", b.dataset.wave === this.p.type));
      this.el.querySelectorAll("[data-lfo]").forEach((b) => b.classList.toggle("on", b.dataset.lfo === this.p.lfoTarget));
      const now = ctx ? ctx.currentTime : 0;
      this.voices.forEach((v) => { // live voices follow the knobs
        v.osc.type = this.p.type;
        v.filter.frequency.setTargetAtTime(this.p.cutoff, now, 0.02);
        v.filter.Q.setTargetAtTime(this.p.q, now, 0.02);
        v.lfo.frequency.setTargetAtTime(this.p.lfoRate, now, 0.02);
        this.routeLfo(v);
      });
      this.describe();
      this.draw();
    }

    routeLfo(v) {
      v.lfoGain.disconnect();
      if (this.p.lfoTarget === "pitch") { v.lfoGain.gain.value = this.p.lfoDepth * 100; v.lfoGain.connect(v.osc.detune); }
      else { v.lfoGain.gain.value = this.p.lfoDepth * 3600; v.lfoGain.connect(v.filter.detune); }
    }

    describe() {
      const s = this.stages[0], p = this.p;
      if (this.stages.length > 1) {
        this.info.textContent = "Весь путь звука: осциллятор → фильтр → усилитель, которым управляют огибающая и LFO. Выберите пресет или меняйте блоки сами.";
        return;
      }
      this.info.textContent = s === "osc" ? WAVE_TEXT[p.type].replace(/^./, (c) => c.toUpperCase()) :
        s === "filter" ? `Частота среза ${hz(p.cutoff)} Гц: обертоны выше неё гаснут. Резонанс ${Math.round(p.q)} дБ: ` +
          (p.q > 8 ? "у среза острый пик — звук «квакает»" : "почти без пика — фильтр просто приглушает") :
        s === "env" ? `Атака ${p.a.toFixed(2).replace(".", ",")} с, спад ${p.d.toFixed(2).replace(".", ",")} с, удержание ${Math.round(p.s * 100)} %, затухание ${p.r.toFixed(2).replace(".", ",")} с` :
        `LFO: ${p.lfoRate.toFixed(1).replace(".", ",")} покачиваний в секунду, глубина ${Math.round(p.lfoDepth * 100)} % — ` +
          (p.lfoTarget === "pitch" ? "качается высота: вибрато, как у певца" : "качается фильтр: «вау-вау»");
    }

    noteOn(m) {
      const t = ctx.currentTime, p = this.p;
      if (!this.out) {
        this.out = ctx.createDynamicsCompressor();
        this.out.connect(ctx.destination);
      }
      const osc = ctx.createOscillator(), filter = ctx.createBiquadFilter(), amp = ctx.createGain();
      const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
      osc.type = p.type; osc.frequency.value = midiFreq(m);
      filter.type = "lowpass"; filter.frequency.value = p.cutoff; filter.Q.value = p.q;
      lfo.frequency.value = p.lfoRate; lfo.connect(lfoGain);
      osc.connect(filter); filter.connect(amp); amp.connect(this.out);
      const peak = 0.25;
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(peak, t + p.a);
      amp.gain.linearRampToValueAtTime(peak * p.s, t + p.a + p.d);
      const v = { osc, filter, amp, lfo, lfoGain };
      this.routeLfo(v);
      osc.start(t); lfo.start(t);
      if (this.voices.has(m)) this.voices.get(m).release();
      this.voices.set(m, v);
      this.lastOn = performance.now(); this.lastOff = null;
      v.release = () => {
        const s = ctx.currentTime;
        amp.gain.cancelScheduledValues(s);
        amp.gain.setValueAtTime(amp.gain.value, s);
        amp.gain.linearRampToValueAtTime(0, s + this.p.r);
        osc.stop(s + this.p.r + 0.05); lfo.stop(s + this.p.r + 0.05);
      };
      this.loop();
      return () => {
        if (this.voices.get(m) !== v) return;
        this.voices.delete(m);
        v.release();
        if (!this.voices.size) this.lastOff = performance.now();
      };
    }

    resize() {
      const w = this.el.clientWidth, all = this.stages.length > 1;
      const panelsH = all ? (w > 640 ? 360 : 720) : 190;
      const h = panelsH + 130;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h; this.panelsH = panelsH;
      ChordLab.prototype.layout.call(this);
      this.top = panelsH + 8; this.keysH = h - panelsH - 40;
      this.draw();
    }

    loop() {
      if (this.looping) return;
      this.looping = true;
      const tick = () => {
        this.draw();
        const busy = this.voices.size || (this.lastOff && performance.now() - this.lastOff < this.p.r * 1000 + 300);
        if (busy && this.visible !== false) requestAnimationFrame(tick); else { this.looping = false; this.draw(); }
      };
      requestAnimationFrame(tick);
    }

    draw() {
      const g = this.g, w = this.w;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, w, this.h);
      this.handles = [];
      const boxes = this.stages.length === 1 ? [[this.stages[0], 8, 8, w - 16, this.panelsH - 12]] :
        w > 640 ? this.stages.map((s, i) => [s, 8 + (i % 2) * (w / 2), 8 + Math.floor(i / 2) * 180, w / 2 - 16, 168]) :
          this.stages.map((s, i) => [s, 8, 8 + i * 180, w - 16, 168]);
      boxes.forEach(([s, x, y, bw, bh]) => {
        g.fillStyle = "#fff"; g.strokeStyle = "#e2e2e2"; g.lineWidth = 1;
        roundRect(g, x, y, bw, bh, 6); g.fill(); g.stroke();
        g.fillStyle = COLORS.text; g.font = "bold 12px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
        g.fillText({ osc: "1. Осциллятор: форма волны", filter: "2. Фильтр: что отрезать", env: "3. Огибающая: громкость во времени",
                     lfo: "4. LFO: медленное покачивание" }[s], x + 10, y + 18);
        this["draw_" + s](x + 10, y + 28, bw - 20, bh - 36);
      });
      this.drawKeys();
    }

    draw_osc(x, y, w, h) {
      const g = this.g, type = this.p.type, half = w * 0.55;
      g.strokeStyle = "#e4e4dc"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y + h / 2); g.lineTo(x + half - 10, y + h / 2); g.stroke();
      g.strokeStyle = COLORS.right; g.lineWidth = 2.5; g.beginPath();
      for (let i = 0; i <= 200; i++) g.lineTo(x + (i / 200) * (half - 10), y + h / 2 - (h / 2 - 8) * waveAt(type, (i / 200) * 2));
      g.stroke();
      g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
      g.fillText("два периода волны", x, y + h);
      this.harmonics(x + half + 6, y, w - half - 6, h, () => 1);
    }

    // Bars of the first 16 harmonics of the wave; `through(f)` scales each one (the filter, if any).
    harmonics(x, y, w, h, through) {
      const g = this.g, type = this.p.type, n = 16, bw = w / n, base = 110;
      for (let k = 1; k <= n; k++) {
        const a = harmonic(type, k), out = Math.min(1.6, a * through(base * k));
        if (a > 0) { g.fillStyle = "#e3eaf7"; g.fillRect(x + (k - 1) * bw + 1, y + h - 14 - a * (h - 24), bw - 2, a * (h - 24)); }
        g.fillStyle = COLORS.right; g.fillRect(x + (k - 1) * bw + 1, y + h - 14 - Math.min(1, out) * (h - 24), bw - 2, Math.min(1, out) * (h - 24));
      }
      g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
      g.fillText("обертоны: 1, 2, 3 … 16-й", x, y + h);
    }

    draw_filter(x, y, w, h) {
      const g = this.g, p = this.p, fMin = 60, fMax = 12000, dbMin = -40, dbMax = 20;
      const fx = (f) => x + (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
      const bottom = y + h - 14;
      const fy = (db) => bottom - ((Math.max(dbMin, Math.min(dbMax, db)) - dbMin) / (dbMax - dbMin)) * (h - 20);
      const dB = (v) => 20 * Math.log10(Math.max(1e-6, v));
      g.strokeStyle = "#e4e4dc"; g.lineWidth = 1; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(x, fy(0)); g.lineTo(x + w, fy(0)); g.stroke(); g.setLineDash([]);
      g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif"; g.textAlign = "right";
      g.fillText("0 дБ", x + w, fy(0) - 3);
      // harmonics of a 110 Hz wave on the frequency axis: light before the filter, blue after it
      for (let k = 1; 110 * k < fMax; k++) {
        const f = 110 * k, a = harmonic(p.type, k);
        if (!a) continue;
        const before = dB(a), after = before + dB(lowpass(f, p.cutoff, p.q));
        g.fillStyle = "#e3eaf7"; g.fillRect(fx(f) - 3, fy(before), 6, bottom - fy(before));
        g.fillStyle = COLORS.right; g.fillRect(fx(f) - 3, fy(after), 6, bottom - fy(after));
      }
      g.strokeStyle = COLORS.bad; g.lineWidth = 2; g.beginPath();
      for (let i = 0; i <= 240; i++) { const f = fMin * Math.pow(fMax / fMin, i / 240); g.lineTo(fx(f), fy(dB(lowpass(f, p.cutoff, p.q)))); }
      g.stroke();
      g.fillStyle = COLORS.muted; g.textAlign = "left";
      g.fillText("частота →   светлое — обертоны до фильтра, синее — после, красное — фильтр (в децибелах)", x, y + h);
      this.handle(fx(p.cutoff), fy(dB(lowpass(p.cutoff, p.cutoff, p.q))), (mx, my) => {
        const f = fMin * Math.pow(fMax / fMin, Math.max(0, Math.min(1, (mx - x) / w)));
        const db = dbMin + ((bottom - my) / (h - 20)) * (dbMax - dbMin);
        this.set({ cutoff: f, q: Math.max(0, Math.min(20, db)) });
      });
    }

    draw_env(x, y, w, h) {
      const g = this.g, p = this.p, span = 4.2; // seconds across the panel
      const sx = (s) => x + (s / span) * w, sy = (v) => y + h - 14 - v * (h - 24);
      const hold = 0.8, rStart = p.a + p.d + hold;
      g.strokeStyle = COLORS.right; g.lineWidth = 2.5; g.beginPath();
      g.moveTo(sx(0), sy(0)); g.lineTo(sx(p.a), sy(1)); g.lineTo(sx(p.a + p.d), sy(p.s)); g.lineTo(sx(rStart), sy(p.s)); g.lineTo(sx(rStart + p.r), sy(0));
      g.stroke();
      g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
      [["атака", p.a / 2, 1], ["спад", p.a + p.d / 2, (1 + p.s) / 2], ["удержание", p.a + p.d + hold / 2, p.s], ["затухание", rStart + p.r / 2, p.s / 2]]
        .forEach(([n, s, v], i) => {
          if (i < 2 && sx(p.a + p.d) - sx(0) < 70) { if (i === 0) g.fillText("атака и спад", sx(0) + 34, sy(1) + 4); return; }
          g.fillText(n, sx(s), sy(v) - 6);
        });
      g.textAlign = "left"; g.fillText("время →   клавиша нажата … отпущена", x, y + h);
      // the moving dot: where the last note is on the envelope now
      if (this.lastOn && (this.voices.size || this.lastOff)) {
        const now = performance.now();
        let s, v;
        if (this.voices.size) {
          const e = (now - this.lastOn) / 1000;
          s = Math.min(e, p.a + p.d + hold);
          v = e < p.a ? e / p.a : e < p.a + p.d ? 1 - (1 - p.s) * (e - p.a) / p.d : p.s;
        } else {
          const e = (now - this.lastOff) / 1000;
          s = rStart + Math.min(e, p.r); v = p.s * Math.max(0, 1 - e / p.r);
        }
        g.fillStyle = COLORS.flash; g.strokeStyle = "#b8860b"; g.lineWidth = 1.5;
        g.beginPath(); g.arc(sx(s), sy(v), 7, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      this.handle(sx(p.a), sy(1), (mx) => this.set({ a: Math.max(0.005, Math.min(2, ((mx - x) / w) * span)) }));
      this.handle(sx(p.a + p.d), sy(p.s), (mx, my) => this.set({
        d: Math.max(0.02, Math.min(2, ((mx - x) / w) * span - p.a)), s: Math.max(0, Math.min(1, (y + h - 14 - my) / (h - 24))) }));
      this.handle(sx(rStart + p.r), sy(0), (mx) => this.set({ r: Math.max(0.02, Math.min(2.5, ((mx - x) / w) * span - rStart)) }));
    }

    draw_lfo(x, y, w, h) {
      const g = this.g, p = this.p, span = 2; // seconds across the panel
      const mid = y + (h - 14) / 2, amp = (h - 30) / 2;
      g.strokeStyle = "#e4e4dc"; g.lineWidth = 1; g.beginPath(); g.moveTo(x, mid); g.lineTo(x + w, mid); g.stroke();
      const phase = this.voices.size ? (performance.now() / 1000) * p.lfoRate * 2 * Math.PI : 0;
      g.strokeStyle = COLORS.right; g.lineWidth = 2.5; g.beginPath();
      for (let i = 0; i <= 300; i++) {
        const s = (i / 300) * span;
        g.lineTo(x + (i / 300) * w, mid - amp * p.lfoDepth * Math.sin(2 * Math.PI * p.lfoRate * s - phase));
      }
      g.stroke();
      g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
      g.fillText(`2 секунды →   вверх-вниз: ${p.lfoTarget === "pitch" ? "высота ±1 полутон" : "частота среза фильтра ±3 октавы"} при глубине 100 %`, x, y + h);
      const qx = x + (0.25 / p.lfoRate / span) * w; // the first crest
      this.handle(qx, mid - amp * p.lfoDepth, (mx, my) => this.set({
        lfoRate: Math.max(0.2, Math.min(12, 0.25 / Math.max(0.01, ((mx - x) / w) * span))),
        lfoDepth: Math.max(0, Math.min(1, (mid - my) / amp)) }));
    }

    handle(x, y, drag) {
      const g = this.g;
      g.fillStyle = "#7eaee6"; g.strokeStyle = COLORS.right; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 8, 0, Math.PI * 2); g.fill(); g.stroke();
      this.handles.push({ x, y, drag });
    }

    drawKeys() {
      const g = this.g, { top, keysH, kw } = this;
      g.textAlign = "center";
      for (let m = this.lo; m <= this.hi; m++) {
        if (isBlack(m)) continue;
        const k = this.keys[m];
        g.fillStyle = this.voices.has(m) ? COLORS.flash : m % 12 === 0 ? "#e3eaf7" : "#fff";
        roundRect(g, k.x + 1, top, k.w - 2, keysH, 6); g.fill();
        g.strokeStyle = "#cfcfc6"; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = "#222"; g.font = `${m % 12 === 0 ? "bold " : ""}${Math.min(13, kw * 0.33)}px Segoe UI, Arial, sans-serif`;
        g.fillText(NAMES[m % 12], k.x + k.w / 2, top + keysH - 8);
      }
      for (let m = this.lo; m <= this.hi; m++) {
        if (!isBlack(m)) continue;
        const k = this.keys[m];
        g.fillStyle = this.voices.has(m) ? COLORS.flash : "#c5c5bc";
        roundRect(g, k.x, top - 1, k.w, keysH * 0.62 + 1, 4); g.fill();
      }
      octaveBrackets(g, this.keys, this.lo, this.hi, top + keysH + 8);
    }
  }
  // Computer keys play the synth last touched: the A row from до of its lowest octave, as on the players.
  let activeSynth = null;
  const synthHeld = {};
  document.addEventListener("keydown", (ev) => {
    const s = activeSynth;
    if (!s || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || synthHeld[ev.code]) return;
    const i = PIANO_KEYS.indexOf(ev.code);
    if (i < 0) return;
    ev.preventDefault();
    audio();
    synthHeld[ev.code] = s.noteOn(60 + i);
  });
  document.addEventListener("keyup", (ev) => { if (synthHeld[ev.code]) { synthHeld[ev.code](); delete synthHeld[ev.code]; } });


  // ---------- lesson 2: tell instruments apart by ear (recordings from Wikimedia Commons) ----------
  const COMMONS = "https://upload.wikimedia.org/wikipedia/commons/transcoded/";
  // [instrument, family, MP3 transcode path, start second]; authors and licences are listed in the lesson's table
  const CLIPS = [
    ["гитара", "струнные", "e/e0/El_Noi_de_la_Mare_%28guitar%29.ogg/El_Noi_de_la_Mare_%28guitar%29.ogg.mp3", 0],
    ["арфа", "струнные", "8/88/Glissando_Imprecision_for_2_Harps.ogg/Glissando_Imprecision_for_2_Harps.ogg.mp3", 0],
    ["скрипка", "струнные", "8/80/Violin_fingered.ogg/Violin_fingered.ogg.mp3", 0],
    ["флейта", "духовые", "e/ec/Bach_-_Partita_For_Solo_Flute_-_Modern_Flute_-_4._Bouree.ogg/Bach_-_Partita_For_Solo_Flute_-_Modern_Flute_-_4._Bouree.ogg.mp3", 0],
    ["труба", "духовые", "3/38/Natural_trumpet_B-flat.ogg/Natural_trumpet_B-flat.ogg.mp3", 0],
    ["фортепиано", "клавишные", "4/48/Piano-phrase.wav/Piano-phrase.wav.mp3", 0],
    ["орган", "клавишные", "2/2c/Ye_Choirs_of_New_Jerusalem_Organ.oga/Ye_Choirs_of_New_Jerusalem_Organ.oga.mp3", 0],
    ["аккордеон", "клавишные", "9/91/Accordion_registers.ogg/Accordion_registers.ogg.mp3", 0],
    ["малый барабан", "ударные", "b/b2/Snare_drum_unmuffled.ogg/Snare_drum_unmuffled.ogg.mp3", 0],
    ["ксилофон", "ударные", "b/bd/Xylophone_jingle.wav/Xylophone_jingle.wav.mp3", 0],
  ];
  const FAMILIES = ["струнные", "духовые", "ударные", "клавишные"];
  const CLIP_SECONDS = 10;

  class ListenLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: «Угадайка» — нажмите «Следующая запись», послушайте и выберите семейство, затем инструмент. «Послушать все» — у каждого инструмента своя кнопка. Записи с Викисклада, нужен интернет.");
      this.audio = new Audio();
      this.audio.preload = "none";
      this.audio.addEventListener("timeupdate", () => { if (this.audio.currentTime - this.start > CLIP_SECONDS) this.audio.pause(); });
      this.score = { right: 0, total: 0 };
      this.box = document.createElement("div");
      this.box.className = "listen-box";
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<span class="player-mode"><button type="button" data-v="quiz" class="on">Угадайка</button><button type="button" data-v="all">Послушать все</button></span>' +
        '<button type="button" data-a="stop">■ Стоп</button><span class="player-score lab-info"></span>';
      el.append(this.box, bar);
      this.info = bar.querySelector(".lab-info");
      bar.querySelector("[data-a=stop]").addEventListener("click", () => this.audio.pause());
      bar.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => {
        bar.querySelectorAll("[data-v]").forEach((x) => x.classList.toggle("on", x === b));
        this.view = b.dataset.v; this.render();
      }));
      this.view = "quiz";
      this.render();
    }

    play(clip) {
      this.start = clip[3];
      this.audio.src = COMMONS + clip[2];
      this.audio.currentTime = clip[3];
      this.audio.play().catch(() => { this.info.textContent = "Запись не загрузилась: нужен интернет."; });
    }

    render() {
      const b = this.box;
      b.innerHTML = "";
      if (this.view === "all") {
        FAMILIES.forEach((fam) => {
          const row = document.createElement("div");
          row.className = "player-controls";
          row.innerHTML = `<b>${fam[0].toUpperCase() + fam.slice(1)}:</b>`;
          CLIPS.filter((c) => c[1] === fam).forEach((c) => {
            const btn = document.createElement("button");
            btn.type = "button"; btn.textContent = "▶ " + c[0];
            btn.addEventListener("click", () => { this.play(c); this.info.textContent = `Играет: ${c[0]} (${c[1]})`; });
            row.append(btn);
          });
          b.append(row);
        });
        this.info.textContent = "Сравнивайте пары: гитара и скрипка, флейта и труба, фортепиано и орган, малый и ксилофон.";
        return;
      }
      const row = document.createElement("div");
      row.className = "player-controls";
      const next = document.createElement("button");
      next.type = "button"; next.className = "player-play"; next.textContent = this.current ? "▶ Ещё раз" : "▶ Следующая запись";
      next.addEventListener("click", () => {
        if (!this.current || this.answered) { this.current = CLIPS[Math.floor(Math.random() * CLIPS.length)]; this.answered = false; this.family = null; }
        this.play(this.current);
        this.render();
      });
      row.append(next);
      if (this.current && this.answered) {
        const again = document.createElement("button");
        again.type = "button"; again.textContent = "▶ Следующая запись";
        again.addEventListener("click", () => { this.current = CLIPS[Math.floor(Math.random() * CLIPS.length)]; this.answered = false; this.family = null; this.play(this.current); this.render(); });
        row.append(again);
      }
      b.append(row);
      if (!this.current) { this.info.textContent = "Нажмите «Следующая запись»."; return; }
      const ask = (label, options, onPick) => {
        const r = document.createElement("div");
        r.className = "player-controls";
        r.innerHTML = `<b>${label}</b>`;
        options.forEach((o) => {
          const btn = document.createElement("button");
          btn.type = "button"; btn.textContent = o;
          btn.addEventListener("click", () => onPick(o));
          r.append(btn);
        });
        b.append(r);
      };
      if (!this.family) {
        ask("Какое семейство?", FAMILIES, (f) => {
          if (f !== this.current[1]) { this.info.textContent = `Нет, не ${f}. Послушайте ещё раз: что колеблется?`; return; }
          this.family = f; this.info.textContent = `Верно, ${f}. А какой инструмент?`; this.render();
        });
      } else if (!this.answered) {
        ask("Какой инструмент?", CLIPS.filter((c) => c[1] === this.family).map((c) => c[0]), (name) => {
          this.score.total++;
          if (name === this.current[0]) { this.score.right++; this.info.textContent = `Да, это ${name}! Счёт: ${this.score.right} из ${this.score.total}.`; }
          else this.info.textContent = `Это был инструмент «${this.current[0]}». Счёт: ${this.score.right} из ${this.score.total}.`;
          this.answered = true; this.render();
        });
      }
    }
  }


  // ---------- clapping with a microphone (3.4) ----------
  // Onsets are sudden jumps of short-time energy in the microphone signal. Microphone and speakers add a delay of their
  // own, measured once by clapping along with clicks ("калибровка") and subtracted. Echo cancellation stays on so the
  // page's own clicks are removed from the microphone; noise suppression and auto gain are off, they flatten claps.
  // Two hands are told apart by brightness (share of high frequencies right after the hit): a slap on a table is
  // brighter than a pat on the knee. Everything is computed in the browser; nothing leaves the device.
  const CLAP_EXERCISES = [
    { name: "1. Каждая доля", bars: 8, hits: (b) => [0, 1, 2, 3].map((x) => ({ beat: b * 4 + x })),
      text: "хлопайте на каждый щелчок: «раз, два, три, четыре»" },
    { name: "2. Восьмые", bars: 8, hits: (b) => [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((x) => ({ beat: b * 4 + x })),
      text: "два хлопка на щелчок: «раз-и, два-и»" },
    { name: "3. Метроном пропадает", bars: 8, clickOff: (b) => b % 4 >= 2, hits: (b) => [0, 1, 2, 3].map((x) => ({ beat: b * 4 + x })),
      text: "каждые два такта метроном замолкает на два — держите темп сами" },
    { name: "4. Повтори ритм", bars: 8, call: true,
      hits: (b) => (b % 2 ? [[0, 1, 2, 3], [0, 1, 1.5, 2, 3], [0, 0.5, 1, 2, 3], [0, 1, 2, 2.5, 3, 3.5]][(b >> 1) % 4] : []).map((x) => ({ beat: b * 4 + x })),
      text: "в нечётных тактах хлопает опыт, в чётных повторяйте его ритм" },
    { name: "5. Две руки", bars: 8, hands: true,
      hits: (b) => (b < 4 ? [[0, "R"], [1, "L"], [2, "R"], [3, "L"]] : [[0, "R"], [0.5, "L"], [1, "R"], [1.5, "L"], [2, "R"], [2.5, "L"], [3, "R"], [3.5, "L"]])
        .map(([x, hand]) => ({ beat: b * 4 + x, hand })),
      text: "правая — по столу, левая — по колену: сначала правая на «раз» и «три», левая на «два» и «четыре», потом по очереди восьмыми" },
  ];
  const CLAP_GOOD = 0.04, CLAP_OK = 0.09; // seconds: green within 40 ms, orange within 90 ms

  class ClapLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: «Включить микрофон», затем один раз «Калибровка» — похлопайте вместе с 8 щелчками. Выберите упражнение и нажмите «Старт». Лучше в наушниках; без них включите «мигание». Звук микрофона обрабатывается только в браузере.");
      this.bpm = 70; this.ex = 0; this.flashOnly = false;
      this.latency = Number((() => { try { return localStorage.getItem("clap-latency"); } catch (e) { return null; } })()) || 0;
      this.handModel = null; this.hits = []; this.running = false;
      this.canvas = document.createElement("canvas");
      this.canvas.style.touchAction = "manipulation";
      this.g = this.canvas.getContext("2d");
      const pick = document.createElement("div");
      pick.className = "player-controls";
      pick.innerHTML = '<span class="player-mode">' + CLAP_EXERCISES.map((e, i) => `<button type="button" data-ex="${i}"${i ? "" : ' class="on"'}>${e.name}</button>`).join("") + "</span>";
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<button type="button" data-a="mic">🎤 Включить микрофон</button>' +
        '<button type="button" data-a="cal">Калибровка</button><button type="button" data-a="hands">Запомнить руки</button>' +
        '<button type="button" class="player-play" data-a="go">▶ Старт</button>' +
        '<label>Темп <input type="range" min="50" max="120" step="5" value="70"> <span class="clap-bpm">70</span> BPM</label>' +
        '<span class="player-mode"><button type="button" data-m="sound" class="on">Метроном звуком</button><button type="button" data-m="flash">Миганием</button></span>' +
        '<span class="player-score lab-info"></span>';
      el.append(pick, this.canvas, bar);
      this.info = bar.querySelector(".lab-info");
      pick.querySelectorAll("[data-ex]").forEach((b) => b.addEventListener("click", () => {
        pick.querySelectorAll("[data-ex]").forEach((x) => x.classList.toggle("on", x === b));
        this.ex = Number(b.dataset.ex); this.stop(); this.say(CLAP_EXERCISES[this.ex].text); this.draw();
      }));
      bar.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => {
        bar.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("on", x === b));
        this.flashOnly = b.dataset.m === "flash";
      }));
      const range = bar.querySelector("input");
      range.addEventListener("input", () => { this.bpm = Number(range.value); bar.querySelector(".clap-bpm").textContent = this.bpm; });
      bar.querySelector("[data-a=mic]").addEventListener("click", () => this.openMic());
      bar.querySelector("[data-a=cal]").addEventListener("click", () => this.calibrate());
      bar.querySelector("[data-a=hands]").addEventListener("click", () => this.learnHands());
      this.goButton = bar.querySelector("[data-a=go]");
      this.goButton.addEventListener("click", () => (this.running ? this.stop() : this.start()));
      this.resize();
      window.addEventListener("resize", () => this.resize());
      this.say(this.latency ? `Задержка устройства уже измерена: ${Math.round(this.latency * 1000)} мс.` : "Сначала включите микрофон и пройдите калибровку.");
    }

    say(text) { this.info.textContent = text; }

    async openMic() {
      audio();
      if (this.mic) return true;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { this.say("Этот браузер не даёт доступ к микрофону."); return false; }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
      } catch (e) { this.say("Микрофон не разрешён. Разрешите его в настройках браузера для этой страницы."); return false; }
      const src = ctx.createMediaStreamSource(this.stream);
      const proc = ctx.createScriptProcessor(512, 1, 1);
      const mute = ctx.createGain(); mute.gain.value = 0;
      src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
      this.mic = { src, proc, avg: 1e-6, last: -1, pending: null, tail: new Float32Array(0) };
      proc.onaudioprocess = (e) => this.listen(e);
      this.say("Микрофон включён. Похлопайте — на ленте появятся точки. Затем «Калибровка».");
      this.loop();
      return true;
    }

    // Energy in 64-sample chunks; an onset is a chunk far louder than the recent average, at most every 70 ms.
    listen(e) {
      const d = e.inputBuffer.getChannelData(0), sr = ctx.sampleRate, m = this.mic;
      const t0 = (e.playbackTime || ctx.currentTime) - d.length / sr;
      if (m.pending) { this.finishOnset(d); }
      for (let i = 0; i + 64 <= d.length; i += 64) {
        let en = 0;
        for (let k = i; k < i + 64; k++) en += d[k] * d[k];
        en /= 64;
        const time = t0 + i / sr;
        if (en > 1e-5 && en > m.avg * 10 && time - m.last > 0.07) {
          m.last = time;
          m.pending = { time, samples: Array.from(d.subarray(i, Math.min(d.length, i + 768))) };
          if (m.pending.samples.length >= 768) this.finishOnset(null);
        }
        m.avg = m.avg * 0.995 + en * 0.005;
      }
    }

    // Brightness of the first ~16 ms after the onset: energy of the first difference over the energy of the signal.
    finishOnset(next) {
      const m = this.mic, s = m.pending.samples;
      if (next) for (let i = 0; i < next.length && s.length < 768; i++) s.push(next[i]);
      if (s.length < 768 && next !== null) return;
      let raw = 0, diff = 0;
      for (let i = 1; i < s.length; i++) { raw += s[i] * s[i]; diff += (s[i] - s[i - 1]) ** 2; }
      const onset = { time: m.pending.time - this.latency, bright: diff / (raw || 1e-9) };
      m.pending = null;
      if (this.collector) this.collector(onset); else this.addHit(onset);
    }

    handOf(onset) {
      if (!this.handModel) return null;
      const { R, L } = this.handModel;
      return Math.abs(onset.bright - R) < Math.abs(onset.bright - L) ? "R" : "L";
    }

    addHit(onset) {
      const hand = this.handOf(onset);
      this.hits.push({ ...onset, hand });
      if (this.hits.length > 400) this.hits.shift();
    }

    clickAt(time, accent) { tone(time, accent ? 1800 : 1200, 0, 0.04, accent ? 0.3 : 0.18, "square"); }
    clapAt(time) { [0, 0.008, 0.017].forEach((d, i) => hiss(time + d, 0.05 + i * 0.03, 0.35, "bandpass", 1400)); }

    async calibrate() {
      if (!(await this.openMic())) return;
      this.stop();
      const beat = 60 / 90, start = ctx.currentTime + 0.6, clicks = [];
      for (let i = 0; i < 12; i++) { const at = start + i * beat; this.clickAt(at, i % 4 === 0); if (i >= 4) clicks.push(at); }
      this.say("Калибровка: 4 щелчка отсчёта, затем хлопайте вместе с 8 щелчками…");
      const got = [];
      this.collector = (o) => got.push(o.time + this.latency);
      await new Promise((r) => setTimeout(r, (12 * beat + 1) * 1000));
      this.collector = null;
      const offsets = clicks.map((c) => got.reduce((best, g) => (Math.abs(g - c) < Math.abs(best - c) ? g : best), Infinity) - c)
        .filter((o) => Math.abs(o) < beat / 2).sort((a, b) => a - b);
      if (offsets.length < 5) { this.say(`Услышано ${offsets.length} хлопков из 8. Хлопайте громче или ближе к микрофону и повторите.`); return; }
      this.latency = offsets[Math.floor(offsets.length / 2)];
      try { localStorage.setItem("clap-latency", String(this.latency)); } catch (e) { /* private mode */ }
      this.say(`Задержка устройства: ${Math.round(this.latency * 1000)} мс, теперь она вычитается. Можно начинать.`);
    }

    async learnHands() {
      if (!(await this.openMic())) return;
      this.stop();
      const collect = (label) => new Promise((resolve) => {
        const got = [];
        this.say(label);
        this.collector = (o) => { got.push(o.bright); this.say(`${label} — ${got.length} из 4`); if (got.length === 4) { this.collector = null; resolve(got); } };
      });
      const R = await collect("Ударьте 4 раза правой ладонью по столу");
      const L = await collect("Теперь 4 раза левой ладонью по колену");
      const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
      const spread = (a) => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / a.length);
      this.handModel = { R: mean(R), L: mean(L) };
      const separation = Math.abs(mean(R) - mean(L)) / (spread(R) + spread(L) + 1e-9);
      this.say(separation > 2 ? "Руки различаются хорошо. Выберите упражнение «5. Две руки»." :
        "Звуки похожи, руки будут путаться. Бейте правой по столу звонче, а левой по колену мягче, или возьмите книгу вместо колена, и повторите.");
    }

    async start() {
      if (!(await this.openMic())) return;
      const ex = CLAP_EXERCISES[this.ex];
      if (ex.hands && !this.handModel) { this.say("Сначала «Запомнить руки»."); return; }
      this.beat = 60 / this.bpm;
      this.t0 = ctx.currentTime + 0.5 + 4 * this.beat; // after a bar of count-in
      this.expect = [];
      for (let b = 0; b < ex.bars; b++) ex.hits(b).forEach((h) => this.expect.push(h));
      this.clickOn = (beat) => beat < 0 || !(ex.clickOff && ex.clickOff(Math.floor(beat / 4)));
      for (let i = -4; i < ex.bars * 4; i++) {
        const at = this.t0 + i * this.beat;
        if (!this.flashOnly && this.clickOn(i)) this.clickAt(at, ((i % 4) + 4) % 4 === 0);
      }
      if (ex.call) for (let b = 0; b < ex.bars; b += 2) ex.hits(b + 1).forEach((h) => this.clapAt(this.t0 + (h.beat - 4) * this.beat));
      this.hits = [];
      this.running = true;
      this.goButton.textContent = "■ Стоп";
      this.say(`${ex.name}: ${ex.text}. Сначала такт отсчёта.`);
      clearTimeout(this.endTimer);
      this.endTimer = setTimeout(() => this.finish(), (this.t0 - ctx.currentTime + ex.bars * 4 * this.beat + 0.5) * 1000);
      this.loop();
    }

    stop() {
      if (!this.running) return;
      this.running = false;
      clearTimeout(this.endTimer);
      this.goButton.textContent = "▶ Старт";
      this.draw();
    }

    // Every expected hit gets the nearest detected one within half the gap to its neighbours.
    judge() {
      const ex = CLAP_EXERCISES[this.ex], beat = this.beat, used = new Set();
      return this.expect.map((h, i) => {
        const at = this.t0 + h.beat * beat;
        const gap = Math.min(i ? h.beat - this.expect[i - 1].beat : 1, i < this.expect.length - 1 ? this.expect[i + 1].beat - h.beat : 1) * beat / 2;
        let best = null;
        this.hits.forEach((x, j) => { if (!used.has(j) && Math.abs(x.time - at) < gap && (!best || Math.abs(x.time - at) < Math.abs(best.x.time - at))) best = { x, j }; });
        if (best) used.add(best.j);
        return { ...h, at, dev: best ? best.x.time - at : null, wrongHand: ex.hands && best && best.x.hand && best.x.hand !== h.hand };
      });
    }

    finish() {
      this.stop();
      const res = this.judge(), got = res.filter((r) => r.dev !== null);
      if (!got.length) { this.say("Хлопков не услышано. Проверьте микрофон и громкость хлопков."); return; }
      const mean = got.reduce((s, r) => s + r.dev, 0) / got.length;
      const good = got.filter((r) => Math.abs(r.dev) <= CLAP_GOOD).length;
      const hands = CLAP_EXERCISES[this.ex].hands ? `, не той рукой: ${got.filter((r) => r.wrongHand).length}` : "";
      const tend = Math.abs(mean) < 0.015 ? "ни спешите, ни отстаёте" : mean < 0 ? `в среднем спешите на ${Math.round(-mean * 1000)} мс` : `в среднем отстаёте на ${Math.round(mean * 1000)} мс`;
      this.say(`Точно: ${good} из ${res.length}, пропущено ${res.length - got.length}${hands}; ${tend}.`);
    }

    resize() {
      const w = this.el.clientWidth, h = 210;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      this.draw();
    }

    loop() {
      if (this.looping) return;
      this.looping = true;
      const tick = () => { this.draw(); if (this.mic || this.running) requestAnimationFrame(tick); else this.looping = false; };
      requestAnimationFrame(tick);
    }

    draw() {
      const g = this.g, w = this.w, h = this.h;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, w, h);
      const now = ctx ? ctx.currentTime : 0;
      const ex = CLAP_EXERCISES[this.ex];
      // the flashing beat: bright on every beat, red on the first of the bar, grey when the metronome is silent
      const beatNow = this.running ? (now - this.t0) / this.beat : null;
      const near = beatNow !== null ? Math.round(beatNow) : null;
      const lit = near !== null && Math.abs(beatNow - near) * this.beat < 0.1 && (this.flashOnly || true) && this.clickOn(near);
      g.fillStyle = lit ? (((near % 4) + 4) % 4 === 0 ? COLORS.bad : COLORS.flash) : "#e9e9e2";
      g.beginPath(); g.arc(60, h / 2 - 10, 38, 0, Math.PI * 2); g.fill();
      g.fillStyle = COLORS.text; g.font = "bold 13px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
      g.fillText(beatNow === null ? "доля" : beatNow < 0 ? `отсчёт ${4 + Math.floor(beatNow) + 1}` : `такт ${Math.floor(beatNow / 4) + 1}`, 60, h / 2 + 46);
      // timeline of two bars around now
      const x0 = 130, x1 = w - 16, span = 8;
      const from = this.running ? Math.max(-4, Math.floor(beatNow / 4) * 4 - (beatNow % 4 < 2 ? 4 : 0)) : 0;
      const bx = (beat) => x0 + ((beat - from) / span) * (x1 - x0);
      for (let b = from; b <= from + span; b++) {
        g.strokeStyle = b % 4 === 0 ? "#b5b5ac" : "#e4e4dc"; g.lineWidth = b % 4 === 0 ? 2 : 1;
        g.beginPath(); g.moveTo(bx(b), 24); g.lineTo(bx(b), h - 30); g.stroke();
        if (b % 4 === 0) { g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif"; g.textAlign = "left"; g.fillText(b < 0 ? "отсчёт" : `такт ${b / 4 + 1}`, bx(b) + 3, 18); }
      }
      if (this.running && beatNow >= from && beatNow <= from + span) {
        g.strokeStyle = COLORS.right; g.lineWidth = 2; g.beginPath(); g.moveTo(bx(beatNow), 24); g.lineTo(bx(beatNow), h - 30); g.stroke();
      }
      const midY = h / 2 - 10;
      const res = this.running || this.expect ? this.judge() : [];
      res.forEach((r) => {
        if (r.beat < from || r.beat > from + span) return;
        const x = bx(r.beat), y = ex.hands ? (r.hand === "R" ? midY - 22 : midY + 22) : midY;
        g.strokeStyle = COLORS.muted; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.stroke();
        if (ex.hands) { g.fillStyle = COLORS.muted; g.font = "10px Segoe UI, Arial, sans-serif"; g.textAlign = "center"; g.fillText(r.hand === "R" ? "П" : "Л", x, y + 4); }
        if (r.dev === null) return;
        const hx = x + (r.dev / this.beat / span) * (x1 - x0);
        g.fillStyle = r.wrongHand ? "#8e44ad" : Math.abs(r.dev) <= CLAP_GOOD ? COLORS.good : Math.abs(r.dev) <= CLAP_OK ? "#e0892b" : COLORS.bad;
        g.beginPath(); g.arc(hx, y, 6, 0, Math.PI * 2); g.fill();
        g.font = "10px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
        g.fillText(`${r.dev > 0 ? "+" : ""}${Math.round(r.dev * 1000)}`, hx, y + (ex.hands && r.hand === "R" ? -14 : 22));
      });
      // raw hits outside the exercise (testing the microphone)
      if (!this.running && !this.expect) this.hits.filter((x) => now - x.time < 3).forEach((x) => {
        g.fillStyle = COLORS.right; g.beginPath(); g.arc(x1 - (now - x.time) / 3 * (x1 - x0), midY, 5, 0, Math.PI * 2); g.fill();
      });
      g.fillStyle = COLORS.muted; g.font = "11px Segoe UI, Arial, sans-serif"; g.textAlign = "left";
      g.fillText("кружок — когда надо хлопнуть; точка — ваш хлопок: зелёный точно (±40 мс), оранжевый чуть мимо, красный мимо" +
        (ex.hands ? ", фиолетовый — не той рукой" : "") + "; числа — мс", 130, h - 10);
    }
  }


  // ---------- lesson 5: melody by ear ----------
  // Everything is in до major around the first octave; the ear learns notes relative to the tonic, not absolute pitch.
  const C_MAJOR = [60, 62, 64, 65, 67, 69, 71, 72]; // до … до
  const DEGREE_NAMES = ["до", "ре", "ми", "фа", "соль", "ля", "си", "до"];
  const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
  const EAR_LEVELS = [
    { name: "1. Выше или ниже", answers: ["выше", "ниже"], text: "звучат две ноты: вторая выше или ниже первой?",
      make() { const a = pickOne(C_MAJOR); let b; do b = pickOne(C_MAJOR); while (b === a); return { notes: [a, b], answer: b > a ? "выше" : "ниже" }; } },
    { name: "2. Шаг или скачок", answers: ["шаг", "скачок"], text: "соседние ступени (шаг) или через одну и больше (скачок)?",
      make() {
        const i = Math.floor(Math.random() * 7), leap = Math.random() < 0.5;
        const j = leap ? Math.min(7, i + 2 + Math.floor(Math.random() * 3)) : i + 1;
        const [a, b] = Math.random() < 0.5 ? [i, j] : [j, i];
        return { notes: [C_MAJOR[a], C_MAJOR[b]], answer: Math.abs(a - b) === 1 ? "шаг" : "скачок" };
      } },
    { name: "3. Вопрос или ответ", answers: ["вопрос", "ответ"], text: "фраза закончилась на тонике (ответ) или повисла (вопрос)?",
      make() {
        let i = pickOne([0, 2, 4]); const notes = [C_MAJOR[i]];
        for (let k = 0; k < 3; k++) { i = Math.max(0, Math.min(6, i + pickOne([-1, 1, 1, -2, 2]))); notes.push(C_MAJOR[i]); }
        const answer = Math.random() < 0.5 ? "ответ" : "вопрос";
        notes.push(answer === "ответ" ? 60 : C_MAJOR[pickOne([1, 4, 6])]);
        return { notes, answer, durations: [1, 1, 1, 1, 2] };
      } },
    { name: "4. Какая ступень", answers: ["до", "ре", "ми", "фа", "соль"], text: "после аккорда до–ми–соль звучит одна нота: какая?",
      make() { const i = Math.floor(Math.random() * 5); return { chord: true, notes: [C_MAJOR[i]], answer: DEGREE_NAMES[i] }; } },
    { name: "5. Подбери 3 ноты", keys: 3, text: "подберите мелодию на клавиатуре; первая нота — до",
      make() { let i = 0; const notes = [60]; for (let k = 0; k < 2; k++) { i = Math.max(0, Math.min(4, i + pickOne([-1, 1, 2]))); notes.push(C_MAJOR[i]); } return { notes }; } },
    { name: "6. Подбери 5 нот", keys: 5, text: "пять нот, первая — до; движения в основном шагами",
      make() { let i = 0; const notes = [60]; for (let k = 0; k < 4; k++) { i = Math.max(0, Math.min(5, i + pickOne([-1, 1, 1, 2, -2]))); notes.push(C_MAJOR[i]); } return { notes }; } },
  ];

  class EarTrainLab {
    constructor(el) {
      this.el = el;
      howto(el, "Как играть: выберите уровень и нажмите «Задание». Слушайте и отвечайте кнопками, а на уровнях 5–6 — на клавиатуре. «Ещё раз» повторяет задание. Переходите дальше, когда выходит 8 из 10.");
      this.level = 0; this.task = null; this.input = [];
      this.stats = EAR_LEVELS.map(() => []); // last answers per level, true / false
      this.lo = 60; this.hi = 72; this.down = null;
      const pick = document.createElement("div");
      pick.className = "player-controls";
      pick.innerHTML = '<span class="player-mode">' + EAR_LEVELS.map((l, i) => `<button type="button" data-lv="${i}"${i ? "" : ' class="on"'}>${l.name}</button>`).join("") + "</span>";
      const bar = document.createElement("div");
      bar.className = "player-controls";
      bar.innerHTML = '<button type="button" class="player-play" data-a="new">▶ Задание</button><button type="button" data-a="again">▶ Ещё раз</button>' +
        '<span class="ear-answers"></span><span class="player-score lab-info"></span>';
      this.canvas = document.createElement("canvas");
      this.g = this.canvas.getContext("2d");
      el.append(pick, bar, this.canvas);
      this.info = bar.querySelector(".lab-info");
      this.answersBox = bar.querySelector(".ear-answers");
      pick.querySelectorAll("[data-lv]").forEach((b) => b.addEventListener("click", () => {
        pick.querySelectorAll("[data-lv]").forEach((x) => x.classList.toggle("on", x === b));
        this.level = Number(b.dataset.lv); this.task = null; this.render();
      }));
      bar.querySelector("[data-a=new]").addEventListener("click", () => { this.task = EAR_LEVELS[this.level].make(); this.input = []; this.render(); this.play(); });
      bar.querySelector("[data-a=again]").addEventListener("click", () => this.task && this.play());
      holdable(this.canvas, (x, y) => {
        const m = ChordLab.prototype.keyAt.call(this, x, y);
        if (m === undefined) return;
        this.down = m; this.draw();
        const stop = holdNote(midiFreq(m));
        this.typed(m);
        return () => { stop(); this.down = null; this.draw(); };
      });
      this.resize();
      window.addEventListener("resize", () => this.resize());
      this.render();
    }

    play() {
      audio();
      const t0 = ctx.currentTime + 0.1, task = this.task, beat = 0.5;
      let at = t0;
      if (task.chord) { [60, 64, 67].forEach((m) => pianoNote(at, m, 1.2)); at += 1.8; }
      task.notes.forEach((m, i) => { const d = (task.durations ? task.durations[i] : 1) * beat; pianoNote(at, m, d * 0.95); at += d; });
    }

    answer(a) {
      if (!this.task || this.task.done) return;
      this.score(a === this.task.answer, `Верно: ${this.task.answer}!`, `Нет, это «${this.task.answer}». Послушайте ещё раз.`);
    }

    typed(m) {
      const lv = EAR_LEVELS[this.level];
      if (!lv.keys || !this.task || this.task.done) return;
      this.input.push(m);
      if (this.input.length < lv.keys) { this.info.textContent = `нота ${this.input.length} из ${lv.keys}`; return; }
      const ok = this.input.every((x, i) => x === this.task.notes[i]);
      const names = (ns) => ns.map((x) => NAMES[x % 12]).join(" ");
      this.score(ok, `Верно: ${names(this.task.notes)}!`, `Было ${names(this.task.notes)}, а вы сыграли ${names(this.input)}.`);
    }

    score(ok, yes, no) {
      this.task.done = true;
      const s = this.stats[this.level];
      s.push(ok); if (s.length > 10) s.shift();
      const right = s.filter(Boolean).length;
      this.info.textContent = `${ok ? yes : no} Последние ${s.length}: верно ${right}.` + (s.length === 10 && right >= 8 && this.level < EAR_LEVELS.length - 1 ? " Можно на следующий уровень!" : "");
      if (!ok) setTimeout(() => this.play(), 600);
    }

    render() {
      const lv = EAR_LEVELS[this.level];
      this.answersBox.innerHTML = "";
      (lv.answers || []).forEach((a) => {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = a;
        b.addEventListener("click", () => this.answer(a));
        this.answersBox.append(b);
      });
      this.canvas.style.display = lv.keys ? "block" : "none";
      if (!this.task) this.info.textContent = lv.text[0].toUpperCase() + lv.text.slice(1) + (/[?!.]$/.test(lv.text) ? " " : ". ") + "Нажмите «Задание».";
      this.draw();
    }

    resize() {
      const w = this.el.clientWidth, h = Math.round(Math.min(170, w * 0.28));
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.height = h + "px";
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      ChordLab.prototype.layout.call(this);
      this.draw();
    }

    draw() {
      const g = this.g, { top, keysH, kw } = this;
      if (!this.keys) return;
      g.fillStyle = COLORS.bg; g.fillRect(0, 0, this.w, this.h);
      g.textAlign = "center";
      const first = this.task && EAR_LEVELS[this.level].keys ? this.task.notes[0] : null;
      for (let m = this.lo; m <= this.hi; m++) {
        if (isBlack(m)) continue;
        const k = this.keys[m];
        g.fillStyle = m === this.down ? COLORS.flash : m === first ? "#e3eaf7" : "#fff";
        roundRect(g, k.x + 1, top, k.w - 2, keysH, 6); g.fill();
        g.strokeStyle = "#cfcfc6"; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = "#222"; g.font = `${m % 12 === 0 ? "bold " : ""}${Math.min(14, kw * 0.3)}px Segoe UI, Arial, sans-serif`;
        g.fillText(NAMES[m % 12], k.x + k.w / 2, top + keysH - 10);
        if (m === first) { g.fillStyle = COLORS.right; g.font = "11px Segoe UI, Arial, sans-serif"; g.fillText("первая нота", k.x + k.w / 2, top + keysH * 0.75); }
      }
      for (let m = this.lo; m <= this.hi; m++) {
        if (!isBlack(m)) continue;
        const k = this.keys[m];
        g.fillStyle = m === this.down ? COLORS.flash : "#c5c5bc";
        roundRect(g, k.x, top - 1, k.w, keysH * 0.62 + 1, 4); g.fill();
      }
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

  // A picture (and its italic caption) right above an interactive block shows the same thing: hide it on screen.
  function markDuplicate(el) {
    const isCaption = (n) => n && n.tagName === "P" && n.children.length === 1 && n.firstElementChild.tagName === "EM" &&
      n.textContent.trim() === n.firstElementChild.textContent.trim();
    const isImage = (n) => n && n.tagName === "P" && n.querySelector("img") && n.textContent.trim() === "";
    let prev = el.previousElementSibling;
    if (isCaption(prev) && isImage(prev.previousElementSibling)) {
      prev.classList.add("web-dup");
      prev.previousElementSibling.classList.add("web-dup");
    } else if (isImage(prev)) prev.classList.add("web-dup");
  }

  function init() {
    setTimeout(() => document.querySelectorAll(".lab, .player").forEach((el) => (el._lab || el._player) && markDuplicate(el)));
    document.querySelectorAll(".lab[data-lab=ruler]").forEach((el) => el._lab || (el._lab = new RulerLab(el)));
    document.querySelectorAll(".lab[data-lab=octaves]").forEach((el) => el._lab || (el._lab = new OctaveLab(el)));
    document.querySelectorAll(".lab[data-lab=intervals]").forEach((el) => el._lab || (el._lab = new IntervalLab(el)));
    document.querySelectorAll(".lab[data-lab=ear]").forEach((el) => el._lab || (el._lab = new EarLab(el)));
    document.querySelectorAll(".lab[data-lab=chords]").forEach((el) => el._lab || (el._lab = new ChordLab(el)));
    document.querySelectorAll(".lab[data-lab=synth]").forEach((el) => el._lab || (el._lab = new SynthLab(el)));
    document.querySelectorAll(".lab[data-lab=listen]").forEach((el) => el._lab || (el._lab = new ListenLab(el)));
    document.querySelectorAll(".lab[data-lab=clap]").forEach((el) => el._lab || (el._lab = new ClapLab(el)));
    document.querySelectorAll(".lab[data-lab=eartrain]").forEach((el) => el._lab || (el._lab = new EarTrainLab(el)));
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
