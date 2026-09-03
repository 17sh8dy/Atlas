# Atlas — Needle Mark Specification

## Canonical geometry

The Atlas mark is a diamond (rotated square) with a **5:6 width-to-height ratio**, split vertically at centre. The right half is solid fill; the left half is outline only. All corner joins are **round** (`stroke-linejoin: round`).

```
        Top
        /|\
       / | \
      /  |  \
Left ·   |   · Right     ← vertical centre split
      \  |  /
       \ | /
        \|/
       Bottom

Left half: outline stroke, transparent fill
Right half: solid fill, matching stroke color
```

### Master dimensions (512 × 512 artboard)

| Property         | Value                          |
|------------------|--------------------------------|
| Artboard         | 512 × 512 px                   |
| Safe margin      | 64 px (content: 64–448)        |
| Diamond centre   | (256, 256)                     |
| Half-width       | 160 px                         |
| Half-height      | 192 px                         |
| Width : Height   | 320 : 384 = 5 : 6             |
| Stroke width     | 12 px                          |
| Corner joins     | Round                          |

Diamond vertices at master scale:

- **Top:** (256, 64)
- **Right:** (416, 256)
- **Bottom:** (256, 448)
- **Left:** (96, 256)

---

## Size-specific adaptations

Stroke weight increases as a percentage of icon size at smaller renders. Below 32 px the diamond ratio shifts toward 1:1 (square) to prevent the mark from reading as a thin sliver.

| Icon size | Stroke (px) | Stroke % | Ratio (w:h) | Notes                        |
|-----------|-------------|----------|-------------|------------------------------|
| 64 px     | 3.0         | 4.7 %    | 5:6         | Full canonical geometry      |
| 48 px     | 2.5         | 5.2 %    | 5:6         | Slight weight bump           |
| 32 px     | 2.0         | 6.3 %    | ~1:1        | Widened toward square        |
| 24 px     | 1.8         | 7.5 %    | 1:1         | Square ratio                 |
| 20 px     | 1.5         | 7.5 %    | 1:1         | Square ratio                 |
| 16 px     | 1.2         | 7.5 %    | 1:1         | Floor size, maximum weight   |

---

## Minimum sizes

- **Minimum icon size:** 16 × 16 px (favicon, system tray)
- **Minimum lockup width:** 96 px (horizontal), 48 px mark width (vertical)
- **Below 16 px:** do not use the mark; use a solid diamond silhouette instead

---

## Clear space

Minimum clear space around the mark equals the **half-width of the diamond** at any given size. For the master (512 px), that is 160 px. For a 64 px icon, that is ~22 px. The icon tile variants already include this space within the rounded-rect background.

---

## Color

### Primary (dark neutral tile)

| Element        | Hex       |
|----------------|-----------|
| Tile fill      | `#2C2C2A` |
| Mark stroke    | `#F1EFE8` |
| Mark fill      | `#F1EFE8` |
| Tile radius    | ~22% of tile size |

### On light backgrounds

| Element        | Hex       |
|----------------|-----------|
| Mark stroke    | `#2C2C2A` |
| Mark fill      | `#2C2C2A` |

### On dark backgrounds

| Element        | Hex       |
|----------------|-----------|
| Mark stroke    | `#F1EFE8` |
| Mark fill      | `#F1EFE8` |

### Inactive / monochrome

Same as light or dark version, but the **filled half uses 35% opacity** instead of solid. Use for toolbar icons, disabled states, or anywhere the full-contrast mark is too heavy.

---

## File inventory

| File                         | Purpose                                      |
|------------------------------|----------------------------------------------|
| `atlas-master-512.svg`       | Production master, 512 × 512                 |
| `atlas-mark.svg`             | Standalone mark, no background, scalable     |
| `atlas-icon-64.svg`          | App icon, 64 px, dark tile                   |
| `atlas-icon-48.svg`          | App icon, 48 px, dark tile                   |
| `atlas-icon-32.svg`          | App icon, 32 px, dark tile                   |
| `atlas-icon-24.svg`          | App icon, 24 px, dark tile                   |
| `atlas-icon-20.svg`          | App icon, 20 px, dark tile                   |
| `atlas-icon-16.svg`          | App icon, 16 px, dark tile (favicon floor)   |
| `atlas-lockup-h.svg`         | Horizontal lockup, mark + "Atlas"            |
| `atlas-lockup-v.svg`         | Vertical lockup, mark over "Atlas"           |
| `atlas-on-light.svg`         | Mark on light background                     |
| `atlas-on-dark.svg`          | Mark on dark background                      |
| `atlas-mono-inactive.svg`    | Reduced-opacity fill for inactive states     |

---

## Which variant to use

| Context                                  | File                     |
|------------------------------------------|--------------------------|
| macOS / Windows / Linux app icon         | `atlas-icon-{size}.svg`  |
| System tray / menu bar                   | `atlas-icon-16.svg` or `atlas-icon-20.svg` |
| Favicon                                  | `atlas-icon-16.svg`      |
| Splash screen / about dialog             | `atlas-master-512.svg` or `atlas-lockup-v.svg` |
| Website header / nav bar                 | `atlas-lockup-h.svg`     |
| Marketing / print                        | `atlas-master-512.svg`   |
| Toolbar icon / sidebar toggle            | `atlas-mono-inactive.svg`|
| Dark UI chrome                           | `atlas-on-dark.svg`      |
| Light UI chrome                          | `atlas-on-light.svg`     |
| Tauri `tauri icon` input (generates .ico/.icns) | Export `atlas-master-512.svg` to 1024 × 1024 PNG |

---

## Generating platform icons from the master

```bash
# Export master to 1024px PNG (e.g. with Inkscape or rsvg-convert)
rsvg-convert -w 1024 -h 1024 atlas-master-512.svg > atlas-1024.png

# Tauri generates .ico, .icns, and all platform sizes from a single PNG
npx tauri icon atlas-1024.png
```

For pixel-perfect results at 16–32 px, use the size-specific SVGs rather than downscaling the master — they have optical corrections that downscaling cannot reproduce.
