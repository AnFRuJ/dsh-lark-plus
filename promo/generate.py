# 渲染推广图：GitHub social preview / 朋友圈方图 / B 站封面（两个文案变体）。
#   python promo/generate.py
# 依赖：Pillow。字体用 Windows 自带的微软雅黑 Bold / Consolas（换系统就改下面三行路径）。
# 改文案 = 改 MOMENTS / COVERS 里的字符串，然后重跑本脚本。
import collections
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "mascot.png")
QR_PATH = os.path.join(ROOT, "promo", "qr-github.png")
OUT = os.path.join(ROOT, "promo")

F_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
F_REG = r"C:\Windows\Fonts\msyh.ttc"
F_MONO = r"C:\Windows\Fonts\consola.ttf"

ACCENT = (122, 188, 255)
TITLE = (236, 242, 254)
BODY = (202, 214, 236)
MUTED = (136, 158, 190)
GREEN = (122, 220, 176)

CMD = "npm i dsh-lark-plus"
URL = "github.com/AnFRuJ/dsh-lark-plus"

# 主线：把 DSH 智能体接进飞书（语音只是附带的完善项，绝不放在头条）
MOMENTS = {
    "title": "dsh-lark-plus",
    "subtitle": ["DeepSeek Harness × 飞书 / Lark", "双向桥接 · 开源插件"],
    "bullets": [
        "① 在飞书里指挥电脑上的 AI 干活",
        "② 卡片 / 审批 / 任务板 / goal / 定时",
        "③ 手机就是遥控器：30 秒扫码接入",
    ],
    "bonus": "附：语音消息也能用（本机转写 + 网页端回放）",
    "qr_caption": "扫码看开源仓库",
}

SOCIAL = {
    "lines": [
        "私聊 · 卡片按钮 · 审批与回传 · 任务板 · goal · 定时任务",
        "出门在外也能用：手机 = 遥控器，消息零丢失",
    ],
    "bonus": "附：语音消息在本机转文字，网页端可回放",
}

# B 站封面两个变体，二选一（A 更"像视频标题"，B 更直白）
COVERS = [
    {
        "file": "bilibili-cover.png",
        "big": ["把 AI 员工", "请进飞书"],
        "sub": "手机就是遥控器，随时指挥电脑干活",
        "note": "DSH × 飞书 双向桥接 · 开源插件",
    },
    {
        "file": "bilibili-cover-b.png",
        "big": ["手机指挥", "电脑里的 AI"],
        "sub": "DSH × 飞书 双向桥接 · 开源",
        "note": "扫码 30 秒接入 · 消息零丢失",
    },
]


def keyed_mascot():
    """抠掉白底，让竖图融进深色背景。"""
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size
    border = []
    for x in range(0, w, 7):
        border += [im.getpixel((x, 0)), im.getpixel((x, h - 1))]
    for y in range(0, h, 7):
        border += [im.getpixel((0, y)), im.getpixel((w - 1, y))]
    common = collections.Counter([p[:3] for p in border]).most_common(1)[0][0]
    lum = 0.2126 * common[0] + 0.7152 * common[1] + 0.0722 * common[2]
    if lum > 200:
        px = im.load()
        for y in range(h):
            for x in range(w):
                r, g, b, _a = px[x, y]
                dist = abs(r - common[0]) + abs(g - common[1]) + abs(b - common[2])
                px[x, y] = (r, g, b, 0 if dist < 60 else (int(255 * (dist - 60) / 60) if dist < 120 else 255))
    return im


MASCOT = keyed_mascot()


def base(width, height):
    bg = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(bg)
    for y in range(height):
        t = y / height
        draw.line([(0, y), (width, y)], fill=(int(9 + 16 * t), int(15 + 24 * t), int(30 + 38 * t)))
    glow = Image.new("L", (width, height), 0)
    ImageDraw.Draw(glow).ellipse(
        [width - int(width * 0.52), -int(height * 0.36), width + int(width * 0.18), int(height * 0.8)],
        fill=72,
    )
    bg = Image.composite(Image.new("RGB", (width, height), (38, 88, 168)), bg, glow)
    return bg.convert("RGBA")


def paste_mascot(bg, height, right, top):
    mh = height
    mw = int(MASCOT.width * mh / MASCOT.height)
    m = MASCOT.resize((mw, mh), Image.LANCZOS)
    x, y = bg.width - mw - right, top
    shadow = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse([x + 24, y + mh - 46, x + mw - 24, y + mh + 18], fill=(0, 0, 0, 120))
    bg.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22)))
    bg.alpha_composite(m, (x, y))


def save(bg, name):
    out = os.path.join(OUT, name)
    bg.convert("RGB").save(out, "PNG", optimize=True)
    print("写出", out)


def render_social_preview():
    W, H = 1280, 640
    bg = base(W, H)
    d = ImageDraw.Draw(bg)
    paste_mascot(bg, 460, 40, (H - 460) // 2)
    d.text((72, 96), MOMENTS["title"], font=ImageFont.truetype(F_BOLD, 82), fill=TITLE)
    d.text((76, 204), "DeepSeek Harness × 飞书 / Lark 双向桥接", font=ImageFont.truetype(F_BOLD, 33), fill=ACCENT)
    y = 276
    for line in SOCIAL["lines"]:
        d.text((78, y), line, font=ImageFont.truetype(F_REG, 27), fill=BODY)
        y += 44
    d.text((78, y), SOCIAL["bonus"], font=ImageFont.truetype(F_REG, 24), fill=MUTED)
    d.line([(78, 442), (600, 442)], fill=(58, 80, 112), width=2)
    d.text((78, 462), CMD, font=ImageFont.truetype(F_MONO, 27), fill=GREEN)
    d.text((78, 508), URL, font=ImageFont.truetype(F_MONO, 27), fill=MUTED)
    save(bg, "social-preview.png")


def render_moments():
    W = H = 1080
    bg = base(W, H)
    paste_mascot(bg, 250, 40, 96)
    d = ImageDraw.Draw(bg)
    d.text((76, 120), MOMENTS["title"], font=ImageFont.truetype(F_BOLD, 86), fill=TITLE)
    y = 236
    for line in MOMENTS["subtitle"]:
        d.text((80, y), line, font=ImageFont.truetype(F_BOLD, 38), fill=ACCENT)
        y += 52
    y = 400
    for line in MOMENTS["bullets"]:
        d.text((80, y), line, font=ImageFont.truetype(F_REG, 33), fill=BODY)
        y += 52
    d.text((80, y + 6), MOMENTS["bonus"], font=ImageFont.truetype(F_REG, 25), fill=MUTED)
    d.line([(80, y + 66), (620, y + 66)], fill=(58, 80, 112), width=2)
    d.text((80, y + 86), CMD, font=ImageFont.truetype(F_MONO, 30), fill=GREEN)
    d.text((80, y + 134), URL, font=ImageFont.truetype(F_MONO, 27), fill=MUTED)
    if os.path.exists(QR_PATH):
        panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(panel).rounded_rectangle((700, 690, 1020, 1010), radius=28, fill=(255, 255, 255, 255))
        bg.alpha_composite(panel)
        bg.paste(Image.open(QR_PATH).convert("RGB").resize((280, 280), Image.LANCZOS), (720, 710))
        d = ImageDraw.Draw(bg)
        d.text((706, 1020), MOMENTS["qr_caption"], font=ImageFont.truetype(F_REG, 26), fill=(150, 170, 200))
    save(bg, "moments-1080.png")


def render_cover(cover):
    W, H = 1146, 717
    bg = base(W, H)
    paste_mascot(bg, 380, 24, 300)
    d = ImageDraw.Draw(bg)
    d.text((60, 120), cover["big"][0], font=ImageFont.truetype(F_BOLD, 104), fill=TITLE)
    d.text((60, 238), cover["big"][1], font=ImageFont.truetype(F_BOLD, 104), fill=ACCENT)
    d.text((66, 372), cover["sub"], font=ImageFont.truetype(F_BOLD, 42), fill=(226, 234, 250))
    d.text((66, 436), cover["note"], font=ImageFont.truetype(F_BOLD, 32), fill=(150, 170, 200))
    d.line([(66, 506), (560, 506)], fill=(58, 80, 112), width=2)
    d.text((66, 524), CMD, font=ImageFont.truetype(F_MONO, 28), fill=GREEN)
    save(bg, cover["file"])


if __name__ == "__main__":
    render_social_preview()
    render_moments()
    for cover in COVERS:
        render_cover(cover)
