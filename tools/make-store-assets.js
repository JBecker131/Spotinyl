import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { decodePng, encodePng } from './make-icons.js';

// The store accepts these two sizes and nothing else, so a capture taken at a
// device pixel ratio above 1 has to come back down to one of them exactly.
export const STORE_SCREENSHOT = { width: 1280, height: 800 };

// The listing icon is uploaded to the dashboard separately from the package,
// so it is built here alongside the screenshot rather than left to the icon set
// the extension itself ships.
export const STORE_ICON = { width: 128, height: 128 };

/**
 * Centre-crops the source to the output's aspect ratio, then box-filters it
 * down to exactly outWidth x outHeight.
 *
 * Cropping first rather than stretching keeps the artwork's proportions: a
 * 1918x1198 capture is a hair off 16:10, and stretching it to fit would skew
 * every circle on a page whose subject is a record.
 */
export function resizeTo(source, width, height, outWidth, outHeight) {
  // The largest region of the source that matches the output's aspect ratio.
  const scale = Math.min(width / outWidth, height / outHeight);
  const cropW = outWidth * scale;
  const cropH = outHeight * scale;
  const left = (width - cropW) / 2;
  const top = (height - cropH) / 2;

  const px = new Uint8Array(outWidth * outHeight * 4);

  for (let y = 0; y < outHeight; y++) {
    const y0 = Math.floor(top + (y * cropH) / outHeight);
    const y1 = Math.max(y0 + 1, Math.floor(top + ((y + 1) * cropH) / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const x0 = Math.floor(left + (x * cropW) / outWidth);
      const x1 = Math.max(x0 + 1, Math.floor(left + ((x + 1) * cropW) / outWidth));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < height; sy++) {
        for (let sx = x0; sx < x1 && sx < width; sx++) {
          const i = (sy * width + sx) * 4;
          const alpha = source[i + 3] / 255;
          r += source[i] * alpha; // weight colour by coverage so edges don't halo
          g += source[i + 1] * alpha;
          b += source[i + 2] * alpha;
          a += source[i + 3];
          n++;
        }
      }

      const i = (y * outWidth + x) * 4;
      const coverage = n ? a / (n * 255) : 0;
      px[i] = coverage ? Math.round(r / n / coverage) : 0;
      px[i + 1] = coverage ? Math.round(g / n / coverage) : 0;
      px[i + 2] = coverage ? Math.round(b / n / coverage) : 0;
      px[i + 3] = n ? Math.round(a / n) : 0;
    }
  }
  return px;
}

// Running this file directly rebuilds the listing images from assets/.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = join(root, 'dist', 'store');
  mkdirSync(outDir, { recursive: true });

  // The capture embeds third-party album art, so it is kept out of git. Say so
  // plainly rather than failing with a bare ENOENT on a fresh clone.
  const source = join(root, 'assets', 'Spotinyl Cover.png');
  let shot;
  try {
    shot = decodePng(readFileSync(source));
  } catch {
    console.error(`Missing ${relative(root, source)}.`);
    console.error('Capture dev/store-shot.html at 1280x800 and save it there, then re-run.');
    process.exit(1);
  }
  const { width, height } = STORE_SCREENSHOT;
  const px = resizeTo(shot.rgba, shot.width, shot.height, width, height);
  const out = join(outDir, `screenshot-${width}x${height}.png`);
  writeFileSync(out, encodePng(width, height, px));

  console.log(`read  ${relative(root, source)} (${shot.width}x${shot.height})`);
  console.log(`wrote ${relative(root, out)} (${width}x${height})`);

  const logoPath = join(root, 'assets', 'spotinyl-logo.png');
  const logo = decodePng(readFileSync(logoPath));
  const icon = STORE_ICON;
  const iconPx = resizeTo(logo.rgba, logo.width, logo.height, icon.width, icon.height);
  const iconOut = join(outDir, `icon-${icon.width}x${icon.height}.png`);
  writeFileSync(iconOut, encodePng(icon.width, icon.height, iconPx));

  console.log(`read  ${relative(root, logoPath)} (${logo.width}x${logo.height})`);
  console.log(`wrote ${relative(root, iconOut)} (${icon.width}x${icon.height})`);
}
