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

# ── Startup tasks ──────────────────────────────────────────────────────────

def startup():
    """Run once when the Blueprint is first used: build pins, clean missing, generate thumbnails."""
    import subprocess

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

    # Generate WebP thumbnails for images in subfolders
    os.makedirs(_thumbnails_dir(), exist_ok=True)
    images = _scan_images()
    count = 0
    for filepath in images:
        folder = os.path.basename(os.path.dirname(filepath))
        filename = os.path.basename(filepath)
        thumb_dir = os.path.join(_thumbnails_dir(), folder)
        os.makedirs(thumb_dir, exist_ok=True)
        thumb_path = os.path.join(thumb_dir, filename + '.webp')
        if not os.path.exists(thumb_path):
            try:
                img = Image.open(filepath)
                img = img.convert('RGB')
                img.thumbnail((400, 400))
                img.save(thumb_path, format='WEBP', quality=80)
                count += 1
                print(f'[photoglobe] Generated thumbnail: {folder}/{filename}')
            except Exception as e:
                print(f'[photoglobe] Failed thumbnail for {folder}/{filename}: {e}')
    print(f'[photoglobe] Thumbnails ready ({count} new)')

    # Start background watcher for new images
    import threading, time, subprocess as sp
    def watch_images():
        known = set(_scan_images())
        while True:
            time.sleep(5)
            current = set(_scan_images())
            if current != known:
                print(f'[photoglobe] New photos detected, rebuilding pins...')
                sp.run(['python', os.path.join(_base(), 'build_pins.py')])
                known = current

    threading.Thread(target=watch_images, daemon=True).start()

# Run startup tasks once at import time
startup()

# ── Routes ─────────────────────────────────────────────────────────────────

# Serve the main Photoglobe page
@photoglobe_bp.route('/')
def index():
    return render_template('photoglobe/index.html')

# Return list of available folders
@photoglobe_bp.route('/folders')
def folders():
    return jsonify(_list_folders())

# Serve pins from pins.json, optionally filtered by folder
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

# Proxy reverse geocoding to avoid CORS issues in the browser
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

# Serve photo — JPEG/PNG served directly, HEIC converted to JPEG on the fly
@photoglobe_bp.route('/photo/<path:filepath>')
def photo(filepath):
    full_path = os.path.join(_images_dir(), filepath)
    if not os.path.exists(full_path):
        return 'Photo not found', 404

    ext = os.path.splitext(filepath)[1].lower()

    # JPEG and PNG can be served directly without conversion
    if ext in ('.jpg', '.jpeg'):
        return send_file(full_path, mimetype='image/jpeg')
    if ext == '.png':
        return send_file(full_path, mimetype='image/png')

    # HEIC (and anything else) gets converted to JPEG
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