import * as THREE from 'three';
import {
  clipsForFighter,
  ANIMATION_POOLS,
  loadFbx,
  prepareFighterModel,
  type FighterSpec,
} from './fighter-assets';

export class FighterActor {
  readonly root = new THREE.Group();
  readonly mixer: THREE.AnimationMixer;
  private current: THREE.AnimationAction | null = null;
  private currentId = 'idle';
  private returnToPose = true;
  private lastVariant = new Map<string, string>();
  private readonly baseModelY: number;
  private floorLocked = false;
  private floorLockRemaining = 0;
  private readonly floorPoint = new THREE.Vector3();

  private constructor(
    readonly model: THREE.Group,
    private readonly clips: Map<string, THREE.AnimationClip>,
  ) {
    this.root.add(model);
    this.baseModelY = model.position.y;
    this.mixer = new THREE.AnimationMixer(model);
    this.mixer.addEventListener('finished', event => {
      if (event.action === this.current && this.returnToPose && this.currentId !== 'idle') this.play('idle', { loop: true, fade: 0.12 });
    });
    this.play('idle', { loop: true, fade: 0 });
  }

  static async load(
    spec: FighterSpec,
    sources: ReadonlyMap<string, THREE.AnimationClip>,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<FighterActor> {
    const model = await loadFbx(spec.file, onProgress, signal);
    prepareFighterModel(model);
    return new FighterActor(model, clipsForFighter(model, sources, spec.embeddedIdle === true));
  }

  static fallback(color: string, fighterId = 'fighter'): FighterActor {
    const model = new THREE.Group();
    const mainColor = new THREE.Color(color);
    const suit = new THREE.MeshStandardMaterial({ color: mainColor, roughness: .56, metalness: .28 });
    const armor = new THREE.MeshStandardMaterial({ color: mainColor.clone().multiplyScalar(.46), roughness: .35, metalness: .72 });
    const trim = new THREE.MeshStandardMaterial({ color: mainColor.clone().lerp(new THREE.Color(0xffffff), .58), roughness: .3, metalness: .65 });
    const shadow = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: .75, metalness: .12 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xb99479, roughness: .82 });
    const part = (geometry:THREE.BufferGeometry, material:THREE.Material, x:number,y:number,z:number, parent:THREE.Group=model) => {
      const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,y,z);parent.add(mesh);return mesh;
    };
    const torso=part(new THREE.CapsuleGeometry(.36,.57,5,10),suit,0,1.35,0);torso.name='torso';
    part(new THREE.BoxGeometry(.72,.44,.13),armor,0,1.48,.26);
    part(new THREE.BoxGeometry(.46,.12,.17),trim,0,1.45,.34);
    part(new THREE.CylinderGeometry(.29,.32,.17,10),shadow,0,.91,0);
    part(new THREE.BoxGeometry(.75,.12,.32),trim,0,.87,.03);
    const head=part(new THREE.SphereGeometry(.29,12,10),skin,0,2.04,.015);head.name='head';
    part(new THREE.BoxGeometry(.62,.19,.47),armor,0,2.2,.015);
    part(new THREE.BoxGeometry(.47,.11,.07),shadow,0,2.075,.278);
    part(new THREE.BoxGeometry(.34,.035,.08),trim,0,2.09,.323);
    const emblem=part(new THREE.OctahedronGeometry(.13,0),trim,0,1.47,.38);
    emblem.rotation.z=Math.PI/4;
    const variant=[...fighterId].reduce((value,char)=>value+char.charCodeAt(0),0)%3;
    if(variant===0){
      part(new THREE.ConeGeometry(.13,.35,6),trim,0,2.48,-.05);
    }else if(variant===1){
      for(const side of [-1,1]){
        const horn=part(new THREE.ConeGeometry(.09,.28,5),trim,side*.27,2.42,-.02);
        horn.rotation.z=side*.38;
      }
    }else{
      part(new THREE.BoxGeometry(.5,.1,.17),trim,0,2.35,-.06);
    }
    for(const side of [-1,1]){
      part(new THREE.SphereGeometry(.18,9,7),armor,side*.54,1.7,0);
      const arm=new THREE.Group();arm.name=side<0?'leftArm':'rightArm';arm.position.set(side*.54,1.64,0);model.add(arm);
      part(new THREE.CylinderGeometry(.12,.1,.52,8),suit,side*.02,-.31,0,arm);
      part(new THREE.SphereGeometry(.14,9,7),armor,side*.03,-.57,.035,arm);
      part(new THREE.BoxGeometry(.24,.21,.28),trim,side*.03,-.68,.08,arm);
      const leg=new THREE.Group();leg.name=side<0?'leftLeg':'rightLeg';leg.position.set(side*.22,.81,0);model.add(leg);
      part(new THREE.CylinderGeometry(.16,.13,.67,8),armor,0,-.35,0,leg);
      part(new THREE.SphereGeometry(.16,8,6),trim,0,-.65,.06,leg);
      part(new THREE.BoxGeometry(.28,.2,.48),shadow,0,-.75,.14,leg);
    }
    const track=(node:string,axis:'x'|'y'|'z',times:number[],values:number[])=>
      new THREE.NumberKeyframeTrack(`${node}.rotation[${axis}]`,times,values);
    const clips=new Map<string,THREE.AnimationClip>([
      ['idle',new THREE.AnimationClip('idle',1.1,[
        track('leftArm','z',[0,.55,1.1],[0,.08,0]),track('rightArm','z',[0,.55,1.1],[0,-.08,0]),
      ])],
      ['walk',new THREE.AnimationClip('walk',.7,[
        track('leftLeg','x',[0,.18,.35,.52,.7],[.38,0,-.38,0,.38]),
        track('rightLeg','x',[0,.18,.35,.52,.7],[-.38,0,.38,0,-.38]),
      ])],
      ['walk-back',new THREE.AnimationClip('walk-back',.7,[
        track('leftLeg','x',[0,.18,.35,.52,.7],[-.3,0,.3,0,-.3]),
        track('rightLeg','x',[0,.18,.35,.52,.7],[.3,0,-.3,0,.3]),
      ])],
      ['punch-01',new THREE.AnimationClip('punch-01',.48,[track('rightArm','x',[0,.12,.24,.48],[0,-1.25,-1.45,0])])],
      ['kick-01',new THREE.AnimationClip('kick-01',.68,[track('rightLeg','x',[0,.15,.32,.68],[0,-.5,-1.13,0])])],
      ['block-01',new THREE.AnimationClip('block-01',.55,[
        track('leftArm','x',[0,.17,.42,.55],[0,-1.05,-1.05,0]),
        track('rightArm','x',[0,.17,.42,.55],[0,-1.05,-1.05,0]),
      ])],
      ['jump-01',new THREE.AnimationClip('jump-01',.68,[
        track('leftLeg','x',[0,.25,.5,.68],[0,.52,.52,0]),
        track('rightLeg','x',[0,.25,.5,.68],[0,-.52,-.52,0]),
      ])],
      ['reaction-01',new THREE.AnimationClip('reaction-01',.36,[track('torso','z',[0,.12,.36],[0,.23,0])])],
      ['fall-01',new THREE.AnimationClip('fall-01',.7,[track('','z',[0,.7],[0,1.4])])],
      ['celebration-01',new THREE.AnimationClip('celebration-01',1.1,[
        track('leftArm','x',[0,.3,.7,1.1],[0,-2.2,-2.2,0]),
        track('rightArm','x',[0,.3,.7,1.1],[0,-2.2,-2.2,0]),
      ])],
    ]);
    prepareFighterModel(model);
    return new FighterActor(model, clips);
  }

  play(id: string, options: { loop?: boolean; hold?: boolean; fade?: number; speed?: number; lockFloor?: boolean } = {}): number {
    const clip = this.clips.get(id);
    if (!clip) return 0;
    const next = this.mixer.clipAction(clip);
    const loop = options.loop ?? false;
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = options.hold ?? !loop;
    next.reset().setEffectiveTimeScale(options.speed ?? 1).setEffectiveWeight(1).play();
    const fade = options.fade ?? 0.12;
    if (this.current && this.current !== next) this.current.fadeOut(fade);
    if (fade) next.fadeIn(fade);
    this.current = next;
    this.currentId = id;
    this.returnToPose = !options.hold;
    if (options.lockFloor) {this.floorLocked = true;this.floorLockRemaining=clip.duration/(options.speed??1)+.25;}
    else if (this.floorLocked) { this.floorLocked = false;this.floorLockRemaining=0;this.model.position.y = this.baseModelY; }
    return clip.duration / (options.speed ?? 1);
  }

  playRandom(pool: string, options: { loop?: boolean; hold?: boolean; fade?: number; speed?: number; lockFloor?: boolean } = {}): number {
    const available = (ANIMATION_POOLS[pool] ?? [pool]).filter(id => this.clips.has(id));
    if (!available.length) return 0;
    const prior = this.lastVariant.get(pool);
    const choices = available.length > 1 ? available.filter(id => id !== prior) : available;
    const id = choices[Math.floor(Math.random() * choices.length)]!;
    this.lastVariant.set(pool, id); return this.play(id, options);
  }

  update(delta: number): void {
    this.mixer.update(delta);
    if (this.floorLocked && this.floorLockRemaining > 0) {
      this.floorLockRemaining=Math.max(0,this.floorLockRemaining-delta);
      this.root.updateMatrixWorld(true);
      const minY = new THREE.Box3().setFromObject(this.model, true).min.y;
      const floorY = this.root.getWorldPosition(this.floorPoint).y;
      if (Number.isFinite(minY)) this.model.position.y += floorY - minY;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    disposeObject(this.root);
    this.root.removeFromParent();
  }
}

function disposeObject(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const values = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of values) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
}
