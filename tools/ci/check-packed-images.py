"""Fresh-open the saved native file and report its actual packed image bytes."""
import hashlib
import json
from pathlib import Path
import sys
import bpy

args = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=str(Path(args[0]).absolute()))
images = []
for image in bpy.data.images:
    if image.type == 'IMAGE' and image.packed_file:
        images.append({'name': image.name, 'sha256': hashlib.sha256(bytes(image.packed_file.data)).hexdigest(),
                       'bytes': len(image.packed_file.data), 'size': list(image.size), 'filepath': image.filepath})
Path(args[1]).write_text(json.dumps({'blenderVersion': bpy.app.version_string, 'images': images}, indent=2) + '\n', encoding='utf-8')
