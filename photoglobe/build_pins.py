import requests, json, os, time, glob
from pillow_heif import register_heif_opener
from PIL import Image
import piexif

register_heif_opener()

# Paths are relative to this file's location inside the photoglobe package
BASE = os.path.dirname(os.path.abspath(__file__))
IMAGES_DIR = os.path.join(BASE, 'static', 'assets', 'images')
PINS_PATH  = os.path.join(BASE, 'pins.json')

SUPPORTED_EXTENSIONS = ('.heic', '.jpg', '.jpeg', '.png')

def convert_gps(v):
    return v[0][0]/v[0][1] + v[1][0]/v[1][1]/60 + v[2][0]/v[2][1]/3600

def is_spatial_photo(filepath):
    """
    Detect Apple spatial photos / videos.

    Apple spatial photos (iPhone 15 Pro+) are HEIC files that contain a
    secondary 'right-eye' image stored as XMP GImage data.  The XMP block
    always includes the string 'GImage:Data' when this secondary image is
    present.  We scan the first 64 KB of the file for this marker — fast
    and doesn't require a full decode.

    Side-by-side or over-under stereo JPEGs (width == 2×height or vice-versa)
    are also flagged, though Apple doesn't use that format.
    """
    try:
        # Fast byte-scan for the Apple spatial XMP marker
        with open(filepath, 'rb') as fh:
            header = fh.read(65536)
        if b'GImage:Data' in header or b'GDepth:Data' in header:
            return True

        # Fallback: classic side-by-side / over-under stereo pair dimensions
        img = Image.open(filepath)
        w, h = img.size
        if (w == 2 * h) or (h == 2 * w):
            return True
    except Exception:
        pass
    return False

def extract_exif(filepath):
    """Extract GPS coords, datetime, and spatial status. Returns None if no GPS."""
    img = Image.open(filepath)

    exif_bytes = img.info.get('exif')
    if not exif_bytes:
        return None

    try:
        exif = piexif.load(exif_bytes)
    except Exception:
        return None

    gps = exif.get('GPS', {})
    if 2 not in gps or 4 not in gps:
        return None

    info = {
        'lat': convert_gps(gps[2]) * (-1 if gps.get(1) == b'S' else 1),
        'lng': convert_gps(gps[4]) * (-1 if gps.get(3) == b'W' else 1),
        'is_spatial': is_spatial_photo(filepath),
    }

    exif_ifd = exif.get('Exif', {})
    if 36867 in exif_ifd:
        try:
            dt_str = exif_ifd[36867].decode('utf-8')
            info['datetime'] = dt_str.replace(':', '-', 2)[:16]
        except Exception:
            pass

    return info

# ── Load existing pins so we can skip re-geocoding ────────────────────────
if os.path.exists(PINS_PATH):
    with open(PINS_PATH, 'r') as f:
        existing = json.load(f)
    existing_map = {pin['filename']: pin for pin in existing}
else:
    existing_map = {}

results = []

# ── Scan subfolders inside images/ ────────────────────────────────────────
for folder in sorted(os.listdir(IMAGES_DIR)):
    folder_path = os.path.join(IMAGES_DIR, folder)
    if not os.path.isdir(folder_path) or folder.startswith('.'):
        continue

    for f in os.listdir(folder_path):
        if not f.lower().endswith(SUPPORTED_EXTENSIONS):
            continue

        relative = f'{folder}/{f}'
        full_path = os.path.join(folder_path, f)

        if relative in existing_map:
            pin = existing_map[relative]
            # Always re-evaluate is_spatial so fixes to the detector take effect
            pin['is_spatial'] = is_spatial_photo(full_path)
            results.append(pin)
            print(f'{relative} -> already geocoded, spatial={pin["is_spatial"]}')
            continue

        try:
            info = extract_exif(full_path)
            if info is None:
                print(f'{relative} -> no GPS data, skipping')
                continue

            lat, lng = info['lat'], info['lng']
            url = f'https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lng}&format=json'
            r = requests.get(url, headers={'User-Agent': 'PhotoGlobe-Project-Student'}, timeout=10)

            if r.status_code != 200:
                print(f'Error {relative}: server returned {r.status_code}. Waiting 5s...')
                time.sleep(5)
                continue

            data    = r.json()
            address = data.get('address', {})
            name    = (address.get('city') or address.get('town') or
                       address.get('village') or address.get('county') or
                       address.get('state') or 'Unknown')
            country = address.get('country', '')

            pin = {
                'filename':   relative,
                'folder':     folder,
                'lat':        round(lat, 4),
                'lng':        round(lng, 4),
                'name':       f'{name}, {country}',
                'is_spatial': info['is_spatial'],
            }
            if 'datetime' in info:
                pin['datetime'] = info['datetime']

            results.append(pin)
            print(f'{relative} -> {name}, {country} (spatial={pin["is_spatial"]})')
            time.sleep(1.5)   # Nominatim rate-limit

        except Exception as e:
            print(f'Error {relative}: {e}')

with open(PINS_PATH, 'w') as out:
    json.dump(results, out, indent=2)
print(f'Done — {len(results)} pins written.')