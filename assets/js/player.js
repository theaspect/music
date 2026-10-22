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
      this.hit(target.key);
    }

    // One hit from any input: sound, flash, and in Play mode a verdict against the nearest expected note.
    hit(key, soundKey) {
      audio();
      activePlayer = this;
      if (this.kind === "piano") pianoNote(ctx.currentTime, key, 0.5);
      else DRUM_SOUND[soundKey || key](ctx.currentTime);
      let color = COLORS.flash;
      if (this.mode === "play" && this.playing) color = this.judge(key) ? COLORS.good : COLORS.bad;
      this.flashes[key] = { at: performance.now(), color };
      if (!this.playing) {
        this.draw(IDLE);
        setTimeout(() => !this.playing && this.draw(IDLE), 250);
      }
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
      const keysH = Math.min(130, this.h * 0.32);
      const top = this.h - keysH;
      const { lo, hi } = this.song;
      const whites = [];
      for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
      const kw = w / whites.length;
      const keyX = {};
      whites.forEach((m, i) => (keyX[m] = { x: i * kw, w: kw }));
      for (let m = lo; m <= hi; m++) {
        if (isBlack(m)) keyX[m] = { x: keyX[m - 1].x + kw * 0.68, w: kw * 0.64 };
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
      whites.forEach((m) => {
        const k = keyX[m];
        g.fillStyle = keyFill(m, "#fff");
        g.fillRect(k.x, top, k.w, keysH);
        g.strokeStyle = "#888"; g.lineWidth = 1; g.strokeRect(k.x + 0.5, top + 0.5, k.w - 1, keysH - 1);
        g.fillStyle = COLORS.muted; g.textAlign = "center";
        g.font = `${Math.min(12, kw * 0.32)}px Segoe UI, Arial, sans-serif`;
        g.fillText(NAMES[m % 12], k.x + k.w / 2, this.h - 10);
      });
      this.pianoKeyCodes = {};
      const base = lo + ((12 - (lo % 12)) % 12);
      PIANO_KEYS.forEach((code, i) => { if (base + i <= hi) this.pianoKeyCodes[code] = base + i; });
      for (let m = lo; m <= hi; m++) {
        if (!isBlack(m)) continue;
        const k = keyX[m];
        g.fillStyle = keyFill(m, "#222");
        g.fillRect(k.x, top, k.w, keysH * 0.6);
      }
      if (this.mode === "play") {
        Object.entries(this.pianoKeyCodes).forEach(([code, m]) => {
          const k = keyX[m];
          g.fillStyle = isBlack(m) ? "#fff" : COLORS.right;
          g.font = "bold 11px Segoe UI, Arial, sans-serif"; g.textAlign = "center";
          g.fillText(KEY_LABELS[code], k.x + k.w / 2, top + (isBlack(m) ? keysH * 0.5 : keysH * 0.75));
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
      g.strokeStyle = COLORS.text; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, top); g.lineTo(w, top); g.stroke();
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

  // Keys and MIDI go to the player last started or touched.
  let activePlayer = null;
  document.addEventListener("keydown", (ev) => {
    const p = activePlayer;
    if (!p || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName)) return;
    const key = p.kind === "piano" ? p.pianoKeyCodes && p.pianoKeyCodes[ev.code] : DRUM_KEYS[ev.code];
    if (key === undefined) return;
    ev.preventDefault();
    p.hit(key);
  });

  let midiRequested = false;
  function requestMidi() {
    if (midiRequested || !navigator.requestMIDIAccess) return;
    midiRequested = true;
    navigator.requestMIDIAccess().then((access) => {
      const listen = (input) => (input.onmidimessage = (msg) => {
        const [status, note, velocity] = msg.data;
        if ((status & 0xf0) !== 0x90 || velocity === 0 || !activePlayer) return;
        if (activePlayer.kind === "piano") activePlayer.hit(note);
        else if (GM_DRUMS[note]) activePlayer.hit(KIT[GM_DRUMS[note]].pad || GM_DRUMS[note], GM_DRUMS[note]);
      });
      access.inputs.forEach(listen);
      access.onstatechange = (ev) => ev.port.type === "input" && listen(ev.port);
    }).catch(() => {});
  }

  function init() {
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
