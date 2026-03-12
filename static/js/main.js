// ── Seeded RNG (mulberry32) ────────────────────────────────────────────────

function mulberry32(seed) {
    return function() {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Simple string hash → integer seed
function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// Per-page seeds — change any number to get a completely different look for that page
const PAGE_SEEDS = {
    '/projects': 1111,
    '/media':    2002,
    '/blog':     3000,
    '/dreams':   5505,
    '/misc':     6661,
    '/about':    5665,
};

function randForPath(path) {
    if (path === '/' || path === '') return () => Math.random();
    const seed = PAGE_SEEDS[path] ?? hashString(path);
    return mulberry32(seed);
}

// ── Background: reaction-diffusion ────────────────────────────────────────

const canvas = document.createElement('canvas');
canvas.style.position = 'fixed';
canvas.style.top = '0'; canvas.style.left = '0';
canvas.style.width = '100%'; canvas.style.height = '100%';
canvas.style.zIndex = '-1';
document.body.prepend(canvas);

const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
const W = canvas.width, H = canvas.height;

const cols = 160, rows = Math.floor(160 * H / W);
const nA = new Float32Array(cols * rows);
const nB = new Float32Array(cols * rows);

const presets = [
    { f: 0.037, k: 0.060 },
    { f: 0.030, k: 0.057 },
    { f: 0.025, k: 0.052 },
    { f: 0.039, k: 0.058 },
    { f: 0.055, k: 0.062 },
    { f: 0.012, k: 0.050 },
];

const scaleX = W / cols, scaleY = H / rows;
const dA = 1.0, dB = 0.5;
const TOTAL_ITERS = 600;

// Generation counter — incrementing this cancels any in-flight animation loop
let generation = 0;

// Mutable sim state, re-initialised on each navigation
let A, B, fgHue, dark, f, k, iter;

function laplacian(grid, x, y) {
    const i = y * cols + x;
    return -grid[i]
        + 0.2 * (grid[y * cols + ((x + 1) % cols)]        + grid[y * cols + ((x - 1 + cols) % cols)]
               + grid[((y + 1) % rows) * cols + x]         + grid[((y - 1 + rows) % rows) * cols + x])
        + 0.05 * (grid[((y + 1) % rows) * cols + ((x + 1) % cols)]        + grid[((y + 1) % rows) * cols + ((x - 1 + cols) % cols)]
                + grid[((y - 1 + rows) % rows) * cols + ((x + 1) % cols)]  + grid[((y - 1 + rows) % rows) * cols + ((x - 1 + cols) % cols)]);
}

function startSimulation(path) {
    const myGen = ++generation;   // old rAF loops check this and bail when stale
    const rand  = randForPath(path);

    // Derive all visual params from the seeded (or truly random) source
    const bgHue_ = Math.floor(rand() * 360);
    fgHue        = (bgHue_ + 90 + Math.floor(rand() * 180)) % 360;
    dark         = rand() < 0.5;
    const preset = presets[Math.floor(rand() * presets.length)];
    f = preset.f;
    k = preset.k;

    // Reset grids
    A = new Float32Array(cols * rows).fill(1);
    B = new Float32Array(cols * rows).fill(0);

    // Place seed blobs
    const numSeeds = 4 + Math.floor(rand() * 10);
    for (let i = 0; i < numSeeds; i++) {
        const cx_    = Math.floor(rand() * cols);
        const cy_    = Math.floor(rand() * rows);
        const radius = 2 + Math.floor(rand() * 5);
        for (let dy = -radius; dy <= radius; dy++)
            for (let dx = -radius; dx <= radius; dx++) {
                const idx = ((cy_ + dy + rows) % rows) * cols + ((cx_ + dx + cols) % cols);
                B[idx] = 1;
            }
    }

    iter = 0;

    function chunk() {
        if (generation !== myGen) return;   // a newer simulation started — stop

        const t = Math.max(0, 1 - iter / TOTAL_ITERS);
        const stepsThisFrame = Math.max(0, Math.round(t * t * t * 8));

        for (let s = 0; s < stepsThisFrame; s++, iter++) {
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    const i   = y * cols + x;
                    const a   = A[i], b = B[i];
                    const abb = a * b * b;
                    nA[i] = Math.max(0, Math.min(1, a + dA * laplacian(A, x, y) - abb + f * (1 - a)));
                    nB[i] = Math.max(0, Math.min(1, b + dB * laplacian(B, x, y) + abb - (k + f) * b));
                }
            }
            A.set(nA); B.set(nB);
        }

        if (stepsThisFrame > 0) {
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    const v = A[y * cols + x] - B[y * cols + x];
                    const l = dark ? v * 80 + 10 : 90 - v * 70;
                    ctx.fillStyle = `hsl(${fgHue}, 40%, ${l}%)`;
                    ctx.fillRect(x * scaleX, y * scaleY, scaleX + 1, scaleY + 1);
                }
            }
            requestAnimationFrame(chunk);
        }
    }

    requestAnimationFrame(chunk);
}

// Kick off the initial background (random on "/", seeded on direct deep-links)
startSimulation(window.location.pathname);

// ── SPA navigation ─────────────────────────────────────────────────────────

function setActiveNav(path) {
    document.querySelectorAll('.main-nav a').forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === path);
    });
}

async function navigateTo(path) {
    try {
        const res = await fetch(path);
        const html = await res.text();

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const newContent = doc.querySelector('.page-content');

        if (newContent) {
            document.querySelector('.page-content').innerHTML = newContent.innerHTML;
        }

        history.pushState({ path }, '', path);
        setActiveNav(path);

        // Restart the sim — seeded for named pages, random for home
        startSimulation(path);

    } catch (err) {
        window.location.href = path;
    }
}

/* Intercept all nav link clicks */
document.querySelector('.main-nav').addEventListener('click', e => {
    const link = e.target.closest('a');
    if (!link) return;

    const href = link.getAttribute('href');

    /* Let external links and photoglobe (full page takeover) navigate normally */
    if (!href || href.startsWith('http') || href.startsWith('/photoglobe')) return;

    e.preventDefault();
    navigateTo(href);
});

/* Handle browser back/forward buttons */
window.addEventListener('popstate', e => {
    if (e.state?.path) navigateTo(e.state.path);
});

/* Set the correct active link on first load */
setActiveNav(window.location.pathname);