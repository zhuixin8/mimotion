import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {avatarState} from './avatar-state.js';

export function createAvatar() {
  const card=document.createElement('article');
  card.className='card virtual-athlete';
  card.innerHTML='<div class="athlete-copy"><span class="section-kicker">我的虚拟运动员</span><h2 data-athlete-title></h2><p data-athlete-detail></p><small>动画仅展示计划状态，不代表实际运动或微信同步结果。</small><button type="button" class="text-button athlete-toggle" aria-pressed="false">暂停动画</button></div><div class="athlete-stage" aria-hidden="true"><span class="athlete-fallback">人物加载中…</span></div>';
  const stage=card.querySelector('.athlete-stage'),fallback=card.querySelector('.athlete-fallback'),button=card.querySelector('button');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let paused=false;
  try {paused=localStorage.getItem('qingbu-avatar-paused')==='1';} catch {}
  let renderer,scene,camera,mixer,active,observer,environment,loaded=false,failed=false,visible=false,intersecting=false,disposed=false,frame=0,previous=0,model;
  let snapshot={account:null,runtime:null,receivedAt:0},presentation=avatarState(null),actions={};
  function cancel(){if(frame)cancelAnimationFrame(frame);frame=0;previous=0;}
  function canDraw(){return loaded&&visible&&intersecting&&!document.hidden&&!disposed;}
  function draw(){if(canDraw())renderer.render(scene,camera);}
  function animate(time){frame=0;if(!canDraw())return;const elapsed=previous?time-previous:0;if(!previous||elapsed>=1000/30){mixer.update(Math.min(elapsed/1000,.06));previous=time;draw();}frame=requestAnimationFrame(animate);}
  function restart(){cancel();draw();if(canDraw()&&!paused&&!reduced.matches)frame=requestAnimationFrame(animate);}
  function controls(){button.textContent=reduced.matches?'系统已减少动态效果':paused?'播放动画':'暂停动画';button.setAttribute('aria-pressed',String(paused||reduced.matches));button.disabled=reduced.matches||failed;}
  function apply(){
    const p=avatarState(snapshot.account,snapshot.runtime,snapshot.receivedAt),changed=p.motion!==presentation.motion;presentation=p;
    card.dataset.motion=p.motion;card.querySelector('[data-athlete-title]').textContent=p.title;card.querySelector('[data-athlete-detail]').textContent=p.detail;
    const next=actions[p.motion];
    if(next&&next!==active){next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();if(active)next.crossFadeFrom(active,.45,true);active=next;if(paused||reduced.matches)mixer.update(.5);}
    controls();if(changed||!frame)restart();
  }
  button.addEventListener('click',()=>{paused=!paused;try{localStorage.setItem('qingbu-avatar-paused',paused?'1':'0');}catch{}controls();restart();});
  const visibility=()=>restart();document.addEventListener('visibilitychange',visibility);
  const motionPreference=()=>{controls();if(loaded)mixer.update(.5);restart();};reduced.addEventListener('change',motionPreference);
  const intersection=new IntersectionObserver(entries=>{intersecting=entries[0].isIntersecting;restart();});intersection.observe(card);
  function dispose(){disposed=true;cancel();intersection.disconnect();observer?.disconnect();document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',motionPreference);window.removeEventListener('pagehide',pagehide);window.removeEventListener('pageshow',visibility);mixer?.stopAllAction();scene?.traverse(o=>{if(o.isMesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material]){m.map?.dispose();m.dispose();}}});environment?.dispose();renderer?.dispose();}
  const pagehide=e=>{if(!e.persisted)dispose();else cancel();};window.addEventListener('pagehide',pagehide);window.addEventListener('pageshow',visibility);
  async function initialize(){
    try{
      renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.domElement.setAttribute('aria-hidden','true');stage.append(renderer.domElement);
      renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();failed=true;loaded=false;cancel();fallback.hidden=false;fallback.textContent='动画暂不可用，计划正常运行';controls();});
      scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(32,1,.1,50);camera.position.set(Math.sin(.68)*3.7,1.2,Math.cos(.68)*3.7);camera.lookAt(0,.88,0);
      const room=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(renderer);environment=pmrem.fromScene(room,.04);scene.environment=environment.texture;scene.environmentIntensity=.75;room.dispose();pmrem.dispose();
      scene.add(new THREE.HemisphereLight(0xfff5ed,0x7888a8,1.4));const sun=new THREE.DirectionalLight(0xffffff,2.2);sun.position.set(3,6,4);sun.castShadow=true;sun.shadow.mapSize.set(512,512);Object.assign(sun.shadow.camera,{left:-2,right:2,top:3,bottom:-2});sun.shadow.normalBias=.035;sun.shadow.bias=-.0003;scene.add(sun);
      const rim=new THREE.DirectionalLight(0xc3d6ff,.8);rim.position.set(-3,2,-3);scene.add(rim);
      const ground=new THREE.Mesh(new THREE.PlaneGeometry(12,12),new THREE.ShadowMaterial({opacity:.15}));ground.rotation.x=-Math.PI/2;ground.position.y=-.005;ground.receiveShadow=true;scene.add(ground);
      const response=await fetch('/athlete-model-v1.glb.gz',{credentials:'omit',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('model');
      const bytes=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const gltf=await new GLTFLoader().parseAsync(bytes,'');if(disposed)return;
      model=gltf.scene;const bounds=new THREE.Box3().setFromObject(model),scale=1.78/bounds.getSize(new THREE.Vector3()).y;model.scale.multiplyScalar(scale);model.position.y=-bounds.min.y*scale;
      model.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;o.material.metalness=0;o.material.roughness=.85;}});scene.add(model);mixer=new THREE.AnimationMixer(model);for(const clip of gltf.animations)actions[clip.name]=mixer.clipAction(clip);
      const resize=()=>{const w=stage.clientWidth,h=stage.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();draw();};observer=new ResizeObserver(resize);observer.observe(stage);loaded=true;fallback.hidden=true;resize();apply();
    }catch{failed=true;cancel();fallback.hidden=false;fallback.textContent='动画暂不可用，计划正常运行';controls();renderer?.dispose();}
  }
  return {update(account,runtime,receivedAt,mount){snapshot={account,runtime,receivedAt};const moved=visible!==!!mount||!!mount&&card.parentElement!==mount;visible=!!mount;if(mount&&card.parentElement!==mount)mount.append(card);card.hidden=!visible;apply();if(moved)restart();if(!loaded&&!failed&&!renderer&&visible)void initialize();},dispose};
}
