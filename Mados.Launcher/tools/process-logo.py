from pathlib import Path
from shutil import copyfile

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r"C:\Users\prolo\Downloads\64639b71bd21b9d0e041bad409bcb24b.jpg")
OUT = ROOT / "src" / "renderer" / "assets"
OUT.mkdir(parents=True, exist_ok=True)
PUBLIC = ROOT / "src" / "renderer" / "public"
PUBLIC.mkdir(parents=True, exist_ok=True)

if not SOURCE.exists():
    raise SystemExit(f"Logo source does not exist: {SOURCE}")

copyfile(SOURCE, OUT / "cat-logo-source.jpg")
image = Image.open(SOURCE).convert("RGBA")
pixels = image.load()
for y in range(image.height):
    for x in range(image.width):
        r, g, b, a = pixels[x, y]
        # The supplied art is a red silhouette on black. Turn the near-black
        # background transparent while preserving the red antialiased edge.
        darkness = max(r, g, b)
        alpha = max(0, min(255, int((darkness - 8) * 5)))
        if r > g * 1.35 and r > b * 1.2:
            alpha = max(alpha, 235)
        pixels[x, y] = (r, g, b, alpha)

image.save(OUT / "cat-logo.png", optimize=True)

def solid_variant(color: tuple[int, int, int], name: str) -> None:
    variant = Image.new("RGBA", image.size, (*color, 0))
    variant.putalpha(image.getchannel("A"))
    variant.save(OUT / name, optimize=True)


# Keep explicit light/dark marks for native title bars and future high-contrast
# surfaces. The silhouette alpha comes from the supplied artwork, so neither
# variant carries the JPG's black rectangle.
solid_variant((255, 255, 255), "cat-logo-light.png")
solid_variant((255, 31, 45), "cat-logo-dark.png")
icon_canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
icon_image = image.copy()
icon_image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
icon_canvas.paste(icon_image, ((1024 - icon_image.width) // 2, (1024 - icon_image.height) // 2), icon_image)
icon_canvas.save(OUT / "cat-logo.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256), (512, 512)])
copyfile(OUT / "cat-logo.ico", PUBLIC / "favicon.ico")
icons = OUT / "icons"
icons.mkdir(exist_ok=True)
for size in (16, 32, 48, 64, 128, 256, 512, 1024):
    image.resize((size, size), Image.Resampling.LANCZOS).save(icons / f"cat-logo-{size}.png", optimize=True)
try:
    icon_canvas.save(OUT / "cat-logo.icns", format="ICNS")
except OSError:
    # Linux CI can still package the PNG/ICO variants when Pillow lacks an
    # ICNS writer; macOS builders use the generated file from developer assets.
    pass

# A small clean vector companion is used for scalable UI marks and favicons.
# It keeps the recognizable pointed ears, face, whiskers and upright body.
(OUT / "cat-logo.svg").write_text(
    """<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 720 720\">
  <path fill=\"#ff1f2d\" d=\"M112 177 88 96l88 41c40-30 94-44 184-44s144 14 184 44l88-41-24 81c21 31 31 73 25 120-5 48-27 83-60 111 12 51 19 107 15 160l-27 84H239l-20-82c-5-53 1-110 14-162-34-27-56-63-62-111-5-45 5-87 25-120Zm88 188c31-21 73-31 115-31s84 10 115 31c-27 14-56 21-86 21s-75-7-144-21Zm-20 78 67 27-67 7 53 25-62 5 70 22-77-5 72 36-94-26 61-54-23-37Zm360 0 23-37 61 54-94 26 72-36-77 5 70-22-62-5 53-25-67-7 67-27-46 74Z\"/>
  <path fill=\"#09090b\" d=\"M224 292c28-17 67-24 101-20-21 24-45 35-70 35-12 0-23-5-31-15Zm272 0c-28-17-67-24-101-20 21 24 45 35 70 35 12 0 23-5 31-15ZM333 361h54l-27 28-27-28Zm-21 55c14 16 28 23 48 23s34-7 48-23c-2 42-19 67-48 67s-46-25-48-67Z\"/>
</svg>\n""",
    encoding="utf-8",
)
