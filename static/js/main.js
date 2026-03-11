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

const bgHue = Math.floor(Math.random() * 360);
const fgHue = (bgHue + 90 + Math.floor(Math.random() * 180)) % 360;
const dark = Math.random() < 0.5;

const cols = 160, rows = Math.floor(160 * H / W);
let A = new Float32Array(cols * rows).fill(1);
let B = new Float32Array(cols * rows).fill(0);
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
const { f, k } = presets[Math.floor(Math.random() * presets.length)];
const dA = 1.0, dB = 0.5;

const numSeeds = 4 + Math.floor(Math.random() * 10);
for (let i = 0; i < numSeeds; i++) {
    const cx = Math.floor(Math.random() * cols);
    const cy = Math.floor(Math.random() * rows);
    const radius = 2 + Math.floor(Math.random() * 5);
    for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
            const idx = ((cy+dy+rows)%rows)*cols + ((cx+dx+cols)%cols);
            B[idx] = 1;
        }
}

const scaleX = W / cols, scaleY = H / rows;

function laplacian(grid, x, y) {
    const i = y*cols+x;
    return -grid[i]
        + 0.2*(grid[y*cols+((x+1)%cols)] + grid[y*cols+((x-1+cols)%cols)]
             + grid[((y+1)%rows)*cols+x] + grid[((y-1+rows)%rows)*cols+x])
        + 0.05*(grid[((y+1)%rows)*cols+((x+1)%cols)] + grid[((y+1)%rows)*cols+((x-1+cols)%cols)]
              + grid[((y-1+rows)%rows)*cols+((x+1)%cols)] + grid[((y-1+rows)%rows)*cols+((x-1+cols)%cols)]);
}

let iter = 0;
const TOTAL_ITERS = 600;

function chunk() {
    const t = Math.max(0, 1 - iter / TOTAL_ITERS);
    const stepsThisFrame = Math.max(0, Math.round(t * t * t * 8));

    for (let s = 0; s < stepsThisFrame; s++, iter++) {
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const i = y*cols+x;
                const a = A[i], b = B[i];
                const abb = a * b * b;
                nA[i] = Math.max(0, Math.min(1, a + dA * laplacian(A,x,y) - abb + f*(1-a)));
                nB[i] = Math.max(0, Math.min(1, b + dB * laplacian(B,x,y) + abb - (k+f)*b));
            }
        }
        A.set(nA); B.set(nB);
    }

    if (stepsThisFrame > 0) {
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const v = A[y*cols+x] - B[y*cols+x];
                const l = dark ? v * 80 + 10 : 90 - v * 70;
                ctx.fillStyle = `hsl(${fgHue}, 40%, ${l}%)`;
                ctx.fillRect(x*scaleX, y*scaleY, scaleX+1, scaleY+1);
            }
        }
        requestAnimationFrame(chunk);
    }
}

requestAnimationFrame(chunk);

// ── SPA navigation ─────────────────────────────────────────────────────────
// Intercept nav clicks, fetch just the new page content, and swap it in
// without reloading the page (so the background keeps running).

function setActiveNav(path) {
    /* Highlight whichever nav link matches the current path */
    document.querySelectorAll('.main-nav a').forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === path);
    });
}

async function navigateTo(path) {
    try {
        const res = await fetch(path);
        const html = await res.text();

        /* Parse the fetched page and extract just the .page-content div */
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const newContent = doc.querySelector('.page-content');

        if (newContent) {
            document.querySelector('.page-content').innerHTML = newContent.innerHTML;
        }

        /* Update the browser URL without a page reload */
        history.pushState({ path }, '', path);

        /* Update the active nav highlight */
        setActiveNav(path);

    } catch (err) {
        /* If fetch fails, fall back to a normal navigation */
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