"""Fetch pinned public samples and prepare deterministic, self-contained test GLBs.
No model, texture or third-party code is installed in the Skill bundle.
"""
import argparse,hashlib,json,posixpath,struct,urllib.parse,urllib.request
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--cache',required=True);parser.add_argument('--output',required=True);parser.add_argument('--offline',action='store_true');args=parser.parse_args()
cache=Path(args.cache);out=Path(args.output);cache.mkdir(parents=True,exist_ok=True);out.mkdir(parents=True,exist_ok=True)
lock=json.loads(Path(__file__).with_name('samples.lock.json').read_text());by_path={(r['repo'],r['path']):r for r in lock['files']}
def get(repo,path):
 row=by_path[(repo,path)];target=cache/repo/path
 if not target.exists():
  if args.offline:raise RuntimeError('Missing cached sample: '+path)
  with urllib.request.urlopen(urllib.request.Request(row['url'],headers={'User-Agent':'motion-stage-qa'}),timeout=90) as response:data=response.read(row['bytes']+1)
  if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:raise RuntimeError('Sample SHA/length changed: '+path)
  target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
 data=target.read_bytes()
 if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:raise RuntimeError('Cached sample SHA/length changed: '+path)
 return data
def pack(repo,path):
 doc=json.loads(get(repo,path));folder=posixpath.dirname(path);prefix='/'.join(path.split('/')[:2])+'/'
 def resource(uri):
  if uri.startswith('data:'):
   import base64
   return base64.b64decode(uri.split(',',1)[1])
  rel=posixpath.normpath(posixpath.join(folder,urllib.parse.unquote(uri)));assert rel.startswith(prefix);return get(repo,rel)
 blob=bytearray();mapping={};virtual=[]
 def add(data):
  while len(blob)%4:blob.extend(b'\0')
  at=len(blob);blob.extend(data);return at
 for i,b in enumerate(doc.get('buffers',[])):
  if 'uri' in b:mapping[i]=(0,add(resource(b['uri'])))
  else:mapping[i]=(len(virtual)+1,0);virtual.append(b)
 for view in doc.get('bufferViews',[]):
  original=view['buffer'];view['buffer'],shift=mapping[original];view['byteOffset']=view.get('byteOffset',0)+shift
  for name in ['EXT_meshopt_compression','KHR_meshopt_compression']:
   if name in view.get('extensions',{}):
    e=view['extensions'][name];e['buffer'],shift=mapping[e['buffer']];e['byteOffset']=e.get('byteOffset',0)+shift
 for image in doc.get('images',[]):
  if 'uri' not in image:continue
  uri=image.pop('uri');data=resource(uri);at=add(data);image['bufferView']=len(doc.setdefault('bufferViews',[]));doc['bufferViews'].append({'buffer':0,'byteOffset':at,'byteLength':len(data)});image['mimeType']=image.get('mimeType') or ('image/ktx2' if uri.lower().endswith('.ktx2') else 'image/png' if uri.lower().endswith('.png') else 'image/jpeg')
 doc['buffers']=[{'byteLength':len(blob)}]+virtual
 return encode(doc,blob)
def encode(doc,blob):
 raw=json.dumps(doc,separators=(',',':')).encode();raw+=b' '*((-len(raw))%4);blob=bytes(blob)+b'\0'*((-len(blob))%4);return struct.pack('<III',0x46546c67,2,28+len(raw)+len(blob))+struct.pack('<II',len(raw),0x4e4f534a)+raw+struct.pack('<II',len(blob),0x004e4942)+blob

for row in lock['files']:get(row['repo'],row['path'])
for case in lock['cases']:
 if case['id']=='two-foxes':continue
 data=pack(case['repo'],case['source']) if case['preparation']!='original' else get(case['repo'],case['source'])
 if hashlib.sha256(data).hexdigest()!=case['sha256']:raise RuntimeError('Prepared sample SHA changed: '+case['id'])
 (out/case['file']).write_bytes(data)
import copy
source=(out/'fox.glb').read_bytes();n=struct.unpack_from('<I',source,12)[0];d=json.loads(source[20:20+n]);bin_offset=20+n;binary=source[bin_offset+8:];node_count=len(d['nodes']);skin_count=len(d['skins']);roots=list(d['scenes'][d.get('scene',0)]['nodes']);clones=copy.deepcopy(d['nodes'])
for node in clones:
 if 'children' in node:node['children']=[i+node_count for i in node['children']]
 if 'skin' in node:node['skin']+=skin_count
for skin in copy.deepcopy(d['skins']):
 skin['joints']=[i+node_count for i in skin['joints']]
 if 'skeleton' in skin:skin['skeleton']+=node_count
 d['skins'].append(skin)
d['nodes']+=clones
for a in copy.deepcopy(d['animations']):
 a['name']='Second_'+a.get('name','Motion')
 for c in a['channels']:c['target']['node']+=node_count
 d['animations'].append(a)
newroots=[]
for label,indices,x in [('First',roots,-90),('Second',[i+node_count for i in roots],90)]:newroots.append(len(d['nodes']));d['nodes'].append({'name':label+'Fox','children':indices,'translation':[x,0,0]})
d['scenes']=[{'nodes':newroots}];d['scene']=0;d['asset']['generator']='QA composition of two unchanged authored Fox rigs';data=encode(d,binary);(out/'two-foxes.glb').write_bytes(data);
expected=next(c for c in lock['cases'] if c['id']=='two-foxes')
if hashlib.sha256(data).hexdigest()!=expected['sha256']:raise RuntimeError('Prepared multiple-rig sample SHA changed')
(out/'prepared.json').write_text(json.dumps({'version':1,'cases':lock['cases'],'sourceFiles':len(lock['files'])},indent=2)+'\n')
print(json.dumps({'samples':len(lock['cases']),'verifiedSourceFiles':len(lock['files']),'output':str(out)}))
