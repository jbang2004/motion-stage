import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {KTX2Loader} from 'three/addons/loaders/KTX2Loader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';

// One decoder configuration for the studio and real-asset acceptance tests.
export function createModelLoader(renderer,{lazyAnimations=false}={}){
 const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
 loader.setDRACOLoader(new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/'));
 if(renderer)loader.setKTX2Loader(new KTX2Loader().setTranscoderPath('/vendor/three/examples/jsm/libs/basis/').detectSupport(renderer));
 if(lazyAnimations)loader.register(parser=>({
  name:'MotionStageLazyAnimations',
  beforeRoot(){
   const dependencies=parser.getDependencies.bind(parser);
   parser.getDependencies=type=>type==='animation'?Promise.resolve([]):dependencies(type);
  }
 }));
 return loader;
}
