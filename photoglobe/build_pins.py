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

def is_spatial_heic(filepath):
    """Detect Apple spatial photos by counting thumbnail references in the HEIC container.
    Normal HEICs (including Portrait depth-map photos) have exactly 1 thumbnail item.
    Apple spatial HEICs always have 3 (left eye, right eye, combined stereo).
    Works on any file type — non-HEIC files just won't contain 'thmb' and return False."""
    try:
        with open(filepath, 'rb') as f:
            # Spatial marker is always in the first ~4KB (box header section)
            header = f.read(4096)
        return header.count(b'thmb') >= 3
    except Exception:
        return False


def extract_exif(filepath):
    """Extract GPS coords, datetime, and spatial status. Returns None if no GPS."""
    img = Image.open(filepath)

    is_spatial = is_spatial_heic(filepath)

    exif_bytes = img.info.get('exif')
    if not exif_bytes:
        return None

    try:
        exif = piexif.load(exif_bytes)
    except Exception:
        return None

    gps = exif.get('GPS', {})
    # If no GPS coordinates, we return None to skip this pin
    if 2 not in gps or 4 not in gps:
        return None

    info = {
        'lat': convert_gps(gps[2]) * (-1 if gps.get(1) == b'S' else 1),
        'lng': convert_gps(gps[4]) * (-1 if gps.get(3) == b'W' else 1),
        'is_spatial': is_spatial
    }

    # Extract Datetime if available
    exif_ifd = exif.get('Exif', {})
    if 36867 in exif_ifd:
        try:
            dt_str = exif_ifd[36867].decode('utf-8')
            info['datetime'] = dt_str.replace(':', '-', 2)[:16]
        except:
            pass

    return info

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
            
            # Use a custom User-Agent as required by Nominatim's Policy
            r = requests.get(url, headers={'User-Agent': 'PhotoGlobe-Project-Student'}, timeout=10)
            
            if r.status_code != 200:
                print(f"Error {relative}: Server returned status {r.status_code}. Waiting 5 seconds...")
                time.sleep(5)
                continue

            data = r.json()
            address = data.get('address', {})
            
            name = (address.get('city') or address.get('town') or
                    address.get('village') or address.get('county') or
                    address.get('state') or 'Unknown')
            country = address.get('country', '')
            
            pin = {
                'filename': relative,
                'folder': folder,
                'lat': round(lat, 4),
                'lng': round(lng, 4),
                'name': f'{name}, {country}',
                'is_spatial': info.get('is_spatial', False)
            }
            
            if 'datetime' in info:
                pin['datetime'] = info['datetime']
                
            results.append(pin)
            print(f'{relative} -> {name}, {country}')
            
            # Nominatim requires absolute minimum 1s, but 1.5s is safer for batches
            time.sleep(1.5) 
            
        except Exception as e:
            print(f'Error {relative}: {e}')

with open(PINS_PATH, 'w') as out:
    json.dump(results, out)
print('Done')