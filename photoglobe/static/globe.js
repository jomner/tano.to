// WebGL canvas for globe rendering
const glCanvas = document.getElementById('globe-webgl');
glCanvas.width = window.innerWidth;
glCanvas.height = window.innerHeight;
const gl = glCanvas.getContext('webgl');

// 2D canvas for pins, tooltips, grid lines — sits on top
const canvas = document.getElementById('globe');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

// Center and radius based on screen size
let cx = canvas.width / 2;
let cy = canvas.height / 2;
let R = Math.min(canvas.width, canvas.height) * 0.44;

// Horizontal rotation
let rotY = 0;

// Vertical rotation
let rotX = 0;

// Load earth texture
const earthTexture = new Image();
earthTexture.src = '/photoglobe/static/assets/Earth/8k_earth_daymap.jpg';

// Load night, cloud, and specular textures
const nightTexture = new Image();
nightTexture.src = '/photoglobe/static/assets/Earth/8k_earth_nightmap.jpg';

const cloudTexture = new Image();
cloudTexture.src = '/photoglobe/static/assets/Earth/2k_earth_clouds.jpg';

const specularTexture = new Image();
specularTexture.src = '/photoglobe/static/assets/Earth/2k_earth_specular_map.webp';

const normalTexture = new Image();
normalTexture.src = '/photoglobe/static/assets/Earth/2k_earth_normal_map.webp';

// Zoom level — 1 is default, higher is more zoomed in
let zoom = 1;

// Maxium zoom
// Maximum zoom (scroll/manual)
const MAX_ZOOM = 15;

// Maximum zoom triggered by clicking a pin or cluster
const MAX_CLICK_ZOOM = 3;

// Track whether the mouse is being dragged
let dragging = false;
// Track where the mouse was last frame
let lastMX = 0;
let lastMY = 0;
// Track current mouse position on screen
let mouseX = 0;
let mouseY = 0;

// Name hovering variable
anyHovered = false;

// Track when the user last interacted with the globe
let lastInteraction = 0;

// Target zoom for smooth animation
let targetZoom = 1;

// Target rotation for smooth centering animation
let targetRotY = null;
let targetRotX = null;

// Cache for loaded thumbnail images, keyed by filename
const thumbnailCache = {};

// Random tilt per pin, generated once and stored by filename
const pinTilts = {};

// Cache which pin represents each cluster, keyed by a stable cluster key
const clusterRepCache = {};

// Store last drawn clusters so click listener uses same data as draw
let lastClusters = [];

// Zoom target specifically for breaking a clicked cluster
let zoomAnimStart = null;
let zoomAnimFrom = null;
let zoomAnimTo = null;
let zoomAnimDuration = null;

// Whether we're in a slow-ease zoom (pin/cluster click) or fast zoom (scroll)
let slowZoom = false;

// Track fading pins that just got absorbed into a cluster
const fadingPins = [];

// Track when each pin/cluster first appeared, keyed by stable cluster key
const appearTimes = {};
const APPEAR_DURATION = 350;

// Convert a lat/lng into a 3D point on a sphere of radius r
function latLngTo3D(lat, lng, r) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lng + 180) * Math.PI / 180;
    return {
        x: -r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.cos(phi),
        z: r * Math.sin(phi) * Math.sin(theta)
    };
}

// Rotate a 3D point by both rotX and rotY
function rotate(p) {
    // 1. Rotate Longitude (Y-axis)
    const cosRY = Math.cos(rotY), sinRY = Math.sin(rotY);
    const x1 = p.x * cosRY + p.z * sinRY;
    const z1 = -p.x * sinRY + p.z * cosRY;

    // 2. Rotate Latitude (X-axis)
    const cosRX = Math.cos(rotX), sinRX = Math.sin(rotX);
    const y2 = p.y * cosRX - z1 * sinRX;
    const z2 = p.y * sinRX + z1 * cosRX;

    return { x: x1, y: y2, z: z2 };
}

// Flatten a 3D point onto the 2D canvas
function project(p) {
    return {
        x: cx + p.x,
        y: cy - p.y,
        z: p.z
    };
}

// Start with empty pins array — filled from pins.json via Flask
let PINS = [];

// Folder picker
const folderSelect = document.getElementById('folder-select');

function loadPins(folder) {
    const url = folder
        ? '/photoglobe/pins?folder=' + encodeURIComponent(folder)
        : '/photoglobe/pins';
    fetch(url)
        .then(r => r.json())
        .then(data => {
            PINS = data;
            // Clear appear times so new pins animate in
            for (const key in appearTimes) delete appearTimes[key];
            // Close panel if open
            panel.classList.remove('open');
        });
}

// Populate folder dropdown then load all pins
fetch('/photoglobe/folders')
    .then(r => r.json())
    .then(folders => {
        folders.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            folderSelect.appendChild(opt);
        });
    })
    .catch(() => {});

loadPins('');

folderSelect.addEventListener('change', () => {
    loadPins(folderSelect.value);
});

// Grab the tooltip element
const tooltip = document.getElementById('tooltip');

// Grab the panel elements
const panel = document.getElementById('panel');
const panelName = document.getElementById('panel-name');
const panelCoords = document.getElementById('panel-coords');
const panelDesc = document.getElementById('panel-desc');
const panelImg = document.getElementById('panel-img');
const panelGrid = document.getElementById('panel-grid');
const closeBtn = document.getElementById('close-btn');

// Track cluster state for back navigation
let currentClusterPins = null;
let viewingSingleInCluster = false;

// Close/back button — context-sensitive
closeBtn.addEventListener('click', () => {
    if (viewingSingleInCluster && currentClusterPins) {
        // Back to cluster grid
        const pins = currentClusterPins;
        panelName.textContent = `${pins[0].name.split(',')[0]} [${pins.length}]`;
        updatePanelCoords(null);
        panelDesc.textContent = '';
        panelImg.style.display = 'none';
        panelGrid.innerHTML = '';
        panelGrid.classList.add('visible');
        viewingSingleInCluster = false;
        closeBtn.textContent = '✕';
        pins.forEach(pin => {
            const img = document.createElement('img');
            img.src = '/photoglobe/thumbnail/' + pin.filename + '.webp';
            img.addEventListener('click', e => {
                e.stopPropagation();
                panelName.textContent = pin.name;
                updatePanelCoords(pin);
                panelDesc.textContent = pin.desc || '';
                panelImg.src = '/photoglobe/photo/' + pin.filename;
                panelImg.dataset.filename = pin.filename;
                panelImg.style.display = 'block';
                panelGrid.classList.remove('visible');
                panelGrid.innerHTML = '';
                viewingSingleInCluster = true;
                closeBtn.textContent = '←';
                targetRotY = (-pin.lng - 90) * Math.PI / 180;
                targetRotX = pin.lat * Math.PI / 180;
                const idx = currentClusterPins ? currentClusterPins.indexOf(pin) : 0;
                openLightbox('/photoglobe/fullsize/' + pin.filename, currentClusterPins || [], Math.max(0, idx));
            });
            panelGrid.appendChild(img);
        });
    } else {
        // Actually close the panel
        panel.classList.remove('open');
        panelGrid.classList.remove('visible');
        panelGrid.innerHTML = '';
        currentClusterPins = null;
        viewingSingleInCluster = false;
        closeBtn.textContent = '✕';
    }
});

// Lightbox elements — use querySelector so duplicates never cause silent failures
const lightbox         = document.querySelector('#lightbox');
const lightboxImg      = document.querySelector('#lightbox-img');
const lightboxBg       = document.querySelector('#lightbox-bg');
const lightboxPrev     = document.querySelector('#lightbox-prev');
const lightboxNext     = document.querySelector('#lightbox-next');
const lightboxLocation = document.querySelector('#lightbox-location');
const lightboxDatetime = document.querySelector('#lightbox-datetime');

// Bind close to ALL elements with that id (handles stale HTML with duplicate ids)
const lightboxCloseEls = document.querySelectorAll('#lightbox-close');

// Lightbox state
let lightboxPins  = [];
let lightboxIndex = 0;
let lightboxBusy  = false;

// ── Date/time formatter: "2025-06-07 11:33" → "June 7, 2025  ·  11:33 AM" ──
function formatDatetime(dt) {
    if (!dt) return '';
    const [datePart, timePart] = dt.split(' ');
    if (!datePart) return dt;
    const [y, m, d] = datePart.split('-').map(Number);
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    let result = `${months[m - 1]} ${d}, ${y}`;
    if (timePart) {
        const [hh, mm] = timePart.split(':').map(Number);
        const ampm = hh >= 12 ? 'PM' : 'AM';
        result += `  ·  ${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${ampm}`;
    }
    return result;
}

// ── Update side-panel coords block (date · coords · spatial tag) ──────────
function updatePanelCoords(pin) {
    const datetimeEl = document.getElementById('panel-datetime');
    const spatialEl  = document.getElementById('panel-spatial');
    if (!pin) {
        datetimeEl.textContent = '';
        datetimeEl.style.display = 'none';
        panelCoords.textContent = '';
        spatialEl.style.display = 'none';
        return;
    }
    datetimeEl.textContent = pin.datetime ? formatDatetime(pin.datetime) : '';
    datetimeEl.style.display = pin.datetime ? 'inline-block' : 'none';
    panelCoords.textContent = `${pin.lat}° N  ${pin.lng}° E`;
    spatialEl.style.display = pin.is_spatial ? 'inline-block' : 'none';
}

// ── Update fullscreen info bar ────────────────────────────────────────────
function updateLightboxInfo(pin) {
    if (!pin) {
        lightboxLocation.textContent = '';
        lightboxDatetime.textContent = '';
        return;
    }
    lightboxLocation.textContent = pin.name || '';
    lightboxDatetime.textContent = formatDatetime(pin.datetime);
}

// ── Arrow visibility (always loops) ──────────────────────────────────────
function updateArrows() {
    const show = lightboxPins.length > 1;
    lightboxPrev.style.display = show ? 'flex' : 'none';
    lightboxNext.style.display = show ? 'flex' : 'none';
}

// ── Preload one image into the browser HTTP cache ────────────────────────
function preloadSrc(src) {
    if (thumbnailCache['__full__' + src]) return;   // already cached
    thumbnailCache['__full__' + src] = 'loading';   // mark in-flight
    const img   = new Image();
    img.onload  = () => { thumbnailCache['__full__' + src] = true; };
    img.onerror = () => { delete thumbnailCache['__full__' + src]; };
    img.src = src;
}

// Preload ALL photos in the current lightboxPins array (cluster-wide)
function preloadAll() {
    for (const pin of lightboxPins) {
        preloadSrc('/photoglobe/fullsize/' + pin.filename);
    }
}

// ── Open: blank the img FIRST so old photo never flashes ─────────────────
function openLightbox(src, pins, index) {
    lightboxPins  = pins  || [];
    lightboxIndex = typeof index === 'number' ? index : 0;
    lightboxBusy  = false;

    lightboxImg.classList.remove('lb-fading');
    lightboxImg.src = '';   // blank prevents old-photo flash

    updateArrows();
    updateLightboxInfo(lightboxPins[lightboxIndex] || null);

    // Kick off background preload for every photo in the cluster
    preloadAll();

    // Wait for the requested image specifically before opening
    const loader   = new Image();
    const onReady  = () => {
        lightboxImg.src = src;
        void lightboxImg.offsetWidth;
        lightbox.classList.add('open');
    };
    loader.onload  = onReady;
    loader.onerror = onReady;
    loader.src = src;
}

// ── Close ────────────────────────────────────────────────────────────────
function closeLightbox() {
    lightbox.classList.remove('open');
    lightboxBusy = false;
    setTimeout(() => {
        lightboxPrev.style.display = 'none';
        lightboxNext.style.display = 'none';
        lightboxImg.classList.remove('lb-fading');
        lightboxImg.src = '';
    }, 350);
}

// ── Navigate (wraps around) ───────────────────────────────────────────────
// Sequence: fade out → swap src (keep hidden) → onload fires (cache = next frame,
// uncached = after server decode) → remove lb-fading → fade in.
// This guarantees the OLD photo never fades back in before the new one is ready.
const FADE_MS = 180;

function lightboxNavigate(dir) {
    if (lightboxBusy || !lightboxPins.length) return;
    lightboxBusy = true;

    const nextIndex = (lightboxIndex + dir + lightboxPins.length) % lightboxPins.length;
    const pin       = lightboxPins[nextIndex];
    const nextSrc   = '/photoglobe/fullsize/' + pin.filename;

    // Fade out
    lightboxImg.classList.add('lb-fading');

    // After fade-out completes, swap src but keep hidden until new image is decoded
    setTimeout(() => {
        lightboxIndex = nextIndex;

        // Clear any previous onload so it doesn't fire for the old request
        lightboxImg.onload  = null;
        lightboxImg.onerror = null;

        // Only fade in once the browser has the new image ready to paint
        lightboxImg.onload = lightboxImg.onerror = () => {
            lightboxImg.onload  = null;
            lightboxImg.onerror = null;
            void lightboxImg.offsetWidth;              // flush before class removal
            lightboxImg.classList.remove('lb-fading'); // triggers fade-in
            panelName.textContent = pin.name;
            updatePanelCoords(pin);
            panelImg.src = nextSrc;
            panelImg.dataset.filename = pin.filename;
            updateLightboxInfo(pin);
            lightboxBusy = false;
        };

        lightboxImg.src = nextSrc;   // set AFTER binding onload
    }, FADE_MS);
}

// ── Event listeners ───────────────────────────────────────────────────────
// Close: bind to every #lightbox-close element in case there are HTML dupes
lightboxCloseEls.forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); closeLightbox(); });
});

// Background click (only the bg div itself, not children)
lightboxBg.addEventListener('click', closeLightbox);

lightboxPrev.addEventListener('click', e => { e.stopPropagation(); lightboxNavigate(-1); });
lightboxNext.addEventListener('click', e => { e.stopPropagation(); lightboxNavigate(1); });

window.addEventListener('keydown', e => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'ArrowLeft')  lightboxNavigate(-1);
    if (e.key === 'ArrowRight') lightboxNavigate(1);
    if (e.key === 'Escape')     closeLightbox();
});

// Click the panel thumbnail to go fullscreen
panelImg.addEventListener('click', () => {
    const filename = panelImg.dataset.filename;
    if (!filename) return;
    const src   = '/photoglobe/fullsize/' + filename;
    const pins  = (viewingSingleInCluster && currentClusterPins) 
        ? currentClusterPins 
        : (currentSinglePin ? [currentSinglePin] : []);
    const index = pins.findIndex(p => p.filename === filename);
    openLightbox(src, pins, Math.max(0, index));
});
panelImg.style.cursor = 'pointer';

// Get or start loading a thumbnail
function getThumbnail(filename, onScreen) {
    // Change this line to match your actual file naming convention
    const thumbName = filename + '.webp'; 
    
    if (thumbnailCache[thumbName]) return thumbnailCache[thumbName];
    if (onScreen && thumbnailCache[thumbName] !== null) {
        thumbnailCache[thumbName] = null;
        const img = new Image();
        img.onload = () => { thumbnailCache[thumbName] = img; };
        img.src = '/photoglobe/thumbnail/' + thumbName;
    }
    return null;
}

// Get or generate a consistent random tilt for a pin
function getTilt(filename) {
    if (pinTilts[filename] === undefined) {
        pinTilts[filename] = (Math.random() - 0.5) * 16 * Math.PI / 180;
    }
    return pinTilts[filename];
}

// Draw a thumbnail image cropped to cover the destination rect (no stretching)
function drawThumbCover(ctx, thumb, dx, dy, dw, dh) {
    const srcAspect = thumb.width / thumb.height;
    const dstAspect = dw / dh;
    let sx, sy, sw, sh;
    if (srcAspect > dstAspect) {
        // Source is wider — crop sides
        sh = thumb.height;
        sw = thumb.height * dstAspect;
        sx = (thumb.width - sw) / 2;
        sy = 0;
    } else {
        // Source is taller — crop top/bottom
        sw = thumb.width;
        sh = thumb.width / dstAspect;
        sx = 0;
        sy = (thumb.height - sh) / 2;
    }
    ctx.drawImage(thumb, sx, sy, sw, sh, dx, dy, dw, dh);
}

// Calculate the longitude the sun is currently over based on UTC time
function getSunLng() {
    const now = new Date();
    const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    // 12:00 UTC (Noon) is 0° longitude. 
    // Since 1 hour = 15°, and the sun moves WEST (negative), we use (12 - utcHours).
    return (12 - utcHours) * 15;
}

// ─── WebGL Setup ────────────────────────────────────────────────────────────

const vsSource = `
    attribute vec2 a_position;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

const fsSource = `
    precision highp float;
    uniform vec2 u_center;
    uniform float u_radius;
    uniform float u_rotX;
    uniform float u_rotY;
    uniform float u_sunLng;
    uniform sampler2D u_dayTex;
    uniform sampler2D u_nightTex;
    uniform sampler2D u_cloudTex;
    uniform sampler2D u_specTex;
    uniform sampler2D u_normalTex;
    uniform int u_nightLoaded;
    uniform int u_cloudLoaded;
    uniform int u_specLoaded;
    uniform int u_normalLoaded;
    uniform float u_dayOfYear;

    const float PI = 3.14159265358979323846;

    void main() {
        float dx = (gl_FragCoord.x - u_center.x) / u_radius;
        float dy = (gl_FragCoord.y - u_center.y) / u_radius;
        float d2 = dx * dx + dy * dy;
        if (d2 > 1.0) { discard; return; }
        float dz = sqrt(1.0 - d2);

        // Atmospheric rim glow — stronger at edges
        float rim = 1.0 - dz;
        float rimGlow = pow(rim, 3.0) * 0.6;
        vec3 atmosColor = vec3(0.3, 0.5, 1.0);

        vec3 n = vec3(dx, dy, dz);

        float cx = cos(-u_rotX), sx = sin(-u_rotX);
        vec3 p1 = vec3(n.x, n.y * cx - n.z * sx, n.y * sx + n.z * cx);

        float cy = cos(-u_rotY), sy = sin(-u_rotY);
        vec3 p2 = vec3(p1.x * cy + p1.z * sy, p1.y, -p1.x * sy + p1.z * cy);

        float lat = asin(clamp(p2.y, -1.0, 1.0));
        float lng = atan(p2.x, p2.z);

        float u = fract(lng / (2.0 * PI) + 0.2505);
        float v = clamp(0.5 - lat / PI, 0.0, 1.0);
        vec2 uv = vec2(u, v);

        // Day texture base color
        vec3 col = texture2D(u_dayTex, uv).rgb;

        // Sun direction in world space
        float sunLngRad = (u_sunLng - 90.0) * PI / 180.0;
        // Earth's axial tilt — sun declination varies by season
        // Standard formula: declination = -23.45° * cos(360/365 * (day + 10))
        float declDeg = -23.45 * cos((u_dayOfYear + 0.0) * 2.0 * PI / 365.0);
        // 0.0 is the offset for the sun, doesn't need to be changed now
        float sunDecl = sin(declDeg * PI / 180.0);
        vec3 sunDir = normalize(vec3(-sin(sunLngRad), sunDecl, -cos(sunLngRad)));

        // Basic sun-facing value for lighting
        float sunFacing = dot(p2, sunDir);

        // Smoother terminator — wide soft blend
        float dayLight = smoothstep(-0.15, 0.2, sunFacing);

        // Normal mapping for terrain lighting
        vec3 surfaceNormal = normalize(p2);
        if (u_normalLoaded == 1) {
            vec3 nMap = texture2D(u_normalTex, uv).rgb * 2.0 - 1.0;
            nMap.xy *= 2.0; // Exaggerate terrain bumpiness

            // Build tangent frame from surface position
            vec3 up = vec3(0.0, 1.0, 0.0);
            vec3 tangent = normalize(cross(up, surfaceNormal));
            vec3 bitangent = cross(surfaceNormal, tangent);

            // Perturb the surface normal
            surfaceNormal = normalize(
                tangent * nMap.x + bitangent * nMap.y + surfaceNormal * nMap.z
            );
        }

        // Diffuse lighting using perturbed normal
        float diffuse = max(dot(surfaceNormal, sunDir), 0.0);

        // Apply diffuse to day texture — subtle terrain shading
        col *= mix(0.85, 1.15, diffuse * dayLight);

        // Night blend
        float nightBlend = 1.0 - dayLight;

        if (u_nightLoaded == 1) {
            vec3 nightCol = texture2D(u_nightTex, uv).rgb;
            col = mix(col, nightCol, nightBlend);
        } else {
            // Darken the night side if no night texture
            col *= dayLight;
        }

        // Specular ocean reflection (sun glint)
        if (u_specLoaded == 1) {
            float isOcean = texture2D(u_specTex, uv).r;

            // Tint ocean for better contrast on day side
            col = mix(col, col * vec3(0.8, 0.9, 1.1), isOcean * dayLight * 0.5);

            // Specular highlight — sun glint on water
            // Transform screen-space view direction (0,0,1) into world space
            // by applying the same inverse rotation used to un-rotate the surface normal
            vec3 viewDir = normalize(vec3(
                -cos(u_rotX) * sin(u_rotY),
                sin(u_rotX),
                cos(u_rotX) * cos(u_rotY)
            ));
            vec3 halfDir = normalize(sunDir + viewDir);
            float spec = pow(max(dot(surfaceNormal, halfDir), 0.0), 64.0);
            col += vec3(1.0, 0.95, 0.8) * spec * isOcean * dayLight * 0.5;
        }

        // Clouds
        if (u_cloudLoaded == 1) {
            float cloud = texture2D(u_cloudTex, uv).r * 0.45;
            // Clouds lit on day side, dim on night side
            float cloudBrightness = mix(0.08, 1.0, dayLight);
            col = mix(col, vec3(cloudBrightness), cloud);
        }

        // Add atmospheric rim glow
        col += atmosColor * rimGlow * mix(0.3, 1.0, dayLight);

        gl_FragColor = vec4(col, 1.0);
    }
`;

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader error:', gl.getShaderInfoLog(shader));
        return null;
    }
    return shader;
}

const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
const glProgram = gl.createProgram();
gl.attachShader(glProgram, vs);
gl.attachShader(glProgram, fs);
gl.linkProgram(glProgram);
gl.useProgram(glProgram);

// Full screen quad
const posBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
const posLoc = gl.getAttribLocation(glProgram, 'a_position');
gl.enableVertexAttribArray(posLoc);
gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

// Uniform locations
const uCenter      = gl.getUniformLocation(glProgram, 'u_center');
const uRadius      = gl.getUniformLocation(glProgram, 'u_radius');
const uRotX        = gl.getUniformLocation(glProgram, 'u_rotX');
const uRotY        = gl.getUniformLocation(glProgram, 'u_rotY');
const uSunLng      = gl.getUniformLocation(glProgram, 'u_sunLng');
const uNightLoaded = gl.getUniformLocation(glProgram, 'u_nightLoaded');
const uCloudLoaded = gl.getUniformLocation(glProgram, 'u_cloudLoaded');
const uSpecLoaded   = gl.getUniformLocation(glProgram, 'u_specLoaded');
const uNormalLoaded = gl.getUniformLocation(glProgram, 'u_normalLoaded');
const uDayOfYear = gl.getUniformLocation(glProgram, 'u_dayOfYear');

function createGLTexture(unit) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
}

const glDayTex   = createGLTexture(0);
const glNightTex = createGLTexture(1);
const glCloudTex = createGLTexture(2);
const glSpecTex   = createGLTexture(3);
const glNormalTex = createGLTexture(4);

gl.uniform1i(gl.getUniformLocation(glProgram, 'u_dayTex'),   0);
gl.uniform1i(gl.getUniformLocation(glProgram, 'u_nightTex'), 1);
gl.uniform1i(gl.getUniformLocation(glProgram, 'u_cloudTex'), 2);
gl.uniform1i(gl.getUniformLocation(glProgram, 'u_specTex'),   3);
gl.uniform1i(gl.getUniformLocation(glProgram, 'u_normalTex'), 4);

let dayLoaded = false, nightLoaded = false, cloudLoaded = false, specLoaded = false, normalLoaded = false;

function loadGLTexture(img, tex, unit, onLoad) {
    img.onload = () => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        
        // ADD THIS LINE for sharpness:
        const ext = gl.getExtension('EXT_texture_filter_anisotropic');
        if (ext) {
            const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
            gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, max);
        }

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        onLoad();
    };
}

loadGLTexture(earthTexture,    glDayTex,   0, () => { dayLoaded   = true; });
loadGLTexture(nightTexture,    glNightTex, 1, () => { nightLoaded = true; });
loadGLTexture(cloudTexture,    glCloudTex, 2, () => { cloudLoaded = true; });
loadGLTexture(specularTexture, glSpecTex,   3, () => { specLoaded  = true; });
loadGLTexture(normalTexture,   glNormalTex, 4, () => { normalLoaded = true; });

function drawGlobe() {
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!dayLoaded) return;
    const r = R * zoom;
    // Pass the Y-coordinate flipped for WebGL's bottom-left origin
    gl.uniform2f(uCenter, cx, glCanvas.height - cy);
    gl.uniform1f(uRadius, r);
    gl.uniform1f(uRotX, rotX);
    gl.uniform1f(uRotY, rotY);
    gl.uniform1f(uSunLng, getSunLng());
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 0);
    const dayOfYear = (now - startOfYear) / 86400000;
    gl.uniform1f(uDayOfYear, dayOfYear);
    gl.uniform1i(uNightLoaded, nightLoaded ? 1 : 0);
    gl.uniform1i(uCloudLoaded, cloudLoaded ? 1 : 0);
    gl.uniform1i(uSpecLoaded,   specLoaded   ? 1 : 0);
    gl.uniform1i(uNormalLoaded, normalLoaded ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ─── Main draw loop ──────────────────────────────────────────────────────────

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    anyHovered = false;

    // Calculate zoomed radius fresh every frame
    const r = R * zoom;

    // Smoothly animate toward target rotation if set
    if (targetRotY !== null) {
        let diffY = targetRotY - rotY;
        const diffX = targetRotX - rotX;
        while (diffY > Math.PI) diffY -= Math.PI * 2;
        while (diffY < -Math.PI) diffY += Math.PI * 2;
        const centerEase = Math.min(0.12, 0.04 * Math.max(1, zoom * 0.5));
        rotY += diffY * centerEase;
        rotX += diffX * centerEase;
        if (Math.abs(diffY) < 0.001 && Math.abs(diffX) < 0.001) {
            rotY = targetRotY;
            rotX = targetRotX;
            targetRotY = null;
            targetRotX = null;
        }
    }

    // Normalize rotY to -PI to PI
    while (rotY > Math.PI) rotY -= Math.PI * 2;
    while (rotY < -Math.PI) rotY += Math.PI * 2;

    // Smooth zoom
    if (zoomAnimStart !== null) {
        // Animated zoom — smooth ease-out curve
        const elapsed = Date.now() - zoomAnimStart;
        const t = Math.min(1, elapsed / zoomAnimDuration);
        // Ease-out cubic: fast start, gentle landing
        const eased = 1 - Math.pow(1 - t, 3);
        zoom = zoomAnimFrom + (zoomAnimTo - zoomAnimFrom) * eased;
        targetZoom = zoom;
        if (t >= 1) {
            zoomAnimStart = null;
            slowZoom = false;
        }
    } else {
        const zoomDiff = targetZoom - zoom;
        if (Math.abs(zoomDiff) > 0.0001) {
            zoom += zoomDiff * 0.06;
        } else {
            zoom = targetZoom;
        }
    }

    // Draw globe via WebGL
    drawGlobe();

    // Outer atmosphere glow — soft blue halo beyond the globe edge
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
    ctx.clip();

    const glowLayers = [
        { alpha: 0.12, spread: r * 0.03 },
        { alpha: 0.07, spread: r * 0.06 },
        { alpha: 0.03, spread: r * 0.12 },
    ];
    for (const layer of glowLayers) {
        const outerR = r + layer.spread;
        const grad = ctx.createRadialGradient(cx, cy, r, cx, cy, outerR);
        grad.addColorStop(0, `rgba(100,170,255,${layer.alpha})`);
        grad.addColorStop(1, 'rgba(100,170,255,0)');
        ctx.beginPath();
        ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
    }
    ctx.restore();

    // Globe outline on 2D canvas
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(74,158,255,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw grid lines using cached unit positions
    ctx.strokeStyle = 'rgba(74,158,255,0.15)';
    ctx.lineWidth = 0.5;
    const cosRY = Math.cos(rotY), sinRY = Math.sin(rotY);
    const cosRX = Math.cos(rotX), sinRX = Math.sin(rotX);
    for (const line of gridLines) {
        ctx.beginPath();
        let penDown = false;
        for (const p of line) {
            // Inline rotate + scale
            const x1 = (p.x * cosRY + p.z * sinRY) * r;
            const z1 = (-p.x * sinRY + p.z * cosRY) * r;
            const y2 = (p.y * cosRX - (z1/r) * sinRX) * r;
            const z2 = p.y * r * sinRX + z1 * cosRX;
            if (z2 > 0) {
                const sx = cx + x1, sy = cy - y2;
                if (!penDown) { ctx.moveTo(sx, sy); penDown = true; }
                else ctx.lineTo(sx, sy);
            } else {
                penDown = false;
            }
        }
        ctx.stroke();
    }

    // Replace your "Build list of visible pins" and "Cluster pins" sections with this:
    const clusters = clusterPins(PINS, r, Math.max(30, 44 / zoom));

    // Skip expensive fade-in/fade-out tracking during zoom/rotation animations
    const isAnimating = zoomAnimStart !== null || targetRotY !== null;

    if (!isAnimating) {
        // The key generation remains the same, but it's now stable 
        // because the cluster membership won't change at the horizon.
        const currentKeys = new Set(clusters.map(c => 
            c.pins.length === 1 ? c.pins[0].filename : c.pins.map(p => p.filename).sort().join(',')
        ));

        if (lastClusters.length > 0) {
            for (const oldCluster of lastClusters) {
                const isSingle = oldCluster.pins.length === 1;
                const key = isSingle ? oldCluster.pins[0].filename : oldCluster.pins.map(p => p.filename).sort().join(',');

                if (!currentKeys.has(key)) {
                    // Find clusters in the NEW frame that contain pins from this OLD cluster
                    const destinationClusters = clusters.filter(c => 
                        c.pins.some(p => oldCluster.pins.some(op => op.filename === p.filename))
                    );

                    // Check if any of these destination pins are actually on the visible side (z > 0)
                    const isStillVisible = destinationClusters.some(c => {
                        return c.pins.some(p => {
                            const rot = rotate(latLngTo3D(p.lat, p.lng, r));
                            return rot.z > 0;
                        });
                    });

                    // FADE IF: 
                    // 1. It joined a larger group (merging)
                    // 2. OR it has completely moved to the back of the globe (not visible)
                    const joinedLarger = destinationClusters.length === 1 && destinationClusters[0].pins.length > oldCluster.pins.length;
                    const shouldFade = joinedLarger || !isStillVisible;

                    if (shouldFade && !fadingPins.some(f => f.id === key)) {
                        fadingPins.push({
                            id: key,
                            isCluster: !isSingle,
                            count: oldCluster.pins.length,
                            name: isSingle ? (oldCluster.pins[0].name || '').split(',')[0] : oldCluster.pins[0].name.split(',')[0],
                            filename: isSingle ? key : oldCluster.pins[clusterRepCache[key] || 0].filename,
                            x: oldCluster.x,
                            y: oldCluster.y,
                            startTime: Date.now(),
                            duration: 400
                        });
                    }
                }
            }
        }
    }

    // Draw fading pins AND clusters
    for (let i = fadingPins.length - 1; i >= 0; i--) {
        const f = fadingPins[i];
        const elapsed = Date.now() - f.startTime;
        const t = elapsed / f.duration;
        if (t >= 1) { fadingPins.splice(i, 1); continue; }

        const alpha = 1 - t;
        const tilt = getTilt(f.filename);
        const thumb = getThumbnail(f.filename, false);
        
        // Switch dimensions based on type
        const pw = f.isCluster ? 66 : 54;
        const ph = f.isCluster ? 66 : 66;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(f.x, f.y);
        ctx.rotate(tilt);
        
        // Draw Shadow & Card
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(-pw/2 + 2, -ph/2 + 2, pw, ph);
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(-pw/2, -ph/2, pw, ph);

        if (thumb) {
            const margin = 3;
            const imgHeight = ph - margin*2 - 9;
            drawThumbCover(ctx, thumb, -pw/2 + margin, -ph/2 + margin, pw - margin*2, imgHeight);
        }
        
        ctx.restore();

        // Fading label below the card
        const fadingLabel = f.isCluster ? `${f.name} [${f.count}]` : f.name;
        if (fadingLabel) {
            ctx.globalAlpha = alpha;
            ctx.font = f.isCluster ? 'bold 11px Nunito, sans-serif' : 'bold 10px Nunito, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.lineWidth = 3;
            ctx.lineJoin = 'round';
            ctx.strokeText(fadingLabel, f.x, f.y + ph/2 + 4);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(fadingLabel, f.x, f.y + ph/2 + 4);
            ctx.globalAlpha = 1;
        }
    }

    // Draw each cluster or pin
    const currentAppearKeys = new Set();
    const W = canvas.width, H = canvas.height;
    for (const cluster of clusters) {
        // Skip clusters entirely off-screen
        if (cluster.x < -60 || cluster.x > W + 60 || cluster.y < -60 || cluster.y > H + 60) continue;

        const count = cluster.pins.length;
        const dx = cluster.x - mouseX;
        const dy = cluster.y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const hovered = dist < 30;

        // Compute appear animation
        const appearKey = count === 1
            ? cluster.pins[0].filename
            : cluster.pins.map(p => p.filename).sort().join(',');
        currentAppearKeys.add(appearKey);
        if (appearTimes[appearKey] === undefined) {
            appearTimes[appearKey] = Date.now();
        }
        const appearElapsed = Date.now() - appearTimes[appearKey];
        const appearT = Math.min(1, appearElapsed / APPEAR_DURATION);
        const appearEased = 1 - Math.pow(1 - appearT, 3);
        const appearScale = 0.3 + 0.7 * appearEased;
        const appearAlpha = appearEased;

        if (hovered) {
            anyHovered = true;
            const label = count === 1
                ? cluster.pins[0].name || `${cluster.pins[0].lat}°, ${cluster.pins[0].lng}°`
                : `${cluster.pins[0].name.split(',')[0]} [${count}]`;
            tooltip.textContent = label;
            tooltip.style.left = (mouseX + canvas.getBoundingClientRect().left + 16) + 'px';
            tooltip.style.top = (mouseY + canvas.getBoundingClientRect().top - 10) + 'px';
            tooltip.classList.add('visible');
        }

        if (count >= 2) {
            const clusterKey = cluster.pins.map(p => p.filename).sort().join(',');
            if (clusterRepCache[clusterKey] === undefined) {
                clusterRepCache[clusterKey] = Math.floor(Math.random() * cluster.pins.length);
            }
            const repPin = cluster.pins[clusterRepCache[clusterKey]];
            const tilt = getTilt(repPin.filename);
            const thumb = getThumbnail(repPin.filename, true);
            const pw = 66;
            const ph = 66;

            ctx.save();
            ctx.globalAlpha = appearAlpha;
            ctx.translate(cluster.x, cluster.y);
            ctx.rotate(tilt);
            const s = (hovered ? 1.08 : 1) * appearScale;
            ctx.scale(s, s);
            // Soft shadow via offset rectangle (much cheaper than shadowBlur)
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(-pw/2 + 3, -ph/2 + 3, pw, ph);
            ctx.fillStyle = hovered ? '#ffffff' : '#e8e8e8';
            ctx.fillRect(-pw/2, -ph/2, pw, ph);
            if (thumb) {
                const margin = 3;
                drawThumbCover(ctx, thumb, -pw/2 + margin, -ph/2 + margin, pw - margin*2, ph - margin*2 - 9);
            }
            ctx.restore();

            // Label below the card — no rotation
            const label = `${cluster.pins[0].name.split(',')[0]} [${count}]`;
            const ly = cluster.y + ph/2 * appearScale + 4;
            ctx.globalAlpha = appearAlpha;
            ctx.font = 'bold 11px Nunito, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.lineWidth = 3;
            ctx.lineJoin = 'round';
            ctx.strokeText(label, cluster.x, ly);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, cluster.x, ly);
            ctx.globalAlpha = 1;
        } else {
            const pin = cluster.pins[0];
            const tilt = getTilt(pin.filename);
            const thumb = getThumbnail(pin.filename, true);
            const pw = 54;
            const ph = 66;

            ctx.save();
            ctx.globalAlpha = appearAlpha;
            ctx.translate(cluster.x, cluster.y);
            ctx.rotate(tilt);
            const s = (hovered ? 1.08 : 1) * appearScale;
            ctx.scale(s, s);
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(-pw/2 + 3, -ph/2 + 3, pw, ph);
            ctx.fillStyle = hovered ? '#ffffff' : '#e8e8e8';
            ctx.fillRect(-pw/2, -ph/2, pw, ph);
            if (thumb) {
                const margin = 3;
                drawThumbCover(ctx, thumb, -pw/2 + margin, -ph/2 + margin, pw - margin*2, ph - margin*2 - 9);
            }
            ctx.restore();

            // Label below the pin
            const pinLabel = pin.name ? pin.name.split(',')[0] : '';
            if (pinLabel) {
                const ly = cluster.y + ph/2 * appearScale + 4;
                ctx.globalAlpha = appearAlpha;
                ctx.font = 'bold 10px Nunito, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.strokeStyle = 'rgba(0,0,0,0.8)';
                ctx.lineWidth = 3;
                ctx.lineJoin = 'round';
                ctx.strokeText(pinLabel, cluster.x, ly);
                ctx.fillStyle = '#ffffff';
                ctx.fillText(pinLabel, cluster.x, ly);
                ctx.globalAlpha = 1;
            }
        }
    }

    // Clean up appear times for pins/clusters no longer on screen
    for (const key in appearTimes) {
        if (!currentAppearKeys.has(key)) {
            delete appearTimes[key];
        }
    }

    // Save clusters for click detection
    lastClusters = clusters;

    // Hide tooltip if no pin is hovered
    if (!anyHovered) tooltip.classList.remove('visible');

    // Auto spin when idle
    if (!dragging) {
        const idleTime = (Date.now() - lastInteraction) / 1000;
        const panelOpen = panel.classList.contains('open');
        const tooZoomedIn = zoom > 2.5;
        if (!panelOpen && !tooZoomedIn) {
            const speedMultiplier = Math.min(1, Math.max(0, (idleTime - 5) / 3));
            rotY += 0.005 * speedMultiplier;
        }
    }

    // Update clock display
    const now = new Date();
    const timeZoneAbbr = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
    const timeStr = now.getHours().toString().padStart(2, '0') + ':' +
                    now.getMinutes().toString().padStart(2, '0') + ':' +
                    now.getSeconds().toString().padStart(2, '0') + ' ' + timeZoneAbbr;
    document.getElementById('clock').textContent = timeStr;

    requestAnimationFrame(draw);
}

// Mouse events
let wasDragged = false;

canvas.addEventListener('mousedown', e => {
    dragging = true;
    wasDragged = false;
    lastMX = e.clientX;
    lastMY = e.clientY;
    lastInteraction = Date.now();
    // Cancel any zoom/center animation so drag takes over
    targetRotY = null;
    targetRotX = null;
    zoomAnimStart = null;
    slowZoom = false;
});

canvas.addEventListener('mousemove', e => {
    mouseX = e.clientX - canvas.getBoundingClientRect().left;
    mouseY = e.clientY - canvas.getBoundingClientRect().top;
    if (dragging) {
        const dx = e.clientX - lastMX;
        const dy = e.clientY - lastMY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) wasDragged = true;
        
        const sensitivity = 0.005 / zoom;

        // Apply vertical rotation (Latitude) directly
        rotX += dy * sensitivity;

        // Apply horizontal rotation (Longitude) relative to view
        // This stops the "dead" feeling at the poles
        rotY += dx * sensitivity / Math.max(0.1, Math.cos(rotX));

        // Clamp vertical to avoid flipping
        const limit = Math.PI / 2 - 0.01;
        if (rotX > limit) rotX = limit;
        if (rotX < -limit) rotX = -limit;

        lastMX = e.clientX;
        lastMY = e.clientY;
    }
});

window.addEventListener('mouseup', () => { dragging = false; });

canvas.addEventListener('click', () => {
    if (wasDragged) return;
    for (const cluster of lastClusters) {
        const dx = cluster.x - mouseX;
        const dy = cluster.y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 30) {
            if (cluster.pins.length === 1) {
                const pin = cluster.pins[0];
                panelName.textContent = pin.name;
                updatePanelCoords(pin);
                panelDesc.textContent = pin.desc || '';
                currentClusterPins = null;
                viewingSingleInCluster = false;
                closeBtn.textContent = '✕';
                panelGrid.classList.remove('visible');
                panelGrid.innerHTML = '';
                if (pin.filename) {
                    currentSinglePin = pin;
                    panelImg.src = '/photoglobe/photo/' + pin.filename;
                panelImg.dataset.filename = pin.filename;
                    panelImg.style.display = 'block';
                } else {
                    panelImg.style.display = 'none';
                }
                const pinZoom = Math.min(Math.max(zoom * 2, 4), MAX_CLICK_ZOOM);
                // Only animate zoom if it would zoom in, not out
                if (pinZoom > zoom) {
                    zoomAnimFrom = zoom;
                    zoomAnimTo = pinZoom;
                    zoomAnimDuration = Math.min(2000, Math.max(600, (pinZoom / zoom) * 500));
                    zoomAnimStart = Date.now();
                }
                targetRotY = (-pin.lng - 90) * Math.PI / 180;
                targetRotX = pin.lat * Math.PI / 180;
                slowZoom = true;
                panel.classList.add('open');
            } else {
                panelName.textContent = `${cluster.pins[0].name.split(',')[0]} [${cluster.pins.length}]`;
                updatePanelCoords(null);
                panelDesc.textContent = '';
                panelImg.style.display = 'none';
                panelGrid.innerHTML = '';
                panelGrid.classList.add('visible');
                currentClusterPins = cluster.pins;
                viewingSingleInCluster = false;
                closeBtn.textContent = '✕';
                cluster.pins.forEach(pin => {
                    const img = document.createElement('img');
                    img.src = '/photoglobe/thumbnail/' + pin.filename + '.webp';
                    img.addEventListener('click', e => {
                        e.stopPropagation();
                        panelName.textContent = pin.name;
                        updatePanelCoords(pin);
                        panelDesc.textContent = pin.desc || '';
                        panelImg.src = '/photoglobe/photo/' + pin.filename;
                panelImg.dataset.filename = pin.filename;
                        panelImg.style.display = 'block';
                        panelGrid.classList.remove('visible');
                        panelGrid.innerHTML = '';
                        viewingSingleInCluster = true;
                        closeBtn.textContent = '←';
                        targetRotY = (-pin.lng - 90) * Math.PI / 180;
                        targetRotX = pin.lat * Math.PI / 180;
                        // Open lightbox immediately with full cluster for navigation
                        const idx = currentClusterPins ? currentClusterPins.indexOf(pin) : 0;
                        openLightbox('/photoglobe/fullsize/' + pin.filename, currentClusterPins || [], Math.max(0, idx));
                    });
                    panelGrid.appendChild(img);
                });
                panel.classList.add('open');

                const avgLat = cluster.pins.reduce((sum, p) => sum + p.lat, 0) / cluster.pins.length;
                const avgLng = cluster.pins.reduce((sum, p) => sum + p.lng, 0) / cluster.pins.length;
                targetRotY = (-avgLng - 90) * Math.PI / 180;
                targetRotX = avgLat * Math.PI / 180;

                let minDotProduct = 1;
                for (let i = 0; i < cluster.pins.length; i++) {
                    for (let j = i + 1; j < cluster.pins.length; j++) {
                        const phi1 = (90 - cluster.pins[i].lat) * Math.PI / 180;
                        const lam1 = cluster.pins[i].lng * Math.PI / 180;
                        const phi2 = (90 - cluster.pins[j].lat) * Math.PI / 180;
                        const lam2 = cluster.pins[j].lng * Math.PI / 180;
                        const dot = Math.sin(phi1)*Math.sin(phi2)*Math.cos(lam1-lam2) + Math.cos(phi1)*Math.cos(phi2);
                        minDotProduct = Math.min(minDotProduct, dot);
                    }
                }
                // ... inside your cluster click logic
                const angSep = Math.acos(Math.max(-1, Math.min(1, minDotProduct)));

                // DEBUG: check actual vs predicted distances
                const predictedPixelDist = angSep * R * zoom;
                const threshold = Math.max(30, 44 / zoom);
                console.log('angSep:', angSep, 'R:', R, 'zoom:', zoom);
                console.log('predicted pixel dist:', predictedPixelDist, 'threshold:', threshold);
                console.log('actual cluster pin positions:');
                cluster.pins.forEach(p => console.log('  ', p.name, p.x, p.y));

                let breakZoom;
                if (isNaN(angSep) || angSep < 0.005) {
                    breakZoom = zoom * 3; 
                } else {
                    const highZoomBreak = 30 / (angSep * R);
                    const lowZoomBreak = Math.sqrt(44 / (angSep * R));
                    breakZoom = Math.max(highZoomBreak, lowZoomBreak);
                }
                // Always zoom in meaningfully from current position
                breakZoom = Math.max(breakZoom, zoom * 2);

                // Overshoot to ensure break, no upper cap
                const finalZoom = Math.min(breakZoom * 1.5, MAX_CLICK_ZOOM);
                // Only animate zoom if it would zoom in, not out
                if (finalZoom > zoom) {
                    zoomAnimFrom = zoom;
                    zoomAnimTo = finalZoom;
                    const zoomRatio = finalZoom / Math.max(0.5, zoom);
                    zoomAnimDuration = Math.min(3000, Math.max(800, zoomRatio * 600));
                    zoomAnimStart = Date.now();
                }
                slowZoom = true;
            }
        }
    }
});

// Resize handler
window.addEventListener('resize', () => {
    glCanvas.width = window.innerWidth;
    glCanvas.height = window.innerHeight;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    cx = canvas.width / 2;
    cy = canvas.height / 2;
    R = Math.min(canvas.width, canvas.height) * 0.44;
});

// Locate this section at the bottom of globe.js
canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const step = (e.deltaY > 0 ? -0.3 : 0.3) * zoom * 0.3;
    const newZoom = Math.max(0.5, Math.min(MAX_ZOOM, zoom + step));
    
    // FIX: Removed the "if (newZoom > zoom)" check. 
    // Any scroll interaction now resets the idle timer.
    lastInteraction = Date.now(); 
    
    zoom = newZoom;
    targetZoom = zoom;
    slowZoom = false;
    zoomAnimStart = null;
});

// Group pins into clusters
// Cache for reuse during animations
let cachedClusters = [];
let cachedClusterFrame = 0;

function clusterPins(allPins, r, thresholdPixels) {
    const clusters = [];
    const used = new Set();

    // Pre-compute all 3D and projected positions once (including back-facing)
    const positions = [];
    const cosRY = Math.cos(rotY), sinRY = Math.sin(rotY);
    const cosRX = Math.cos(rotX), sinRX = Math.sin(rotX);
    for (let i = 0; i < allPins.length; i++) {
        const p = allPins[i];
        const phi = (90 - p.lat) * Math.PI / 180;
        const theta = (p.lng + 180) * Math.PI / 180;
        const rawX = -Math.sin(phi) * Math.cos(theta) * r;
        const rawY = Math.cos(phi) * r;
        const rawZ = Math.sin(phi) * Math.sin(theta) * r;

        // Inline rotate
        const x1 = rawX * cosRY + rawZ * sinRY;
        const z1 = -rawX * sinRY + rawZ * cosRY;
        const y2 = rawY * cosRX - z1 * sinRX;
        const z2 = rawY * sinRX + z1 * cosRX;

        positions.push({
            pin: p,
            rawX: rawX / r, rawY: rawY / r, rawZ: rawZ / r,
            x: cx + x1, y: cy - y2, z: z2
        });
    }

    const len = positions.length;
    for (let i = 0; i < len; i++) {
        if (used.has(i)) continue;
        const p1 = positions[i];
        const cluster = { pins: [{ ...p1.pin, x: p1.x, y: p1.y, z: p1.z }] };

        for (let j = i + 1; j < len; j++) {
            if (used.has(j)) continue;
            const p2 = positions[j];
            const ddx = p1.rawX - p2.rawX;
            const ddy = p1.rawY - p2.rawY;
            const ddz = p1.rawZ - p2.rawZ;
            const dist3D = Math.sqrt(ddx*ddx + ddy*ddy + ddz*ddz) * r;

            if (dist3D < thresholdPixels) {
                cluster.pins.push({ ...p2.pin, x: p2.x, y: p2.y, z: p2.z });
                used.add(j);
            }
        }

        // Only show cluster if at least one pin is on the visible side
        let sumX = 0, sumY = 0, visCount = 0;
        for (const pin of cluster.pins) {
            if (pin.z > 0) {
                sumX += pin.x;
                sumY += pin.y;
                visCount++;
            }
        }

        if (visCount > 0) {
            cluster.x = sumX / visCount;
            cluster.y = sumY / visCount;
            cluster.isVisible = true;
            clusters.push(cluster);
        }
        used.add(i);
    }
    return clusters;
}

// Pre-compute grid line unit positions (on unit sphere, r=1)
const gridLines = [];
for (let lat = -80; lat <= 80; lat += 20) {
    const points = [];
    for (let lng = -180; lng <= 180; lng += 3) {
        const phi = (90 - lat) * Math.PI / 180;
        const theta = (lng + 180) * Math.PI / 180;
        points.push({
            x: -Math.sin(phi) * Math.cos(theta),
            y: Math.cos(phi),
            z: Math.sin(phi) * Math.sin(theta)
        });
    }
    gridLines.push(points);
}
for (let lng = -180; lng < 180; lng += 20) {
    const points = [];
    for (let lat = -90; lat <= 90; lat += 3) {
        const phi = (90 - lat) * Math.PI / 180;
        const theta = (lng + 180) * Math.PI / 180;
        points.push({
            x: -Math.sin(phi) * Math.cos(theta),
            y: Math.cos(phi),
            z: Math.sin(phi) * Math.sin(theta)
        });
    }
    gridLines.push(points);
}

draw();