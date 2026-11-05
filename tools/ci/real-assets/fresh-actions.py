"""Read the saved native snapshot in a new Blender process."""
import bpy,json,sys
from pathlib import Path
blend=Path(sys.argv[sys.argv.index('--')+1]);output=Path(sys.argv[sys.argv.index('--')+2]);bpy.ops.wm.open_mainfile(filepath=str(blend));output.write_text(json.dumps({'actions':[a.name for a in bpy.data.actions]},indent=2)+'\n')
