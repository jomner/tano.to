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

def extract_exif(filepath):
    """Extract GPS coords and datetime from an image.
    Returns dict with 'lat', 'lng', and optionally 'datetime', or None if no GPS."""
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

    lat = convert_gps(gps[2]) * (-1 if gps.get(1) == b'S' else 1)
    lng = convert_gps(gps[4]) * (-1 if gps.get(3) == b'W' else 1)

    result = {'lat': lat, 'lng': lng}

    # Try to get DateTimeOriginal (tag 36867), fall back to DateTime (tag 306)
    exif_ifd = exif.get('Exif', {})
    dt_raw = exif_ifd.get(piexif.ExifIFD.DateTimeOriginal) or \
             exif_ifd.get(piexif.ExifIFD.DateTimeDigitized) or \
             exif.get('0th', {}).get(piexif.ImageIFD.DateTime)
    if dt_raw:
        try:
            # EXIF datetime is bytes like b'2024:03:15 14:30:00'
            dt_str = dt_raw.decode('utf-8') if isinstance(dt_raw, bytes) else str(dt_raw)
            # Reformat from "2024:03:15 14:30:00" to "Mar 15, 2024 2:30 PM"
            from datetime import datetime
            dt = datetime.strptime(dt_str, '%Y:%m:%d %H:%M:%S')
            result['datetime'] = dt.strftime('%b %-d, %Y %-I:%M %p')
        except Exception:
            pass

    return result

# Load existing pins.json if it exists so we don't re-geocode
if os.path.exists(PINS_PATH):
    with open(PINS_PATH, 'r') as f:
        existing = json.load(f)
    already_done = {pin['filename'] for pin in existing}
else:
    existing = []
    already_done = set()

results = list(existing)

# Scan subfolders inside images/
for folder in sorted(os.listdir(IMAGES_DIR)):
    folder_path = os.path.join(IMAGES_DIR, folder)
    if not os.path.isdir(folder_path) or folder.startswith('.'):
        continue

    for f in os.listdir(folder_path):
        if not f.lower().endswith(SUPPORTED_EXTENSIONS):
            continue

        # filename includes the folder prefix: "Roan/IMG_001.HEIC"
        relative = f'{folder}/{f}'

        if relative in already_done:
            print(f'{relative} -> already processed, skipping')
            continue

        try:
            info = extract_exif(os.path.join(folder_path, f))
            if info is None:
                print(f'{relative} -> no GPS data, skipping')
                continue

            lat, lng = info['lat'], info['lng']
            url = f'https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lng}&format=json'
            r = requests.get(url, headers={'User-Agent': 'depthmap/1.0'}, timeout=10)
            address = r.json().get('address', {})
            name = (address.get('city') or address.get('town') or
                    address.get('village') or address.get('county') or
                    address.get('state') or 'Unknown')
            country = address.get('country', '')
            pin = {
                'filename': relative,
                'folder': folder,
                'lat': round(lat, 4),
                'lng': round(lng, 4),
                'name': f'{name}, {country}'
            }
            if 'datetime' in info:
                pin['datetime'] = info['datetime']
            results.append(pin)
            print(f'{relative} -> {name}, {country}')
            time.sleep(1)
        except Exception as e:
            print(f'Error {relative}: {e}')

with open(PINS_PATH, 'w') as out:
    json.dump(results, out)
print('Done')