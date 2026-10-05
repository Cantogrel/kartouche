"""Génère l'icône de Kartouche (build/icon.ico + build/icon.png) : cartouche de jeu en vue isométrique sur fond violet.

Usage : python tools/make-icon.py   (nécessite Pillow : pip install pillow)
"""
import os
from PIL import Image, ImageDraw, ImageChops

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build')
S = 4096
F = S / 1024  # tout est dessiné en 4096 px puis réduit à 1024 px (anticrénelage)


def pts(points):
    return [(x * F, y * F) for x, y in points]


def background():
    """Carré arrondi, dégradé violet (haut-gauche clair, bas-droite sombre), coins transparents."""
    light, dark = Image.new('RGB', (S, S), (96, 80, 205)), Image.new('RGB', (S, S), (34, 28, 84))
    vertical = Image.composite(dark, light, Image.linear_gradient('L').resize((S, S)))
    horizontal = Image.composite(dark, light, Image.linear_gradient('L').rotate(90).resize((S, S)))
    gradient = Image.blend(vertical, horizontal, 0.5)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(230 * F), fill=255)
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img.paste(gradient, (0, 0), mask)
    return img, mask


def cartridge():
    """Cartouche isométrique sur un calque transparent (le recadrage sur son contenu la centre ensuite)."""
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    scale = 430
    u, v = (0.866 * scale, 0.5 * scale), (0, scale * 1.3)
    origin = (150, 200)
    depth = (150 * 0.866, -150 * 0.5)

    def at(x, y):
        return (origin[0] + u[0] * x + v[0] * y, origin[1] + u[1] * x + v[1] * y)

    def shifted(p):
        return (p[0] + depth[0], p[1] + depth[1])

    outline = [(0, 0.14), (0.14, 0), (0.86, 0), (1, 0.14), (1, 1), (0, 1)]
    a, b = at(1, 0.14), at(1, 1)
    t0, t1 = at(0.14, 0), at(0.86, 0)
    d.polygon(pts([t0, t1, shifted(t1), shifted(t0)]), fill=(255, 255, 255))      # dessus
    d.polygon(pts([t1, a, shifted(a), shifted(t1)]), fill=(226, 220, 255))        # chanfrein
    d.polygon(pts([a, b, shifted(b), shifted(a)]), fill=(150, 136, 230))          # côté
    d.polygon(pts([at(*p) for p in outline]), fill=(240, 237, 255))               # face
    face = lambda poly, fill: d.polygon(pts([at(x, y) for x, y in poly]), fill=fill)
    face([(0.12, 0.2), (0.88, 0.2), (0.88, 0.66), (0.12, 0.66)], (62, 50, 150))   # étiquette
    face([(0.42, 0.3), (0.42, 0.56), (0.66, 0.43)], (255, 255, 255))             # triangle de lecture
    face([(0.3, 0.86), (0.7, 0.86), (0.7, 1.0), (0.3, 1.0)], (52, 42, 122))       # encoche du connecteur
    return layer


def main():
    img, mask = background()
    layer = cartridge()
    box = layer.getbbox()
    w, h = box[2] - box[0], box[3] - box[1]
    k = 640 * F / max(w, h)
    motif = layer.crop(box).resize((int(w * k), int(h * k)), Image.LANCZOS)
    img.alpha_composite(motif, ((S - motif.width) // 2, (S - motif.height) // 2))
    img.putalpha(ImageChops.multiply(img.getchannel('A'), mask))
    final = img.resize((1024, 1024), Image.LANCZOS)
    final.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, 'icon.png'))
    final.save(os.path.join(ROOT, 'icon.ico'), sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])


if __name__ == '__main__':
    main()
