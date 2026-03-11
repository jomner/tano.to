from pillow_heif import register_heif_opener
from PIL import Image
import piexif

register_heif_opener()

# Replace with your actual filename
img = Image.open('images/IMG_9629.heic')
exif_data = piexif.load(img.info['exif'])
gps = exif_data.get('GPS', {})
print(gps)

def convert_gps(value):
    degrees = value[0][0] / value[0][1]
    minutes = value[1][0] / value[1][1]
    seconds = value[2][0] / value[2][1]
    return degrees + (minutes / 60) + (seconds / 3600)

lat = convert_gps(gps[2])
lng = convert_gps(gps[4])

if gps[1] == b'S': lat = -lat
if gps[3] == b'W': lng = -lng

print(f'Lat: {lat}, Lng: {lng}')

# Replace `YOUR_FILE.heic` with one of your actual filenames and run:
# python inspect.py