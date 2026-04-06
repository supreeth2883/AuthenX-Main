/**
 * AuthenX Visual Code — Proprietary 2D Code System
 * ═══════════════════════════════════════════════════
 * Generates and decodes the AuthenX Visual Code format.
 * This is NOT a standard QR code — only AuthenX applications can read it.
 *
 * Encoding: AX1.xxx → binary grid → visual canvas
 * Decoding: camera/image → find finders → extract grid → AX1.xxx
 */
const AuthenXCode = (() => {
  'use strict';

  const VERSION = 1;
  const CELL_PX = 10;          // pixels per cell (default)
  const QUIET   = 4;           // quiet-zone cells per side
  const FINDER  = 7;           // finder pattern diameter in cells

  // AuthenX brand palette
  const C = {
    navy:  '#0F2044', blue:  '#1D4ED8', sky:   '#3B82F6',
    white: '#FFFFFF', bg:    '#F8FAFC', gray:  '#94A3B8',
    lite:  '#EFF6FF', dark:  '#0B1629',
  };

  /* ═══════════════════════════════════════════════════════════════════
     BASE-64-URL ↔ BYTES
     ═══════════════════════════════════════════════════════════════════ */
  function b64uToBytes(s) {
    let b = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const d = atob(b);
    const a = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) a[i] = d.charCodeAt(i);
    return a;
  }
  function bytesToB64u(a) {
    let s = '';
    for (const b of a) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  /* ═══════════════════════════════════════════════════════════════════
     CRC-16 (CCITT)
     ═══════════════════════════════════════════════════════════════════ */
  function crc16(data) {
    let c = 0xFFFF;
    for (const b of data) { c ^= b; for (let i = 0; i < 8; i++) c = (c & 1) ? (c >>> 1) ^ 0xA001 : c >>> 1; }
    return c & 0xFFFF;
  }

  /* ═══════════════════════════════════════════════════════════════════
     GRID LAYOUT — determines which cells hold data vs patterns
     ═══════════════════════════════════════════════════════════════════ */
  function gridSize(byteLen) {
    // data bytes + 1 version + 2 length + 2 CRC = overhead 5
    // With Hamming(7,4) ECC, each byte is 2 nibbles -> 2 * 7 = 14 bits
    const totalBits = (byteLen + 5) * 14;
    for (let n = 25; n <= 65; n += 2) {
      if (dataCapacity(n) >= totalBits) return n;
    }
    return 65;
  }

  /* ═══════════════════════════════════════════════════════════════════
     HAMMING(7,4) ERROR CORRECTION
     ═══════════════════════════════════════════════════════════════════ */
  function encodeHamming(nibble) {
    const d1 = (nibble >> 3) & 1, d2 = (nibble >> 2) & 1, d3 = (nibble >> 1) & 1, d4 = nibble & 1;
    const p1 = d1 ^ d2 ^ d4, p2 = d1 ^ d3 ^ d4, p3 = d2 ^ d3 ^ d4;
    return [p1, p2, d1, p3, d2, d3, d4];
  }

  function decodeHamming(b, offset) {
    let p1 = b[offset], p2 = b[offset+1], d1 = b[offset+2], p3 = b[offset+3], d2 = b[offset+4], d3 = b[offset+5], d4 = b[offset+6];
    const s1 = p1 ^ d1 ^ d2 ^ d4, s2 = p2 ^ d1 ^ d3 ^ d4, s3 = p3 ^ d2 ^ d3 ^ d4;
    const syndrome = (s3 << 2) | (s2 << 1) | s1;
    if (syndrome > 0 && syndrome <= 7) {
      const fix = [0,p1,p2,d1,p3,d2,d3,d4];
      fix[syndrome] ^= 1;
      p1 = fix[1]; p2 = fix[2]; d1 = fix[3]; p3 = fix[4]; d2 = fix[5]; d3 = fix[6]; d4 = fix[7];
    }
    return (d1 << 3) | (d2 << 2) | (d3 << 1) | d4;
  }

  function dataCapacity(n) {
    // total cells minus reserved regions
    return n * n - reservedCount(n);
  }

  function reservedCount(n) {
    const finderArea = 3 * 8 * 8;           // 3 finders (7×7 + separator)
    const timing = 2 * Math.max(0, n - 16); // h + v timing strips
    const center = 25;                      // center 5×5 alignment
    return finderArea + timing + center;
  }

  function isReserved(r, c, n) {
    // Top-left finder + separator (0..7, 0..7)
    if (r <= 7 && c <= 7) return true;
    // Top-right finder + separator
    if (r <= 7 && c >= n - 8) return true;
    // Bottom-left finder + separator
    if (r >= n - 8 && c <= 7) return true;
    // Horizontal timing (row 6, between finders)
    if (r === 6 && c > 7 && c < n - 8) return true;
    // Vertical timing (col 6, between finders)
    if (c === 6 && r > 7 && r < n - 8) return true;
    // Center alignment 5×5
    const mid = Math.floor(n / 2);
    if (Math.abs(r - mid) <= 2 && Math.abs(c - mid) <= 2) return true;
    return false;
  }

  /** Ordered list of [row, col] data cell positions */
  function dataCells(n) {
    const cells = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (!isReserved(r, c, n)) cells.push([r, c]);
    return cells;
  }

  /* ═══════════════════════════════════════════════════════════════════
     ENCODE — AX1.xxx → { grid[][], n }
     ═══════════════════════════════════════════════════════════════════ */
  function encode(axStr) {
    if (!axStr.startsWith('AX1.')) throw new Error('Invalid prefix');
    const payload = b64uToBytes(axStr.slice(4));
    const n = gridSize(payload.length);

    // Build data frame: [version(1)] [len_hi(1)] [len_lo(1)] [payload…] [crc_hi(1)] [crc_lo(1)]
    const frame = new Uint8Array(payload.length + 5);
    frame[0] = VERSION;
    frame[1] = (payload.length >> 8) & 0xFF;
    frame[2] = payload.length & 0xFF;
    frame.set(payload, 3);
    const c = crc16(frame.subarray(0, payload.length + 3));
    frame[payload.length + 3] = (c >> 8) & 0xFF;
    frame[payload.length + 4] = c & 0xFF;

    // To ECC bits (Hamming 7,4: each byte -> 2 nibbles -> 14 bits)
    const bits = [];
    for (const b of frame) {
      bits.push(...encodeHamming((b >> 4) & 0x0F));
      bits.push(...encodeHamming(b & 0x0F));
    }

    // Build grid (0 = light, 1 = dark module)
    const grid = Array.from({ length: n }, () => new Uint8Array(n));
    const cells = dataCells(n);
    for (let i = 0; i < cells.length; i++) {
      const [r, c2] = cells[i];
      grid[r][c2] = i < bits.length ? bits[i] : 0;
    }
    return { grid, n };
  }

  /* ═══════════════════════════════════════════════════════════════════
     RENDER — draw the visual code on a <canvas>
     ═══════════════════════════════════════════════════════════════════ */
  function render(canvas, axStr, opts = {}) {
    const cellPx = opts.cellSize || CELL_PX;
    const { grid, n } = encode(axStr);
    const total = (n + QUIET * 2) * cellPx;
    const brandH = Math.round(cellPx * 3.5);   // bottom branding strip
    canvas.width = total;
    canvas.height = total + brandH;
    const ctx = canvas.getContext('2d');

    // ── Background ──
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const ox = QUIET * cellPx;   // origin x (top-left of grid)
    const oy = QUIET * cellPx;   // origin y

    // ── Draw data modules ──
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (isReserved(r, c, n)) continue;
        if (grid[r][c]) {
          const x = ox + c * cellPx, y = oy + r * cellPx;
          ctx.fillStyle = C.navy;
          roundRect(ctx, x + 0.5, y + 0.5, cellPx - 1, cellPx - 1, cellPx * 0.2);
        }
      }
    }

    // ── Timing patterns ──
    for (let i = 8; i < n - 8; i++) {
      if (i % 2 === 0) {
        ctx.fillStyle = C.navy;
        roundRect(ctx, ox + i * cellPx + 0.5, oy + 6 * cellPx + 0.5, cellPx - 1, cellPx - 1, 2);
        roundRect(ctx, ox + 6 * cellPx + 0.5, oy + i * cellPx + 0.5, cellPx - 1, cellPx - 1, 2);
      }
    }

    // ── Finder patterns (concentric CIRCLES — NOT squares like QR) ──
    drawFinder(ctx, ox + 3.5 * cellPx, oy + 3.5 * cellPx, cellPx);               // TL
    drawFinder(ctx, ox + (n - 3.5) * cellPx, oy + 3.5 * cellPx, cellPx);         // TR
    drawFinder(ctx, ox + 3.5 * cellPx, oy + (n - 3.5) * cellPx, cellPx);         // BL

    // ── Center alignment pattern with AX logo ──
    const mid = Math.floor(n / 2);
    drawCenterLogo(ctx, ox + (mid + 0.5) * cellPx, oy + (mid + 0.5) * cellPx, cellPx);

    // ── Decorative border ──
    ctx.strokeStyle = C.navy;
    ctx.lineWidth = 2;
    roundRectStroke(ctx, ox - cellPx * 0.5, oy - cellPx * 0.5,
                    n * cellPx + cellPx, n * cellPx + cellPx, 8);

    // ── Branding strip ──
    const by = oy + n * cellPx + cellPx * 1.5;
    ctx.font = `bold ${Math.round(cellPx * 1.1)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = C.navy;
    ctx.textAlign = 'center';
    ctx.fillText('AuthenX', canvas.width / 2, by);
    ctx.font = `${Math.round(cellPx * 0.7)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = C.gray;
    ctx.fillText('Scan with AuthenX Verifier', canvas.width / 2, by + cellPx * 1.3);

    return { gridSize: n, canvasSize: total };
  }

  function drawFinder(ctx, cx, cy, cellPx) {
    const r = cellPx * 3.5;
    // Outer ring — navy
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = C.navy; ctx.fill();
    // Middle gap — white
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = C.white; ctx.fill();
    // Inner ring — blue
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = C.blue; ctx.fill();
    // Center dot — navy
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = C.navy; ctx.fill();
  }

  function drawCenterLogo(ctx, cx, cy, cellPx) {
    const r = cellPx * 2.2;
    // Circle background
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = C.navy; ctx.fill();
    // White ring
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
    ctx.fillStyle = C.white; ctx.fill();
    // Inner circle
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = C.navy; ctx.fill();
    // AX text
    ctx.font = `bold ${Math.round(cellPx * 1.4)}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = C.white;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('AX', cx, cy + 1);
    ctx.textBaseline = 'alphabetic';
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.fill();
  }
  function roundRectStroke(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath(); ctx.stroke();
  }

  /* ═══════════════════════════════════════════════════════════════════
     DECODE — extract AX1.xxx from an image
     ═══════════════════════════════════════════════════════════════════
     Input: a <canvas> or <img> element, or { data, width, height } ImageData
     Returns: the AX1.xxx string, or null if not detected.
     ═══════════════════════════════════════════════════════════════════ */
  function decode(source) {
    // Get pixel data
    let imgData, w, h;
    if (source instanceof HTMLCanvasElement) {
      w = source.width; h = source.height;
      imgData = source.getContext('2d').getImageData(0, 0, w, h);
    } else if (source instanceof HTMLImageElement) {
      const tc = document.createElement('canvas');
      tc.width = source.naturalWidth || source.width;
      tc.height = source.naturalHeight || source.height;
      w = tc.width; h = tc.height;
      tc.getContext('2d').drawImage(source, 0, 0);
      imgData = tc.getContext('2d').getImageData(0, 0, w, h);
    } else if (source.data && source.width) {
      imgData = source; w = source.width; h = source.height;
    } else {
      return null;
    }

    // ── Step 1: Grayscale + threshold ──
    const gray = new Uint8Array(w * h);
    const d = imgData.data;
    for (let i = 0; i < w * h; i++) {
      gray[i] = Math.round(d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114);
    }
    const thresh = otsuThreshold(gray);
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) bin[i] = gray[i] < thresh ? 1 : 0;

    // ── Step 2: Find finder patterns (concentric ring scan) ──
    const finders = findFinderPatterns(bin, w, h);
    if (finders.length < 3) return null;

    // ── Step 3: Pick best 3 finders and determine grid orientation ──
    const tri = pickTriangle(finders);
    if (!tri) return null;

    // ── Step 4: Determine grid size and cell spacing ──
    const { tl, tr, bl, cellSize: detectedCellPx, n: detectedN } = resolveGrid(tri, bin, w, h);
    if (!detectedN) return null;

    // ── Step 5: Sample data cells ──
    const bits = sampleGrid(bin, w, tl, tr, bl, detectedN, detectedCellPx);
    if (!bits) return null;

    // ── Step 6: Bits → bytes → AX1.xxx ──
    return bitsToAXString(bits, detectedN);
  }

  /* ── Otsu threshold ── */
  function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (const g of gray) hist[g]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, max = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > max) { max = between; threshold = t; }
    }
    return threshold;
  }

  /* ── Finder pattern detection via line scanning ── */
  function findFinderPatterns(bin, w, h) {
    const candidates = [];
    // Scan horizontal lines looking for dark-light-dark-light-dark pattern
    for (let y = 0; y < h; y += 2) {
      let runs = [], cur = bin[y * w], len = 1;
      for (let x = 1; x < w; x++) {
        if (bin[y * w + x] === cur) { len++; }
        else { runs.push({ val: cur, len, start: x - len }); cur = bin[y * w + x]; len = 1; }
      }
      runs.push({ val: cur, len, start: w - len });
      // Look for pattern: D-L-D-L-D with ratio ~3:1:1:1:3
      for (let i = 0; i <= runs.length - 5; i++) {
        if (runs[i].val !== 1) continue; // must start with dark
        const r = [runs[i], runs[i+1], runs[i+2], runs[i+3], runs[i+4]];
        if (r[0].val !== 1 || r[1].val !== 0 || r[2].val !== 1 || r[3].val !== 0 || r[4].val !== 1) continue;
        const unit = (r[0].len + r[1].len + r[2].len + r[3].len + r[4].len) / 9;
        if (unit < 3) continue;
        // Check ratios (3:1:1:1:3 with tolerance)
        const tol = 0.6;
        if (Math.abs(r[0].len / unit - 3) > 3 * tol) continue;
        if (Math.abs(r[1].len / unit - 1) > tol) continue;
        if (Math.abs(r[2].len / unit - 1) > tol) continue;
        if (Math.abs(r[3].len / unit - 1) > tol) continue;
        if (Math.abs(r[4].len / unit - 3) > 3 * tol) continue;
        const cx = r[0].start + (r[0].len + r[1].len + r[2].len + r[3].len + r[4].len) / 2;
        candidates.push({ x: cx, y, size: unit });
      }
    }
    // Cluster nearby candidates
    return clusterCandidates(candidates);
  }

  function clusterCandidates(pts) {
    const clusters = [];
    const used = new Set();
    for (let i = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      let sx = pts[i].x, sy = pts[i].y, ss = pts[i].size, cnt = 1;
      for (let j = i + 1; j < pts.length; j++) {
        if (used.has(j)) continue;
        const dist = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        if (dist < pts[i].size * 5) {
          sx += pts[j].x; sy += pts[j].y; ss += pts[j].size; cnt++; used.add(j);
        }
      }
      if (cnt >= 2) clusters.push({ x: sx / cnt, y: sy / cnt, size: ss / cnt, count: cnt });
      used.add(i);
    }
    // Sort by count (most votes first) and keep top 3+
    clusters.sort((a, b) => b.count - a.count);
    return clusters.slice(0, 10);
  }

  /* ── Pick 3 finders that form a right-angle triangle ── */
  function pickTriangle(finders) {
    if (finders.length < 3) return null;
    for (let i = 0; i < finders.length - 2; i++)
      for (let j = i + 1; j < finders.length - 1; j++)
        for (let k = j + 1; k < finders.length; k++) {
          const pts = [finders[i], finders[j], finders[k]];
          const tri = classifyTriangle(pts);
          if (tri) return tri;
        }
    return null;
  }

  function classifyTriangle(pts) {
    const dists = [];
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        dists.push({ i, j, d: Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) });
    dists.sort((a, b) => a.d - b.d);
    // Two shorter sides, one longer (hypotenuse)
    const [s1, s2, hyp] = dists;
    const ratio = s1.d / s2.d;
    if (ratio < 0.5 || ratio > 2.0) return null; // sides should be similar length
    // Check approximate right angle via Pythagorean theorem
    const pyth = Math.abs(s1.d * s1.d + s2.d * s2.d - hyp.d * hyp.d) / (hyp.d * hyp.d);
    if (pyth > 0.25) return null;
    // The vertex opposite the hypotenuse is the top-left corner
    const corners = new Set([0, 1, 2]);
    corners.delete(hyp.i); corners.delete(hyp.j);
    const tlIdx = [...corners][0];
    const a = hyp.i, b = hyp.j;
    // Determine TR vs BL by cross product
    const tl = pts[tlIdx];
    const cross = (pts[a].x - tl.x) * (pts[b].y - tl.y) - (pts[a].y - tl.y) * (pts[b].x - tl.x);
    return cross > 0
      ? { tl, tr: pts[a], bl: pts[b] }
      : { tl, tr: pts[b], bl: pts[a] };
  }

  /* ── Resolve grid dimensions from finder positions ── */
  function resolveGrid(tri, bin, w, h) {
    const distTR = Math.hypot(tri.tr.x - tri.tl.x, tri.tr.y - tri.tl.y);
    const distBL = Math.hypot(tri.bl.x - tri.tl.x, tri.bl.y - tri.tl.y);
    const avgDist = (distTR + distBL) / 2;
    // Finder centers are at cell (3.5, 3.5) from their grid corner
    // Distance between TL and TR finder centers ≈ (n - 7) cells
    // Try known grid sizes (all valid odd sizes)
    for (let n = 65; n >= 25; n -= 2) {
      const expectedCells = n - 7; // finder center-to-center in cells
      const cellSize = avgDist / expectedCells;
      if (cellSize > 3 && cellSize < 50) {
        return { ...tri, cellSize, n };
      }
    }
    // Fallback: estimate
    const cellSize = avgDist / 38; // assume 45 grid → 38 cells apart
    return { ...tri, cellSize, n: 45 };
  }

  /* ── Sample the grid cells from the binary image ── */
  function sampleGrid(bin, w, tl, tr, bl, n, cellPx) {
    // Compute the affine transform from grid coords to image coords
    // Grid finder centers: TL=(3.5,3.5), TR=(n-3.5,3.5), BL=(3.5,n-3.5)
    // Image coords: tl, tr, bl
    const gTL = { r: 3.5, c: 3.5 };
    const gTR = { r: 3.5, c: n - 3.5 };
    const gBL = { r: n - 3.5, c: 3.5 };

    // For each grid cell, compute image position via bilinear interpolation
    function gridToImage(gr, gc) {
      const u = (gc - gTL.c) / (gTR.c - gTL.c);
      const v = (gr - gTL.r) / (gBL.r - gTL.r);
      const x = tl.x + u * (tr.x - tl.x) + v * (bl.x - tl.x) - v * u * (tl.x) + v * u * (tl.x + tr.x + bl.x - tl.x - (tr.x - tl.x) - (bl.x - tl.x)) * 0;
      // Simplified: bilinear
      const ix = tl.x * (1 - u) * (1 - v) + tr.x * u * (1 - v) + bl.x * (1 - u) * v + (tr.x + bl.x - tl.x) * u * v;
      const iy = tl.y * (1 - u) * (1 - v) + tr.y * u * (1 - v) + bl.y * (1 - u) * v + (tr.y + bl.y - tl.y) * u * v;
      return { x: Math.round(ix), y: Math.round(iy) };
    }

    const cells = dataCells(n);
    const bits = [];
    for (const [r, c] of cells) {
      const { x, y } = gridToImage(r + 0.5, c + 0.5);
      if (x < 0 || x >= w || y < 0 || y >= Math.floor(bin.length / w)) {
        bits.push(0);
      } else {
        // Sample a small area and take majority vote
        let dark = 0, total = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const px = x + dx, py = y + dy;
            if (px >= 0 && px < w && py >= 0 && py * w + px < bin.length) {
              dark += bin[py * w + px]; total++;
            }
          }
        }
        bits.push(dark > total / 2 ? 1 : 0);
      }
    }
    return bits;
  }

  /* ── Reconstruct AX1.xxx from extracted bits ── */
  function bitsToAXString(bits, n) {
    try {
      // ECC Bits (14 bits per byte) → bytes
      const byteCount = Math.floor(bits.length / 14);
      const bytes = new Uint8Array(byteCount);
      for (let i = 0; i < byteCount; i++) {
        const off = i * 14;
        const hi = decodeHamming(bits, off);
        const lo = decodeHamming(bits, off + 7);
        bytes[i] = (hi << 4) | lo;
      }
      // Parse frame: version(1), len_hi(1), len_lo(1), payload(len), crc_hi(1), crc_lo(1)
      const ver = bytes[0];
      if (ver !== VERSION) return null;
      const payloadLen = (bytes[1] << 8) | bytes[2];
      if (payloadLen < 10 || payloadLen > bytes.length - 5) return null;
      const payload = bytes.subarray(3, 3 + payloadLen);
      const expectedCRC = (bytes[3 + payloadLen] << 8) | bytes[3 + payloadLen + 1];
      const actualCRC = crc16(bytes.subarray(0, 3 + payloadLen));
      if (expectedCRC !== actualCRC) return null;
      return 'AX1.' + bytesToB64u(payload);
    } catch (e) {
      return null;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     DECODE FROM FILE — simplified: decode from a clean image
     (for the file-upload fallback in the employer portal)
     ═══════════════════════════════════════════════════════════════════ */
  function decodeFromCleanImage(canvas) {
    // For images generated by our own render(), we know the exact layout.
    // This allows pixel-perfect decoding without finder detection.
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    // Try common cell sizes and ALL valid grid sizes (odd, 25-65)
    for (const cellPx of [10, 8, 12, 6, 14, 16, 9, 11]) {
      for (let n = 25; n <= 65; n += 2) {
        const totalExpected = (n + QUIET * 2) * cellPx;
        if (Math.abs(w - totalExpected) > 2) continue;
        // Try to decode at this size
        const result = tryDecodeKnownLayout(ctx, cellPx, n);
        if (result) return result;
      }
    }
    return null;
  }

  function tryDecodeKnownLayout(ctx, cellPx, n) {
    const ox = QUIET * cellPx;
    const oy = QUIET * cellPx;
    const cells = dataCells(n);
    const bits = [];
    for (const [r, c] of cells) {
      const px = ox + c * cellPx + Math.floor(cellPx / 2);
      const py = oy + r * cellPx + Math.floor(cellPx / 2);
      const pixel = ctx.getImageData(px, py, 1, 1).data;
      const lum = pixel[0] * 0.299 + pixel[1] * 0.587 + pixel[2] * 0.114;
      // Threshold: navy (#0F2044) has lum ~22, blue (#1D4ED8) ~55, white ~255, bg (#F8FAFC) ~250
      bits.push(lum < 80 ? 1 : 0);
    }
    return bitsToAXString(bits, n);
  }

  /* ═══════════════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════════════ */
  return {
    VERSION,
    /** Render an AuthenX Visual Code onto a canvas element */
    render,
    /** Decode from camera/image (uses finder pattern detection) */
    decode,
    /** Decode from a clean rendered image (pixel-perfect, for file upload) */
    decodeClean: decodeFromCleanImage,
    /** Encode (exposes grid data for testing) */
    _encode: encode,
  };
})();

// Export for both browser and test
if (typeof module !== 'undefined') module.exports = AuthenXCode;
