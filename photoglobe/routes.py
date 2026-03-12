from flask import render_template, jsonify, request, send_from_directory, send_file, current_app
from pillow_heif import register_heif_opener
from PIL import Image
import piexif
import os
import requests
import json
import glob
from . import photoglobe_bp

register_heif_opener()

SUPPORTED_EXTENSIONS = ('*.heic', '*.HEIC', '*.jpg', '*.JPG', '*.jpeg', '*.JPEG', '*.png', '*.PNG')

# ── Helpers ────────────────────────────────────────────────────────────────

def _base():
    """Absolute path to the photoglobe package folder."""
    return os.path.dirname(__file__)

def _images_dir():
    return os.path.join(_base(), 'static', 'assets', 'images')

def _thumbnails_dir():
    return os.path.join(_base(), 'static', 'assets', 'thumbnails')

def _fullsize_dir():
    return os.path.join(_base(), 'static', 'assets', 'fullsize')

def _pins_path():
    return os.path.join(_base(), 'pins.json')

# Convert raw GPS tuple from EXIF into decimal degrees
def convert_gps(value):
    degrees = value[0][0] / value[0][1]
    minutes = value[1][0] / value[1][1]
    seconds = value[2][0] / value[2][1]
    return degrees + (minutes / 60) + (seconds / 3600)

def _list_folders():
    """Return sorted list of subfolder names inside images/."""
    base = _images_dir()
    if not os.path.isdir(base):
        return []
    return sorted([d for d in os.listdir(base)
                    if os.path.isdir(os.path.join(base, d)) and not d.startswith('.')])

def _scan_images():
    """Find all supported images across all subfolders."""
    images = []
    for folder in _list_folders():
        folder_path = os.path.join(_images_dir(), folder)
        for pattern in SUPPORTED_EXTENSIONS:
            images += glob.glob(os.path.join(folder_path, pattern))
    return images

def _generate_webp(filepath, out_path, max_size=None, quality=85):
    """Convert any image to WebP and save to out_path. Returns True on success."""
    try:
        img = Image.open(filepath)
        img = img.convert('RGB')
        if max_size:
            img.thumbnail(max_size)
        else:
            # Cap long edge at 2400px — full iPhone resolution is overkill for web
            # and makes conversion 3-5x slower with no visible difference on screen
            w, h = img.size
            long_edge = max(w, h)
            if long_edge > 2400:
                scale = 2400 / long_edge
                img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        img.save(out_path, format='WEBP', quality=quality, method=2)
        return True
    except Exception as e:
        print(f'[photoglobe] WebP conversion failed for {filepath}: {e}')
        return False

# ── Startup tasks ──────────────────────────────────────────────────────────

def startup():
    """Run once when the Blueprint is first used."""
    import subprocess, threading, time, subprocess as sp
    from concurrent.futures import ThreadPoolExecutor

    print('[photoglobe] Checking for new photos...')
    subprocess.run(['python', os.path.join(_base(), 'build_pins.py')])
    print('[photoglobe] Pins ready.')

    # Remove pins whose image files no longer exist
    if os.path.exists(_pins_path()):
        with open(_pins_path(), 'r') as f:
            pins = json.load(f)
        before = len(pins)
        pins = [p for p in pins if os.path.exists(os.path.join(_images_dir(), p['filename']))]
        if len(pins) != before:
            print(f'[photoglobe] Removed {before - len(pins)} pins with missing image files')
            with open(_pins_path(), 'w') as f:
                json.dump(pins, f)

    images = _scan_images()

    # Generate small WebP thumbnails (400×400, for globe pins)
    thumb_count = 0
    for filepath in images:
        folder   = os.path.basename(os.path.dirname(filepath))
        filename = os.path.basename(filepath)
        out_path = os.path.join(_thumbnails_dir(), folder, filename + '.webp')
        if not os.path.exists(out_path):
            if _generate_webp(filepath, out_path, max_size=(400, 400), quality=80):
                thumb_count += 1
                print(f'[photoglobe] Thumbnail: {folder}/{filename}')
    print(f'[photoglobe] Thumbnails ready ({thumb_count} new)')

    # Generate full-resolution WebP in the background so startup isn't blocked
    def generate_fullsize():
        from concurrent.futures import ThreadPoolExecutor
        todo = []
        for filepath in images:
            folder   = os.path.basename(os.path.dirname(filepath))
            filename = os.path.basename(filepath)
            out_path = os.path.join(_fullsize_dir(), folder, filename + '.webp')
            if not os.path.exists(out_path):
                todo.append((filepath, out_path))

        if not todo:
            print('[photoglobe] Fullsize WebP: all up to date')
            return

        print(f'[photoglobe] Generating {len(todo)} fullsize WebP(s) in background...')
        def convert(args):
            fp, op = args
            ok = _generate_webp(fp, op, max_size=None, quality=92)
            if ok:
                name = os.path.basename(fp)
                print(f'[photoglobe] Fullsize: {name}')
            return ok

        with ThreadPoolExecutor(max_workers=6) as ex:
            results = list(ex.map(convert, todo))
        done = sum(1 for r in results if r)
        print(f'[photoglobe] Fullsize WebP done ({done}/{len(todo)})')

    threading.Thread(target=generate_fullsize, daemon=True).start()
    print(f'[photoglobe] Fullsize WebP generation started in background')

    # Background watcher — pick up new images dropped into the folder
    def watch_images():
        known = set(_scan_images())
        while True:
            time.sleep(5)
            current = set(_scan_images())
            new = current - known
            if new:
                print(f'[photoglobe] {len(new)} new photo(s) detected, rebuilding...')
                sp.run(['python', os.path.join(_base(), 'build_pins.py')])
                for filepath in new:
                    folder   = os.path.basename(os.path.dirname(filepath))
                    filename = os.path.basename(filepath)
                    # Thumbnail
                    t_path = os.path.join(_thumbnails_dir(), folder, filename + '.webp')
                    if not os.path.exists(t_path):
                        _generate_webp(filepath, t_path, max_size=(400, 400), quality=80)
                    # Fullsize
                    f_path = os.path.join(_fullsize_dir(), folder, filename + '.webp')
                    if not os.path.exists(f_path):
                        _generate_webp(filepath, f_path, max_size=None, quality=92)
                known = current

    threading.Thread(target=watch_images, daemon=True).start()

# Run startup tasks once at import time
startup()

# ── Routes ─────────────────────────────────────────────────────────────────

@photoglobe_bp.route('/')
def index():
    return render_template('photoglobe/index.html')

@photoglobe_bp.route('/folders')
def folders():
    return jsonify(_list_folders())

@photoglobe_bp.route('/pins')
def pins():
    with open(_pins_path(), 'r') as f:
        data = json.load(f)
    folder = request.args.get('folder', '')
    if folder:
        data = [p for p in data if p.get('folder') == folder]
    for pin in data:
        pin['img'] = f'/photoglobe/photo/{pin["filename"]}'
    return jsonify(data)

@photoglobe_bp.route('/geocode')
def geocode():
    lat = request.args.get('lat')
    lng = request.args.get('lng')
    try:
        url = f'https://photon.komoot.io/reverse?lat={lat}&lon={lng}'
        response = requests.get(url, timeout=5)
        return response.json()
    except:
        return jsonify({})

# Serve pre-generated full-resolution WebP for the lightbox.
# Falls back to on-the-fly JPEG conversion if the WebP hasn't been generated yet.
@photoglobe_bp.route('/fullsize/<path:filepath>')
def fullsize(filepath):
    # Strip a trailing .webp if the JS sends filename.heic.webp style
    webp_path = os.path.join(_fullsize_dir(), filepath + '.webp')
    if os.path.exists(webp_path):
        return send_file(webp_path, mimetype='image/webp')
    # Fallback: generate on the fly (first request only, then cached next startup)
    return photo(filepath)

# Serve photo — JPEG/PNG served directly, HEIC converted to JPEG on the fly.
# Still used as a fallback; prefer /fullsize/ for the lightbox.
@photoglobe_bp.route('/photo/<path:filepath>')
def photo(filepath):
    full_path = os.path.join(_images_dir(), filepath)
    if not os.path.exists(full_path):
        return 'Photo not found', 404

    ext = os.path.splitext(filepath)[1].lower()

    if ext in ('.jpg', '.jpeg'):
        return send_file(full_path, mimetype='image/jpeg')
    if ext == '.png':
        return send_file(full_path, mimetype='image/png')

    from io import BytesIO
    img = Image.open(full_path)
    img = img.convert('RGB')
    buf = BytesIO()
    img.save(buf, format='JPEG', quality=85)
    buf.seek(0)
    return send_file(buf, mimetype='image/jpeg')

# Serve pre-generated WebP thumbnail, falling back to full photo if missing
@photoglobe_bp.route('/thumbnail/<path:filepath>')
def thumbnail(filepath):
    thumb_path = os.path.join(_thumbnails_dir(), filepath)
    if not os.path.exists(thumb_path):
        original_filepath = filepath.replace('.webp', '')
        return photo(original_filepath)
    return send_file(thumb_path, mimetype='image/webp')