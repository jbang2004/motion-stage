from pathlib import Path
import json, hashlib, zipfile, datetime
project=Path(__file__).resolve().parents[1]
src=project/'skill'
out=project
version=json.loads((src/'package.json').read_text(encoding='utf-8'))['version']
def include(p):
    return p.name not in ('bundle-manifest.json','.DS_Store') and not any(x in ('__pycache__','.pytest_cache','node_modules','.git') for x in p.relative_to(src).parts) and p.suffix not in ('.pyc','.pyo')
rows=[]
for p in sorted(src.rglob('*')):
    if p.is_symlink(): raise RuntimeError('Bundle must not contain symlinks')
    if p.is_file() and include(p):
        rows.append({'path':p.relative_to(src).as_posix(),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
manifest={'name':'motion-stage','version':version,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtime':'Node.js >=22 / Canvas2D curves; WebGL2 spatial previews','externalRuntimeDependencies':{'base':[],'optional':{'fbx':'Blender >=4.2 installed locally','automaticAgent':'Codex CLI installed and authenticated; uses configured model/account'}},'files':rows}
(src/'bundle-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
archive=out/'dist'/f'motion-stage-v{version}.zip'
archive.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in sorted(src.rglob('*')):
        if p.is_file() and (include(p) or p.name=='bundle-manifest.json'):
            item=zipfile.ZipInfo.from_file(p,'motion-stage/'+p.relative_to(src).as_posix())
            # A bundle built on Windows must retain the macOS launcher bit too.
            item.create_system=3
            item.external_attr=(0o100755 if p.suffix=='.command' else 0o100644)<<16
            z.writestr(item,p.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
release={'version':version,'archive':str(archive.relative_to(project)),'archiveBytes':archive.stat().st_size,'archiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'files':len(rows)+1,'unpackedBytes':sum(x['bytes'] for x in rows)+(src/'bundle-manifest.json').stat().st_size}
(out/'release.json').write_text(json.dumps(release,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(release,ensure_ascii=False))
