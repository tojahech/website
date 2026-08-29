// Returns { start, stop, reset, destroy, done }.
function createVineGrowth(host, userOptions) {
  const options = Object.assign(
    {
      background: "#f2f1e5",
      paper: true, // mottled paper wash + fine grain
      speed: 2.6, // px each vine advances per frame
      scale: 1, // overall size of leaves and stems
      maxActive: 12, // vines growing at the same time
      maxVines: 220, // total vines before growth stops
      coverage: 0.62, // stop once this fraction of the grid is touched
      ghostRatio: 0.42, // share of vines drawn into the faded back layer
      gravity: 0, // 0 = climbing in all directions, 1 = trailing down
      seedFrom: "edges", // 'edges' | 'top' | 'scatter'
      originX: 0.5, // where new vines enter, as a fraction of width
      spread: 1, // how far either side of originX they scatter
      keepOut: {}, // soft margins as fractions, e.g. { right: .34 }
      keepOutForce: 320, // how hard those margins push back
      maxTurn: 0.055, // radians per step — lower is more languid
      fade: {}, // edges that dissolve, e.g. { right: .4 }
      cellSize: 22,
      leafSpacing: 26, // px of stem between leaf nodes
      leafSize: 15, // px, longest leaves
      leafShape: "mixed", // 'lobed' | 'ovate' | 'mixed'
      paleLeaves: 0.22, // share of front leaves bleached out to near-white
      stem: ["#6f7f5e", "#5c6d4e", "#7b8a68", "#4f6045"],
      leaf: [
        "#7d9366",
        "#8fa678",
        "#617a4f",
        "#9fb188",
        "#728a5c",
        "#4d6340",
        "#a3a37e",
        "#8d8f66",
        "#b3bb9c",
      ],
      ghostStem: ["#c6cfb9", "#cfd6c3", "#bdc8ae"],
      ghostLeaf: ["#cbd4be", "#d6dcc9", "#c0cbb1", "#dde1d2"],
    },
    userOptions || {},
  );

  /* ---------- canvases ------------------------------------------- */

  // If the host element has static position, we will not be able to overlay the canvases below using absolute positioning
  if (getComputedStyle(host).position === "static")
    host.style.position = "relative";

  const layers = ["source-over", "multiply"].map((blend) => {
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      display: "block",
      pointerEvents: "none",
      mixBlendMode: blend,
    });
    host.appendChild(canvas);
    return { canvas, ctx: canvas.getContext("2d") };
  });
  const [{ ctx: bg }, { ctx: fg }] = layers;

  const TAU = Math.PI * 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  const EDGES = [
    { name: "top",    rampDir: "bottom", axis: "y", invert: true,
      spawn: () => ({ x: seedX(), y: -14, a: Math.PI / 2 }) },
    { name: "bottom", rampDir: "top",    axis: "y", invert: false,
      spawn: () => ({ x: seedX(), y: H + 14, a: -Math.PI / 2 }) },
    { name: "left",   rampDir: "right",  axis: "x", invert: true,
      spawn: () => ({ x: -14, y: rnd(0, H), a: 0 }) },
    { name: "right",  rampDir: "left",   axis: "x", invert: false,
      spawn: () => ({ x: W + 14, y: rnd(0, H), a: Math.PI }) },
  ];

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let W = 0,
    H = 0,
    dpr = 1;
  let grid, usable, usableCells, cols, rows, cellsTouched;
  let vines = [],
    born = 0,
    raf = null,
    running = false,
    finished = false;

  /* ---------- setup ---------------------------------------------- */
  function measure() {
    const r = host.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const { canvas, ctx } of layers) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    cols = Math.ceil(W / options.cellSize);
    rows = Math.ceil(H / options.cellSize);
    grid = new Uint16Array(cols * rows);
    cellsTouched = 0;

    // Cells inside a keep-out margin are not expected to fill, so they are
    // left out of the coverage sum — otherwise growth never reaches target.
    usable = new Uint8Array(cols * rows);
    usableCells = 0;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const open =
          edgePressure(
            (cx + 0.5) * options.cellSize,
            (cy + 0.5) * options.cellSize,
          ) < 40;
        usable[cy * cols + cx] = open ? 1 : 0;
        if (open) usableCells++;
      }
    }
    usableCells = Math.max(1, usableCells);
    applyFade();
  }

  function applyFade() {
    const f = options.fade || {};
    const ramp = (dir, amt) =>
      `linear-gradient(to ${dir}, rgba(0,0,0,0) 0%, ` +
      `rgba(0,0,0,.4) ${Math.round(amt * 45)}%, rgba(0,0,0,1) ${Math.round(amt * 100)}%)`;
    const grads = EDGES.filter(({ name }) => f[name])
      .map(({ name, rampDir }) => ramp(rampDir, f[name]));
    const value = grads.join(", ");
    for (const { canvas } of layers) {
      canvas.style.maskImage = canvas.style.webkitMaskImage = value;
      canvas.style.maskComposite = grads.length > 1 ? "intersect" : "";
      canvas.style.webkitMaskComposite = grads.length > 1 ? "source-in" : "";
    }
  }

  function paintPaper() {
    bg.save();
    bg.fillStyle = options.background;
    bg.fillRect(0, 0, W, H);
    if (options.paper) {
      // soft mottling
      for (let i = 0; i < 26; i++) {
        const x = rnd(0, W),
          y = rnd(0, H),
          r = rnd(60, Math.max(120, W * 0.35));
        const g = bg.createRadialGradient(x, y, 0, x, y, r);
        const light = Math.random() < 0.5;
        g.addColorStop(
          0,
          light ? "rgba(255,255,255,.5)" : "rgba(150,152,130,.16)",
        );
        g.addColorStop(1, "rgba(255,255,255,0)");
        bg.fillStyle = g;
        bg.fillRect(x - r, y - r, r * 2, r * 2);
      }
      // fine grain, tiled
      const n = document.createElement("canvas");
      n.width = n.height = 128;
      const nctx = n.getContext("2d");
      const img = nctx.createImageData(128, 128);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (Math.random() - 0.5) * 90;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      nctx.putImageData(img, 0, 0);
      bg.globalAlpha = 0.05;
      bg.fillStyle = bg.createPattern(n, "repeat");
      bg.fillRect(0, 0, W, H);
    }
    bg.restore();
  }

  /* ---------- occupancy grid: how the pattern learns to fill ------ */
  function mark(x, y, weight) {
    const cx = (x / options.cellSize) | 0,
      cy = (y / options.cellSize) | 0;
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
    const i = cy * cols + cx;
    if (grid[i] === 0 && usable[i]) cellsTouched++;
    grid[i] = Math.min(600, grid[i] + weight);
  }

  function edgePressure(x, y) {
    const K = options.keepOut;
    const pos = { x, y }, size = { x: W, y: H };
    let p = 0;
    for (const { name, axis, invert } of EDGES) {
      const k = K[name];
      if (!k) continue;
      const S = size[axis];
      const t = invert
        ? (S * k - pos[axis]) / (S * k)
        : (pos[axis] - S * (1 - k)) / (S * k);
      if (t > 0) p += t * t * options.keepOutForce;
    }
    return p;
  }

  function density(x, y) {
    // Outside the box counts as very crowded, so vines curl back inwards.
    const m = 12;
    if (x < -m || y < -m || x > W + m || y > H + m) return 900;
    const cx = clamp((x / options.cellSize) | 0, 0, cols - 1);
    const cy = clamp((y / options.cellSize) | 0, 0, rows - 1);
    return grid[cy * cols + cx] + edgePressure(x, y);
  }

  // Triangular distribution: seeds cluster around originX and thin out.
  function seedX() {
    const t = (Math.random() + Math.random()) / 2;
    return W * (options.originX + (t - 0.5) * options.spread);
  }

  function emptySpot() {
    let best = null,
      bestD = Infinity;
    for (let i = 0; i < 40; i++) {
      const x = seedX(),
        y = rnd(H * 0.05, H * 0.95);
      const d = density(x, y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
    return best;
  }

  const coverage = () => cellsTouched / usableCells;

  /* ---------- botany --------------------------------------------- */
  function makeVine(x, y, angle, opt) {
    const ghost = opt.ghost;
    return {
      x,
      y,
      angle,
      px: x,
      py: y,
      ghost,
      ctx: ghost ? bg : fg,
      life: 0,
      span: opt.span,
      width: opt.width,
      gen: opt.gen,
      wander: rnd(-0.02, 0.02),
      side: Math.random() < 0.5 ? 1 : -1,
      nextLeaf: rnd(6, options.leafSpacing),
      curlUntil: 0,
      curlDir: 1,
      curlAmt: 0,
      stemCol: pick(ghost ? options.ghostStem : options.stem),
      leafCol: pick(ghost ? options.ghostLeaf : options.leaf),
      leafAlt: pick(ghost ? options.ghostLeaf : options.leaf),
      alpha: ghost ? rnd(0.28, 0.5) : rnd(0.72, 0.92),
      leafScale: rnd(0.8, 1.25) * options.scale,
    };
  }

  function spawn() {
    const mode = options.seedFrom;
    const K = options.keepOut;
    let x, y, a;

    if (mode === "scatter" || (mode === "edges" && Math.random() < 0.3)) {
      const p = emptySpot();
      x = p.x;
      y = p.y;
      a = rnd(0, TAU);
    } else if (mode === "top") {
      x = seedX();
      y = rnd(-30, -4);
      a = Math.PI / 2 + rnd(-0.6, 0.6) + (x > W * options.originX ? -0.25 : 0.25);
    } else {
      const open = EDGES.filter(({ name }) => !K[name]);
      const e = pick(open.length ? open : [EDGES[0]]);
      ({ x, y, a } = e.spawn());
      a += rnd(-0.75, 0.75);
    }

    const ghost = Math.random() < options.ghostRatio;
    vines.push(
      makeVine(x, y, a, {
        ghost,
        gen: 0,
        span: rnd(320, 900) * (ghost ? 1.15 : 1),
        width: rnd(1.5, 2.6) * options.scale * (ghost ? 0.8 : 1),
      }),
    );
    born++;
  }

  function drawSimpleLeaf({ ctx, x, y, angle, len, wid, curve, colA, colB, alpha }) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, colB);
    g.addColorStop(1, colA);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.34, -wid + curve, len, curve * 0.6);
    ctx.quadraticCurveTo(len * 0.34, wid + curve, 0, 0);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.globalAlpha = alpha * 0.4;
    ctx.strokeStyle = colA;
    ctx.lineWidth = Math.max(0.4, wid * 0.1);
    ctx.beginPath();
    ctx.moveTo(len * 0.05, 0);
    ctx.quadraticCurveTo(len * 0.5, curve * 0.7, len * 0.9, curve * 0.55);
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- lobed leaves ---------------------------------------- *
   * A leaf is a run of alternating lobe tips and sinuses, measured as
   * (angle from the midrib, radius as a fraction of length). Even
   * entries are tips, odd entries are the notches between them.
   * ---------------------------------------------------------------- */
  const LOBES = {
    3: [
      [0, 1],
      [0.4, 0.46],
      [0.82, 0.7],
      [1.24, 0.34],
      [1.6, 0.25],
    ],
    5: [
      [0, 1],
      [0.26, 0.52],
      [0.56, 0.82],
      [0.88, 0.42],
      [1.18, 0.54],
      [1.52, 0.27],
    ],
  };

  function leafOutline(len, wid, lobes, jit, curve) {
    const prof = LOBES[lobes] || LOBES[3];
    const ys = wid / (0.5 * len); // how fat the blade sits on the midrib
    const right = [],
      left = [],
      tips = [];

    for (let i = 0; i < prof.length; i++) {
      for (const s of i === 0 ? [1] : [1, -1]) {
        const r = prof[i][1] * len * (1 + rnd(-jit, jit));
        const a = prof[i][0] * (1 + rnd(-jit, jit) * 1.6);
        const p = {
          x: Math.cos(a) * r,
          y: Math.sin(a) * r * ys * s + curve * (r / len),
        };
        (s === 1 ? right : left).push(p);
        if (i % 2 === 0) tips.push(p);
      }
    }
    // tip -> down one side -> leaf base -> back up the other side
    return {
      pts: right.concat([{ x: 0, y: curve * 0.15 }], left.reverse()),
      tips,
    };
  }

  // Smooth a closed polyline: each point becomes a curve control, so lobe
  // tips round off the way a wet brush leaves them.
  function tracePath(ctx, pts) {
    const n = pts.length;
    const mx = (a, b) => (a.x + b.x) / 2,
      my = (a, b) => (a.y + b.y) / 2;
    ctx.beginPath();
    ctx.moveTo(mx(pts[n - 1], pts[0]), my(pts[n - 1], pts[0]));
    for (let i = 0; i < n; i++) {
      const p = pts[i],
        q = pts[(i + 1) % n];
      ctx.quadraticCurveTo(p.x, p.y, mx(p, q), my(p, q));
    }
    ctx.closePath();
  }

  function shade(hex, f) {
    const [r, g, b] = [1, 3, 5].map((i) =>
      Math.round(parseInt(hex.slice(i, i + 2), 16) * f),
    );
    return `rgb(${r},${g},${b})`;
  }

  function drawLeaf(leaf) {
    const { ctx, x, y, angle, len, wid, curve, colA, colB, alpha } = leaf;
    if (
      options.leafShape === "ovate" ||
      (options.leafShape === "mixed" && Math.random() < 0.4) ||
      len < options.leafSize * options.scale * 0.42
    ) {
      return drawSimpleLeaf(leaf);
    }

    const lobes = Math.random() < 0.42 ? 5 : 3;
    const stalk = len * rnd(0.14, 0.26);
    const blade = len - stalk;
    const { pts, tips } = leafOutline(blade, wid, lobes, rnd(0.06, 0.16), curve);
    const dark = shade(colA, 0.72);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    ctx.globalAlpha = alpha * 0.8;
    ctx.strokeStyle = dark;
    ctx.lineWidth = Math.max(0.5, len * 0.035);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(stalk * 0.6, curve * 0.2, stalk, curve * 0.15);
    ctx.stroke();

    ctx.translate(stalk, 0);

    const g = ctx.createLinearGradient(0, -wid, blade, wid);
    g.addColorStop(0, colB);
    g.addColorStop(0.55, colA);
    g.addColorStop(1, shade(colA, 0.88));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    tracePath(ctx, pts);
    ctx.fill();

    ctx.globalAlpha = alpha * 0.3;
    ctx.strokeStyle = dark;
    ctx.lineWidth = Math.max(0.4, blade * 0.035);
    ctx.stroke();

    ctx.globalAlpha = alpha * 0.16;
    ctx.fillStyle = dark;
    ctx.save();
    ctx.translate(blade * 0.16, wid * rnd(-0.22, 0.22));
    ctx.scale(rnd(0.5, 0.72), rnd(0.5, 0.72));
    tracePath(ctx, pts);
    ctx.fill();
    ctx.restore();

    ctx.globalAlpha = alpha * 0.34;
    ctx.strokeStyle = dark;
    ctx.lineWidth = Math.max(0.35, blade * 0.022);
    ctx.beginPath();
    for (const t of tips) {
      ctx.moveTo(0, curve * 0.1);
      ctx.quadraticCurveTo(t.x * 0.45, t.y * 0.35, t.x * 0.86, t.y * 0.86);
    }
    ctx.stroke();

    ctx.restore();
  }

  function drawBuds(v, x, y, angle, size) {
    const n = 2 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const side = i % 2 ? 1 : -1;
      drawSimpleLeaf({
        ctx: v.ctx,
        x: x + Math.cos(angle) * t * size * 2.2,
        y: y + Math.sin(angle) * t * size * 2.2,
        angle: angle + side * rnd(0.5, 0.9),
        len: size * (0.42 - t * 0.12),
        wid: size * 0.18,
        curve: 0,
        colA: v.leafCol,
        colB: v.leafAlt,
        alpha: v.alpha * 0.9,
      });
    }
  }

  /* ---------- one growth step for one vine ------------------------ */
  function grow(v) {
    const t = v.life / v.span; // 0 at the root, 1 at the tip
    const taper = Math.pow(1 - t, 0.55);
    const w = Math.max(0.35, v.width * taper);

    /* steering */
    if (v.life > v.curlUntil) {
      // wander: a slowly drifting turn rate gives long, calm arcs
      v.wander = clamp(v.wander * 0.985 + rnd(-0.007, 0.007), -0.05, 0.05);

      // look ahead three ways and lean towards open space
      const look = 58;
      const d = (off) =>
        density(
          v.x + Math.cos(v.angle + off) * look,
          v.y + Math.sin(v.angle + off) * look,
        );
      const wL = 1 / (1 + d(-0.6)),
        wC = 1.7 / (1 + d(0)),
        wR = 1 / (1 + d(0.6));
      const seek = (-0.6 * wL + 0.6 * wR) / (wL + wC + wR);

      // A cap on turn rate is what keeps avoidance looking like a stem
      // sweeping around rather than snapping back on itself.
      v.angle += clamp(
        v.wander + seek * 0.4,
        -options.maxTurn,
        options.maxTurn,
      );

      if (options.gravity) {
        // optional trailing/hanging bias
        let diff = ((Math.PI / 2 - v.angle + Math.PI * 3) % TAU) - Math.PI;
        v.angle += diff * 0.012 * options.gravity;
      }

      // now and then the stem throws a tendril curl
      if (Math.random() < 0.006 && t < 0.8 && edgePressure(v.x, v.y) < 20) {
        v.curlUntil = v.life + rnd(50, 130);
        v.curlDir = Math.random() < 0.5 ? 1 : -1;
        v.curlAmt = rnd(0.022, 0.05);
      }
    } else if (edgePressure(v.x, v.y) > 30) {
      v.curlUntil = 0; // a curl still yields to a margin
    } else {
      v.angle += v.curlDir * v.curlAmt;
    }

    /* advance */
    v.px = v.x;
    v.py = v.y;
    v.x += Math.cos(v.angle) * options.speed;
    v.y += Math.sin(v.angle) * options.speed;
    v.life += options.speed;

    /* stem */
    const ctx = v.ctx;
    ctx.globalAlpha = v.alpha * (v.ghost ? 1 : 0.95);
    ctx.strokeStyle = v.stemCol;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(v.px, v.py);
    ctx.lineTo(v.x, v.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    mark(v.x, v.y, 3);

    /* foliage */
    if (v.life >= v.nextLeaf) {
      const size = options.leafSize * v.leafScale * (0.45 + taper * 0.75);

      if (Math.random() < 0.24) {
        drawBuds(v, v.x, v.y, v.angle + v.side * rnd(0.4, 0.8), size);
      } else {
        const paired = Math.random() < 0.42;
        const sides = paired ? [1, -1] : [v.side];
        for (const s of sides) {
          const len = size * rnd(0.8, 1.15);
          const pale = !v.ghost && Math.random() < options.paleLeaves;
          drawLeaf({
            ctx: v.ctx, x: v.x, y: v.y,
            angle: v.angle + s * rnd(0.6, 1.15),
            len,
            wid: len * rnd(0.44, 0.6),
            curve: len * s * 0.12,
            colA: pale ? pick(options.ghostLeaf) : v.leafCol,
            colB: pale ? pick(options.ghostLeaf) : v.leafAlt,
            alpha: pale ? v.alpha * 0.75 : v.alpha,
          });
        }
      }
      mark(v.x, v.y, 6);
      v.side *= -1;
      v.nextLeaf =
        v.life + options.leafSpacing * options.scale * rnd(0.65, 1.4);
    }

    /* branch */
    if (v.gen < 3 && t > 0.12 && t < 0.82 && Math.random() < 0.014) {
      vines.push(
        makeVine(
          v.x,
          v.y,
          v.angle + (Math.random() < 0.5 ? 1 : -1) * rnd(0.5, 1.0),
          {
            ghost: v.ghost,
            gen: v.gen + 1,
            span: v.span * rnd(0.3, 0.6),
            width: w * 0.75,
          },
        ),
      );
    }

    /* death — the tip finishes in a cluster of new growth */
    const gone = v.x < -60 || v.y < -60 || v.x > W + 60 || v.y > H + 60;
    if (v.life >= v.span || gone) {
      if (!gone)
        drawBuds(v, v.x, v.y, v.angle, options.leafSize * v.leafScale * 0.8);
      return false;
    }
    return true;
  }

  /* ---------- loop ------------------------------------------------ */
  function tick() {
    for (let i = vines.length - 1; i >= 0; i--) {
      if (!grow(vines[i])) vines.splice(i, 1);
    }
    const roomToGrow = coverage() < options.coverage && born < options.maxVines;
    if (roomToGrow && vines.length < options.maxActive) spawn();
    if (!roomToGrow && vines.length === 0) finished = true;
  }

  function frame() {
    const steps = reduceMotion ? 400 : 1;
    for (let i = 0; i < steps && !finished; i++) tick();
    if (finished) {
      running = false;
      raf = null;
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  /* ---------- api -------------------------------------------------- */
  function reset() {
    stop();
    measure();
    paintPaper();
    fg.clearRect(0, 0, W, H);
    vines = [];
    born = 0;
    finished = false;
    for (let i = 0; i < Math.min(4, options.maxActive); i++) spawn();
  }

  function start() {
    if (running || finished) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  let resizeTimer;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      reset();
      start();
    }, 200);
  });
  ro.observe(host);

  function destroy() {
    stop();
    ro.disconnect();
    layers.forEach(({ canvas }) => canvas.remove());
  }

  reset();
  start();

  return {
    start,
    stop,
    reset,
    destroy,
    get done() {
      return finished;
    },
  };
}

/* ------------------------------------------------------------------ */

const host = document.getElementsByClassName("sidebar")[0];
const tall = matchMedia("(min-width: 761px)");
let garden = null;

// A curtain falling down the rail reads well when it's tall and narrow;
// in the short band on small screens it just drains off the bottom, so
// seed from the edges instead.
function plant() {
  if (garden) garden.destroy();
  garden = createVineGrowth(
    host,
    tall.matches
      ? {
          background: "#eef0e2",
          seedFrom: "edges",
          // gravity: 0.7,
          scale: 0.82,
          speed: 2.2,
          maxActive: 8,
          maxVines: 160,
          coverage: 0.58,
          ghostRatio: 0.46,
          originX: 0.4,
          spread: 0.5, // enter near the middle of the rail
          keepOut: { right: 0.4, left: 0.05 }, // lean away from the text
          fade: { right: 0.4 },
        } // and dissolve over the same zone
      : {
          background: "#eef0e2",
          seedFrom: "edges",
          gravity: 0.2,
          scale: 0.7,
          speed: 2.6,
          maxActive: 10,
          maxVines: 120,
          coverage: 0.5,
          ghostRatio: 0.46,
          originX: 0.5,
          spread: 0.8,
          keepOut: { bottom: 0.32 },
          fade: { bottom: 0.32 },
        },
  );
}

// Draw the garden on page load
// Re-draw whenever the host div changes size

plant();
tall.addEventListener("change", plant);
