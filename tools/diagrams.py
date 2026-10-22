"""Render the book diagrams (chapters 1 and 3): HTML pages screenshotted by headless Chrome at 1344 px wide.

Usage: python tools/diagrams.py images
"""
import html
import tempfile
import subprocess
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
WORK = Path(tempfile.gettempdir()) / "music-diagrams"
WORK.mkdir(exist_ok=True)
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #fff; color: #111; font-family: "Segoe UI", Arial, sans-serif; padding: 18px 20px 14px; }
h1 { font-size: 15px; font-weight: 700; margin-bottom: 18px; }
.note { font-size: 11px; color: #555; text-align: center; margin-top: 6px; line-height: 1.45; }
table { border-collapse: collapse; margin: 0 auto; table-layout: fixed; }
table.g td, table.g th { padding: 3px 2px; }
td.sep { width: 2px; padding: 0 !important; background: #c9c9c0; }
.b { border: 1.5px solid #e2e2e2; border-radius: 5px; height: 26px; line-height: 23px; font-size: 10.5px; color: #333; }
.b.on { background: #7eaee6; border-color: #2f72c9; color: #0b2a55; font-weight: 700; }
td, th { text-align: center; font-size: 11px; }
th { font-weight: 400; color: #555; height: 20px; }
th.num { font-weight: 700; color: #111; }
td.lbl { text-align: right; font-weight: 700; padding-right: 8px; white-space: nowrap; font-size: 12px; }
td.c { border: 1.5px solid #e2e2e2; border-radius: 5px; height: 26px; font-size: 10px; color: #333; }
td.on { background: #7eaee6; border-color: #2f72c9; color: #0b2a55; font-weight: 700; }
td.soft { background: #cfe0f7; border-color: #2f72c9; color: #0b2a55; font-weight: 700; }
td.bl { box-shadow: -3px 0 0 -1px #c9c9c0; }
"""


def page(name, body, height, width=672):
    src = WORK / f"{name}.html"
    src.write_text(f"<!doctype html><meta charset=utf-8><style>{CSS} body {{ width: {width}px; }}</style><body>{body}</body>", encoding="utf-8")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--force-device-scale-factor={1344 / width}",
                    f"--window-size={width},{height}", f"--screenshot={OUT / (name + '.png')}", src.as_uri()],
                   check=True, capture_output=True)


def grid(title, cols, rows, notes, cell_w, label_w=110):
    """cols: header labels; rows: (label, set of 1-based hit columns, optional {col: text}); a line between beats."""
    per_beat = len(cols) // 4
    def sep(i):
        return '<td class="sep"></td>' if i > 1 and (i - 1) % per_beat == 0 else ""
    head = f'<tr><th style="width:{label_w}px"></th>' + "".join(
        sep(i) + f'<th class="{"num" if (i - 1) % per_beat == 0 else ""}" style="width:{cell_w}px">{html.escape(c)}</th>'
        for i, c in enumerate(cols, 1)) + "</tr>"
    body = ""
    for label, hits, *text in rows:
        text = text[0] if text else {}
        cells = "".join(sep(i) + f'<td><div class="b{" on" if i in hits else ""}">{html.escape(text.get(i, ""))}</div></td>'
                        for i in range(1, len(cols) + 1))
        body += f'<tr><td class="lbl">{html.escape(label)}</td>{cells}</tr>'
    notes_html = "".join(f'<p class="note">{html.escape(n)}</p>' for n in notes)
    return f'<h1>{html.escape(title)}</h1><table class="g">{head}{body}</table>{notes_html}'


EIGHTHS = ["раз", "и", "два", "и", "три", "и", "четыре", "и"]
SIXTEENTHS = ["та", "ка", "ди", "ми"] * 4
GRID_NOTES = ["вертикальные линии — границы долей; четыре доли = один такт",
              "закрашенная клетка — удар, пустая — пауза"]

# 03-takt: the step grid of a bar (replaces the old 05-takt, whose caption pointed at the wrong chapter)
steps = "".join(('<td class="sep"></td>' if i > 1 and i % 4 == 1 else "")
                + f'<td style="width:36px"><div class="b{" on" if i % 4 == 1 else ""}" style="height:32px;line-height:29px;font-size:12px">{i}</div></td>'
                for i in range(1, 17))
beats = "".join(('<td></td>' if n > 1 else "")
                + f'<td colspan="4" style="padding-top:8px;font-size:12px;border-top:1.5px solid #c9c9c0">доля {n} («{w}»)</td>'
                for n, w in enumerate(("раз", "два", "три", "четыре"), 1))
page("03-takt", f"""<h1>Один такт = 4 доли = 16 шагов</h1>
<table class="g"><tr><td colspan="19" style="text-align:left;color:#555;font-size:11px">шаги секвенсора</td></tr>
<tr>{steps}</tr><tr>{beats}</tr>
<tr><td colspan="19" style="padding-top:10px;font-weight:700;font-size:13px;border-top:1.5px solid #c9c9c0">один такт</td></tr></table>
<p class="note">закрашенные шаги 1, 5, 9, 13 — начала долей, именно на них в главе 6 стоит бочка</p>""", 225, 760)

# 03-delenie-doli: quarters, eighths, sixteenths over one bar
def spans(words, span):
    out = ""
    for i, w in enumerate(words):
        if i and (i * span) % 4 == 0:
            out += '<td class="sep"></td>'
        out += f'<td colspan="{span}"><div class="b on">{w}</div></td>'
    return out
cols16 = "".join(('<td class="sep"></td>' if i and i % 4 == 0 else "") + '<th style="width:38px"></th>' for i in range(16))
page("03-delenie-doli", f"""<h1>Каждое деление вдвое мельче предыдущего: 4, 8 и 16 ударов на такт</h1>
<table class="g"><tr><th style="width:110px"></th>{cols16}</tr>
<tr><td class="lbl">Четверти</td>{spans(["раз", "два", "три", "четыре"], 4)}</tr>
<tr><td class="lbl">Восьмые</td>{spans(EIGHTHS, 2)}</tr>
<tr><td class="lbl">Шестнадцатые</td>{spans(SIXTEENTHS, 1)}</tr></table>
<p class="note">каждая клетка — один удар; все три строки занимают один и тот же такт</p>
<p class="note">шестнадцатая — это один шаг секвенсора; «та» всегда на доле, «ди» — там же, где «и» у восьмых</p>""", 228, 860)

# 03-ustanovka: generic compact electronic kit
def pad(x, y, r, label, cymbal=False):
    fill = "#eef3fb" if cymbal else "#cfe0f7"
    return (f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}" stroke="#2f72c9" stroke-width="2"/>'
            f'<text x="{x}" y="{y + 4}" text-anchor="middle" font-size="12" font-weight="700">{label}</text>')
def pedal(x, y, label, sub):
    return (f'<rect x="{x - 45}" y="{y}" width="90" height="46" rx="6" fill="#7eaee6" stroke="#2f72c9" stroke-width="2"/>'
            f'<text x="{x}" y="{y + 20}" text-anchor="middle" font-size="12" font-weight="700">{label}</text>'
            f'<text x="{x}" y="{y + 36}" text-anchor="middle" font-size="10">{sub}</text>')
svg = ('<svg width="632" height="330" font-family="Segoe UI, Arial, sans-serif">'
       '<rect x="70" y="10" width="492" height="222" rx="40" fill="#f6f6f2" stroke="#c9c9c0" stroke-width="1.5"/>'
       + pad(160, 70, 44, "Крэш", True) + pad(316, 72, 44, "Том 1") + pad(472, 70, 44, "Райд", True)
       + pad(110, 175, 44, "Хай-хэт", True) + pad(235, 180, 44, "Малый") + pad(390, 180, 44, "Том 2")
       + pad(515, 175, 44, "Напольный")
       + pedal(150, 262, "Педаль хэта", "левая нога") + pedal(482, 262, "Бочка", "правая нога")
       + "</svg>")
page("03-ustanovka", f"""<h1>Пэды заменяют барабаны и тарелки, педали — ноги барабанщика</h1>{svg}
<p class="note">расположение условное: у разных моделей пэды и педали стоят по-разному, смотрите на подписи</p>""", 405)

page("03-bochka", grid("Та же основа, но бочка ещё и на «и» после «три»", EIGHTHS, [
    ("Хай-хэт", set(range(1, 9))), ("Малый", {3, 7}), ("Бочка", {1, 5, 6})], GRID_NOTES, 58), 228)

page("03-chetyre-na-pol", grid("Четыре на пол: бочка на каждую долю, открытый хэт между ними", EIGHTHS, [
    ("Открытый хэт", {2, 4, 6, 8}), ("Малый", {3, 7}), ("Бочка", {1, 3, 5, 7})],
    ["тот же бит в главе 6 вы запрограммируете на Circuit Tracks: бочка на шагах 1, 5, 9, 13",
     "закрашенная клетка — удар, пустая — пауза"], 58), 228)

hands = {i: ("П" if i % 2 else "Л") for i in range(1, 17)}
page("03-shestnadtsatye", grid("Шестнадцатые на хэте: руки по очереди, бочка на каждую долю", SIXTEENTHS, [
    ("Хай-хэт", set(range(1, 17)), hands), ("Бочка", {1, 5, 9, 13})],
    ["П — правая рука, Л — левая; вертикальные линии — границы долей"], 38), 170, 860)

page("03-sbivka", grid("Сбивка: полтакта бит, полтакта шестнадцатые по барабанам, затем крэш", SIXTEENTHS + ["та"], [
    ("Крэш", {17}), ("Хай-хэт", {1, 3, 5, 7}), ("Малый", {5, 9, 10}), ("Том 1", {11, 12}), ("Том 2", {13, 14}),
    ("Напольный", {15, 16}), ("Бочка", {1, 17})],
    ["последняя колонка — первая доля следующего такта: крэш вместе с бочкой, и бит начинается заново",
     "вертикальные линии — границы долей"], 36), 365, 900)


# 01-lineyka: ruler on the table edge, long vs short free end
def ruler_panel(x0, free, swings, label, sub):
    """free: overhang length in px; swings: angles (deg) of the ghost positions."""
    edge = x0 + 150
    g = (f'<rect x="{x0}" y="120" width="150" height="70" fill="#f6f6f2" stroke="#c9c9c0" stroke-width="1.5"/>'
         f'<rect x="{x0 + 40}" y="100" width="34" height="20" rx="4" fill="#7eaee6" stroke="#2f72c9" stroke-width="1.5"/>'
         f'<text x="{x0 + 57}" y="92" text-anchor="middle" font-size="10" fill="#555">рука прижимает</text>')
    for a in swings:
        g += (f'<rect x="{edge}" y="113" width="{free}" height="7" fill="#cfe0f7" stroke="#2f72c9" stroke-width="1" '
              f'opacity="0.55" transform="rotate({a} {edge} 116)"/>')
    g += (f'<rect x="{x0 + 20}" y="113" width="{130 + free}" height="7" fill="#7eaee6" stroke="#2f72c9" stroke-width="1.5"/>'
          f'<text x="{x0 + 75 + free / 2}" y="225" text-anchor="middle" font-size="13" font-weight="700">{label}</text>'
          f'<text x="{x0 + 75 + free / 2}" y="244" text-anchor="middle" font-size="11" fill="#333">{sub}</text>')
    return g
svg = ('<svg width="632" height="260" font-family="Segoe UI, Arial, sans-serif">'
       + ruler_panel(0, 150, (-24, -12, 12, 24), "длинный конец", "медленно: размах видно, само качание не слышно")
       + ruler_panel(350, 45, (-6, 6), "короткий конец", "часто: размах размыт, слышно гудение")
       + "</svg>")
page("01-lineyka", f"""<h1>Чем короче свободный конец, тем чаще он колеблется и тем выше звук</h1>{svg}
<p class="note">прозрачные линейки — крайние положения при колебании; размах показан условно</p>""", 345)


# 01-tetiva: pressing the string at different points (monochord ratios)
def string_row(y, frac, label, sub):
    x0, length = 140, 330
    sounding = length * frac
    g = (f'<text x="{x0 - 14}" y="{y + 4}" text-anchor="end" font-size="12" font-weight="700">{label}</text>'
         f'<line x1="{x0}" y1="{y}" x2="{x0 + length}" y2="{y}" stroke="#c9c9c0" stroke-width="3"/>'
         f'<line x1="{x0 + length - sounding}" y1="{y}" x2="{x0 + length}" y2="{y}" stroke="#2f72c9" stroke-width="5"/>'
         f'<rect x="{x0 - 6}" y="{y - 10}" width="6" height="20" fill="#555"/><rect x="{x0 + length}" y="{y - 10}" width="6" height="20" fill="#555"/>'
         f'<text x="{x0 + length + 16}" y="{y + 4}" font-size="11" fill="#333">{sub}</text>')
    if frac < 1:
        fx = x0 + length - sounding
        g += f'<circle cx="{fx}" cy="{y - 12}" r="7" fill="#7eaee6" stroke="#2f72c9" stroke-width="1.5"/>'
    return g
svg = ('<svg width="632" height="215" font-family="Segoe UI, Arial, sans-serif">'
       + string_row(30, 1, "вся струна", "исходный звук")
       + string_row(80, 3 / 4, "три четверти", "кварта выше, 4 : 3")
       + string_row(130, 2 / 3, "две трети", "квинта выше, 3 : 2")
       + string_row(180, 1 / 2, "половина", "октава выше, 2 : 1")
       + "</svg>")
page("01-tetiva", f"""<h1>Чем короче звучащая часть струны, тем выше звук: половина даёт октаву</h1>{svg}
<p class="note">синим — часть струны, которая звучит; кружок — палец, прижимающий струну</p>""", 310)

# 01-butylki: tapping vs blowing, opposite results
def bottle(x, level, mark):
    top, h, w = 70, 130, 52
    water_h = h * level
    return (f'<rect x="{x}" y="{top + h - water_h}" width="{w}" height="{water_h}" fill="#cfe0f7"/>'
            f'<path d="M{x} {top} V{top + h} H{x + w} V{top} M{x + 16} {top} V{top - 30} M{x + w - 16} {top} V{top - 30}" '
            f'fill="none" stroke="#2f72c9" stroke-width="2"/>'
            f'<line x1="{x}" y1="{top}" x2="{x + 16}" y2="{top}" stroke="#2f72c9" stroke-width="2"/>'
            f'<line x1="{x + w - 16}" y1="{top}" x2="{x + w}" y2="{top}" stroke="#2f72c9" stroke-width="2"/>'
            f'<text x="{x + w / 2}" y="{top + h + 22}" text-anchor="middle" font-size="12" font-weight="700">{mark}</text>')
svg = ('<svg width="632" height="300" font-family="Segoe UI, Arial, sans-serif">'
       '<text x="150" y="14" text-anchor="middle" font-size="13" font-weight="700">стучим ложкой</text>'
       '<text x="150" y="32" text-anchor="middle" font-size="11" fill="#333">звучит стекло вместе с водой</text>'
       + bottle(40, 0.25, "выше") + bottle(124, 0.5, "") + bottle(208, 0.8, "ниже")
       + '<text x="482" y="14" text-anchor="middle" font-size="13" font-weight="700">дуем в горлышко</text>'
       '<text x="482" y="32" text-anchor="middle" font-size="11" fill="#333">звучит воздух над водой</text>'
       + bottle(372, 0.25, "ниже") + bottle(456, 0.5, "") + bottle(540, 0.8, "выше")
       + '<line x1="316" y1="20" x2="316" y2="240" stroke="#c9c9c0" stroke-width="1.5"/>'
       '<text x="150" y="275" text-anchor="middle" font-size="11" fill="#333">больше воды — тяжелее, колеблется реже</text>'
       '<text x="482" y="275" text-anchor="middle" font-size="11" fill="#333">больше воды — меньше воздуха, колеблется чаще</text>'
       + "</svg>")
page("01-butylki", f"""<h1>Бутылки звучат наоборот: стучим — колеблется стекло, дуем — воздух</h1>{svg}
<p class="note">голубым — вода; высота звука подписана под каждой крайней бутылкой</p>""", 375)

# 01-plenka: sound travels through the air and makes grains jump
grains = "".join(f'<circle cx="{x}" cy="{y}" r="3" fill="#2f72c9"/>'
                 for x, y in ((380, 92), (402, 80), (425, 95), (447, 76), (470, 90), (492, 82), (515, 96), (436, 64), (482, 66)))
waves = "".join(f'<path d="M{200 + 34 * i} 70 q14 30 0 60" fill="none" stroke="#7eaee6" stroke-width="2.5"/>' for i in range(4))
svg = ('<svg width="632" height="210" font-family="Segoe UI, Arial, sans-serif">'
       '<rect x="40" y="70" width="110" height="80" rx="8" fill="#f6f6f2" stroke="#555" stroke-width="2"/>'
       '<text x="95" y="115" text-anchor="middle" font-size="12" font-weight="700">кастрюля</text>'
       '<line x1="60" y1="20" x2="110" y2="66" stroke="#555" stroke-width="5" stroke-linecap="round"/>'
       '<text x="95" y="175" text-anchor="middle" font-size="11" fill="#333">стучим ложкой или поём громко</text>'
       + waves +
       '<path d="M350 105 Q350 160 450 160 Q550 160 550 105 Z" fill="#f6f6f2" stroke="#555" stroke-width="2"/>'
       '<line x1="342" y1="105" x2="558" y2="105" stroke="#2f72c9" stroke-width="3"/>'
       + grains +
       '<text x="450" y="185" text-anchor="middle" font-size="11" fill="#333">миска с плёнкой: крупинки подпрыгивают</text>'
       + "</svg>")
page("01-plenka", f"""<h1>Звук долетает по воздуху и подбрасывает крупинки на плёнке</h1>{svg}
<p class="note">дуги — волны воздуха; расстояние и размеры условные</p>""", 300)
