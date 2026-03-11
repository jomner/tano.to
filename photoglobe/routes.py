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

    # Generate WebP thumbnails for any HEIC images that don't have one yet
    os.makedirs(_thumbnails_dir(), exist_ok=True)
    images = glob.glob(os.path.join(_images_dir(), '*.HEIC')) + \
             glob.glob(os.path.join(_images_dir(), '*.heic'))
    count = 0
    for filepath in images:
        filename = os.path.basename(filepath)
        thumb_path = os.path.join(_thumbnails_dir(), filename + '.webp')
        if not os.path.exists(thumb_path):
            try:
                img = Image.open(filepath)
                img = img.convert('RGB')
                img.thumbnail((400, 400))
                img.save(thumb_path, format='WEBP', quality=80)
                count += 1
                print(f'[photoglobe] Generated thumbnail: {filename}')
            except Exception as e:
                print(f'[photoglobe] Failed thumbnail for {filename}: {e}')
    print(f'[photoglobe] Thumbnails ready ({count} new)')

    # Start background watcher for new images
    import threading, time, subprocess as sp
    def watch_images():
        known = set(glob.glob(os.path.join(_images_dir(), '*.HEIC')) +
                    glob.glob(os.path.join(_images_dir(), '*.heic')))
        while True:
            time.sleep(5)
            current = set(glob.glob(os.path.join(_images_dir(), '*.HEIC')) +
                          glob.glob(os.path.join(_images_dir(), '*.heic')))
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

# Serve pins from pins.json, with image paths pointing to the /photoglobe/photo/ route
@photoglobe_bp.route('/pins')
def pins():
    with open(_pins_path(), 'r') as f:
        data = json.load(f)
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

# Convert HEIC to JPEG on the fly and serve it
@photoglobe_bp.route('/photo/<filename>')
def photo(filename):
    from io import BytesIO
    filepath = os.path.join(_images_dir(), filename)
    if not os.path.exists(filepath):
        return 'Photo not found', 404
    img = Image.open(filepath)
    img = img.convert('RGB')
    buf = BytesIO()
    img.save(buf, format='JPEG', quality=85)
    buf.seek(0)
    return send_file(buf, mimetype='image/jpeg')

# Serve pre-generated WebP thumbnail, falling back to full photo if missing
@photoglobe_bp.route('/thumbnail/<filename>')
def thumbnail(filename):
    thumb_path = os.path.join(_thumbnails_dir(), filename)
    if not os.path.exists(thumb_path):
        # Strip .webp to get original filename and fall back to full photo
        original_filename = filename.replace('.webp', '')
        return photo(original_filename)
    return send_from_directory(_thumbnails_dir(), filename)