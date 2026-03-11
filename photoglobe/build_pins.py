import requests, json, os, time
from pillow_heif import register_heif_opener
from PIL import Image
import piexif

register_heif_opener()

# Paths are relative to this file's location inside the photoglobe package
BASE = os.path.dirname(os.path.abspath(__file__))
IMAGES_DIR = os.path.join(BASE, 'static', 'assets', 'images')
PINS_PATH  = os.path.join(BASE, 'pins.json')

def convert_gps(v):
    return v[0][0]/v[0][1] + v[1][0]/v[1][1]/60 + v[2][0]/v[2][1]/3600

# Load existing pins.json if it exists so we don't re-geocode
if os.path.exists(PINS_PATH):
    with open(PINS_PATH, 'r') as f:
        existing = json.load(f)
    already_done = {pin['filename'] for pin in existing}
else:
    existing = []
    already_done = set()

results = list(existing)

for f in os.listdir(IMAGES_DIR):
    if f.lower().endswith('.heic'):
        # Skip if already in pins.json
        if f in already_done:
            print(f'{f} -> already processed, skipping')
            continue
        try:
            img = Image.open(os.path.join(IMAGES_DIR, f))
            gps = piexif.load(img.info['exif']).get('GPS', {})
            lat = convert_gps(gps[2]) * (-1 if gps[1] == b'S' else 1)
            lng = convert_gps(gps[4]) * (-1 if gps[3] == b'W' else 1)
            url = f'https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lng}&format=json'
            r = requests.get(url, headers={'User-Agent': 'depthmap/1.0'}, timeout=10)
            address = r.json().get('address', {})
            name = (address.get('city') or address.get('town') or
                    address.get('village') or address.get('county') or
                    address.get('state') or 'Unknown')
            country = address.get('country', '')
            results.append({
                'filename': f,
                'lat': round(lat, 4),
                'lng': round(lng, 4),
                'name': f'{name}, {country}'
            })
            print(f'{f} -> {name}, {country}')
            time.sleep(1)
        except Exception as e:
            print(f'Error {f}: {e}')

with open(PINS_PATH, 'w') as out:
    json.dump(results, out)
print('Done')