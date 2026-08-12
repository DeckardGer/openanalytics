# Brand kit

These files are **generated from the mark's geometry in
`components/landing/logo.tsx`** — `BAND_TOPS`, `BAND_HEIGHT`, `BASE_TOP` and
`RING_PATH`. They are not drawn by hand and should not be edited in place.

That is not a style preference. The previous kit was an Illustrator export of a
hand-traced mark, and when the mark was redrawn in 2026-08 the kit was left
behind: the landing page's dithered logo and every "download our logo" link
went on serving the retired mark. Deriving the kit from the component is what
makes that impossible — change the constants, regenerate, and the vector, the
raster and the rendered logo are the same shape by construction.

## Contents

| File | What it is |
|---|---|
| `logo.svg` | The mark with no `fill` — inherits its colour from context. |
| `logo-primary.svg` | The mark in brand blue, `#296FF0`. |
| `logo-primary.png` | 1024×1024, brand blue, transparent gaps. |
| `logo-white.png` | 1024×1024, white, transparent gaps. |

**The gaps between the bands are transparent, not white.** The landing page's
`DitheredLogo` samples `logo-primary.png` and skips any pixel under 128 alpha;
a white-filled gap would survive that test and the blur pass would smear it
into an edge that grows particles. Any regenerated raster must keep alpha.

`/og-open.png` (1200×630) ships in the downloadable zip but is not generated
here — it is a designed card, not the mark.

## Regenerating

The vectors come from the constants; the rasters come from the vectors.
`rsvg-convert` is from `librsvg` (`brew install librsvg`).

```sh
rsvg-convert -w 1024 -h 1024 logo-primary.svg -o logo-primary.png
# logo-white.png is the same file with fill="#FFFFFF"
```

Then rebuild the public bundle, which is what the header's logo menu hands out:

```sh
cd apps/web/public
zip -j brand-assets.zip \
  brand-logos/logo.svg brand-logos/logo-primary.svg \
  brand-logos/logo-primary.png brand-logos/logo-white.png \
  og-open.png
```
