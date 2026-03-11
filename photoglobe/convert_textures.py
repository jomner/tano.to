from PIL import Image
import os

textures = [
    '2k_earth_specular_map.tif',
    '2k_earth_normal_map.tif',

]

for filename in textures:
    filepath = os.path.join('assets', 'Earth', filename)
    if not os.path.exists(filepath):
        print(f'Not found: {filepath}')
        continue
    img = Image.open(filepath)
    img = img.convert('RGB')
    out_name = filename.replace('.tif', '.webp')
    out_path = os.path.join('assets', 'Earth', out_name)
    img.save(out_path, format='WEBP', quality=90)
    print(f'Converted: {out_name}')

print('Done.')