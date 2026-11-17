import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Where an AI prop is in AssetFurnace's pipeline, as the dev server reports it. */
export interface PropStatus {
  stage: 'queued' | 'image' | 'model' | 'finish' | 'done' | 'error';
  prompt?: string;
  error?: string;
  /** Jobs ahead of this one in the queue. */
  ahead?: number;
}

export const STAGE_LABEL: Record<PropStatus['stage'], string> = {
  queued: 'waiting its turn', image: 'drawing the picture', model: 'building the 3D model',
  finish: 'slimming it down', done: 'ready', error: 'failed',
};

const POLL_MS = 5000;

/**
 * AI-generated props: starts jobs, polls their progress and loads finished models.
 * Models are loaded once per prop id and shared by every group showing that prop.
 */
class PropStore {
  status = new Map<string, PropStatus>();
  models = new Map<string, THREE.Object3D>();
  /** Called whenever a status or model changes, so the scene and panels refresh. */
  onChange = () => {};
  private watching = new Set<string>();

  async start(id: string, prompt: string) {
    this.status.set(id, { stage: 'queued', prompt });
    this.onChange();
    try {
      const res = await fetch('/api/props', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, prompt }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    } catch (e) {
      this.status.set(id, { stage: 'error', prompt, error: (e as Error).message });
      this.onChange();
      return;
    }
    this.watch(id);
  }

  /** Follow a prop until it's ready or failed. Safe to call repeatedly. */
  watch(id: string) {
    if (this.watching.has(id) || this.models.has(id)) return;
    this.watching.add(id);
    const tick = async () => {
      let s: PropStatus;
      try {
        const res = await fetch(`/api/props/${id}`);
        s = res.ok ? await res.json() : { stage: 'error', error: res.status === 404 ? 'Model files not found' : `HTTP ${res.status}` };
      } catch {
        s = this.status.get(id) ?? { stage: 'queued' }; // dev server blip: keep trying
      }
      const changed = JSON.stringify(s) !== JSON.stringify(this.status.get(id));
      this.status.set(id, s);
      if (s.stage === 'done') {
        try {
          const gltf = await new GLTFLoader().loadAsync(`/api/props/${id}/model.glb`);
          // glTF is Y-up; this app is Z-up.
          gltf.scene.rotation.x = Math.PI / 2;
          const holder = new THREE.Group();
          holder.add(gltf.scene);
          holder.updateMatrixWorld(true);
          this.models.set(id, holder);
        } catch (e) {
          this.status.set(id, { ...s, stage: 'error', error: `Couldn't load the model: ${(e as Error).message}` });
        }
        this.watching.delete(id);
        this.onChange();
        return;
      }
      if (s.stage === 'error') {
        this.watching.delete(id);
        if (changed) this.onChange();
        return;
      }
      if (changed) this.onChange();
      setTimeout(tick, POLL_MS);
    };
    tick();
  }
}

export const props = new PropStore();
