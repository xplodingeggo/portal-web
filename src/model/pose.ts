// Evaluates a sequence at a (fractional) frame into per-bone skinning matrices:
// bone-to-model at that frame, times the bind pose's model-to-bone.
// Animation data layouts follow the public Source SDK 2013 header studio.h.
import * as THREE from 'three';
import type { Mdl } from './mdl';

const ANIM_RAWPOS = 0x01;
const ANIM_RAWROT = 0x02;
const ANIM_ANIMPOS = 0x04;
const ANIM_ANIMROT = 0x08;
const ANIM_DELTA = 0x10;
const ANIM_RAWROT2 = 0x20;

/** Sequence index by label (case-insensitive), or 0. */
export function findSequence(mdl: Mdl, label?: string): number {
    if (!label) return 0;
    const i = mdl.sequences.findIndex((s) => s.label.toLowerCase() === label.toLowerCase());
    return i < 0 ? 0 : i;
}

/** Frame count and rate of a sequence's main animation. */
export function sequenceTiming(mdl: Mdl, seq: number): { frames: number; fps: number; looping: boolean } {
    const s = mdl.sequences[seq];
    const anim = s ? mdl.anims[s.anims[0]] : undefined;
    return { frames: anim?.numFrames ?? 1, fps: anim?.fps || 30, looping: !!s && (s.flags & 1) !== 0 };
}

/** Skinning matrices for every bone at a frame of a sequence. */
export function computePose(mdl: Mdl, seq: number, frame = 0, adjust?: BoneAdjust): THREE.Matrix4[] {
    const bones = computeBones(mdl, seq, frame, adjust);
    return mdl.bones.map((b, i) => {
        const p = b.poseToBone;
        const poseToBone = new THREE.Matrix4().set(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11], 0, 0, 0, 1);
        return bones[i].clone().multiply(poseToBone);
    });
}

/** Where a named attachment is in model space at a frame of a sequence, or null if the model has none. */
export function attachmentMatrix(mdl: Mdl, seq: number, frame: number, name: string): THREE.Matrix4 | null {
    const a = mdl.attachments.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!a) return null;
    const l = a.local;
    const local = new THREE.Matrix4().set(l[0], l[1], l[2], l[3], l[4], l[5], l[6], l[7], l[8], l[9], l[10], l[11], 0, 0, 0, 1);
    return computeBones(mdl, seq, frame)[a.bone].clone().multiply(local);
}

/** Bone-to-model matrices at a frame of a sequence. */
/** Extra local rotation for a bone (turning a camera's head), applied after its animated transform. */
export type BoneAdjust = (bone: number) => THREE.Matrix4 | null;

export function computeBones(mdl: Mdl, seq: number, frame = 0, adjust?: BoneAdjust): THREE.Matrix4[] {
    const s = mdl.sequences[seq];
    const anim = s ? mdl.anims[s.anims[0]] : undefined;
    const pos = mdl.bones.map((b) => new THREE.Vector3(...b.pos));
    const quat = mdl.bones.map((b) => new THREE.Quaternion(...b.quat));
    // Animations stored in external .ani blocks aren't loaded; those bones keep the bind pose.
    if (anim && anim.animBlock === 0) {
        const last = Math.max(0, anim.numFrames - 1);
        const f = Math.min(Math.max(frame, 0), last);
        const f0 = Math.floor(f);
        const f1 = Math.min(f0 + 1, last);
        const t = f - f0;
        applyFrame(mdl, anim.dataOffset, anim.flags, f0, pos, quat);
        if (t > 0 && f1 !== f0) {
            const pos1 = pos.map((p) => p.clone());
            const quat1 = quat.map((q) => q.clone());
            applyFrame(mdl, anim.dataOffset, anim.flags, f1, pos1, quat1);
            pos.forEach((p, i) => p.lerp(pos1[i], t));
            quat.forEach((q, i) => q.slerp(quat1[i], t));
        }
    }

    const boneToModel: THREE.Matrix4[] = [];
    mdl.bones.forEach((b, i) => {
        const local = new THREE.Matrix4().compose(pos[i], quat[i], new THREE.Vector3(1, 1, 1));
        const extra = adjust?.(i);
        if (extra) local.multiply(extra);
        boneToModel.push(b.parent >= 0 ? boneToModel[b.parent].clone().multiply(local) : local);
    });
    return boneToModel;
}

/** Whether a pose leaves the stored vertices where they are. */
export function isIdentityPose(matrices: THREE.Matrix4[]): boolean {
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return matrices.every((m) => m.elements.every((e, i) => Math.abs(e - id[i]) < 1e-4));
}

function applyFrame(mdl: Mdl, start: number, animFlags: number, frame: number, pos: THREE.Vector3[], quat: THREE.Quaternion[]) {
    const buf = mdl.raw;
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const isDelta = (animFlags & 0x4) !== 0; // STUDIO_DELTA on the animdesc

    for (let p = start, guard = 0; guard < 1024; guard++) {
        const boneIndex = buf[p];
        const flags = buf[p + 1];
        const next = v.getInt16(p + 2, true);
        const bone = mdl.bones[boneIndex];
        const delta = isDelta || (flags & ANIM_DELTA) !== 0;
        if (bone) {
            let d = p + 4;
            if (flags & ANIM_RAWROT2) {
                quat[boneIndex] = quaternion64(v, d);
                d += 8;
            } else if (flags & ANIM_RAWROT) {
                quat[boneIndex] = quaternion48(v, d);
                d += 6;
            } else if (flags & ANIM_ANIMROT) {
                const e = [0, 1, 2].map((k) => trackValue(v, d, k, frame) * bone.rotScale[k] + (delta ? 0 : bone.rot[k]));
                quat[boneIndex] = new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2], 'ZYX'));
                d += 6;
            }
            if (flags & ANIM_RAWPOS) {
                pos[boneIndex] = new THREE.Vector3(half(v.getUint16(d, true)), half(v.getUint16(d + 2, true)), half(v.getUint16(d + 4, true)));
            } else if (flags & ANIM_ANIMPOS) {
                pos[boneIndex] = new THREE.Vector3(
                    ...([0, 1, 2].map((k) => trackValue(v, d, k, frame) * bone.posScale[k] + (delta ? 0 : bone.pos[k])) as [number, number, number]),
                );
            }
        }
        if (next === 0) break;
        p += next;
    }
}

/**
 * Value of one axis track at a frame. Tracks are run-length encoded as runs of
 * {valid, total} headers followed by `valid` values; frames past `valid` repeat the last one.
 * An offset of 0 means the track is constant zero.
 */
function trackValue(v: DataView, valuePtr: number, axis: number, frame: number): number {
    const ofs = v.getInt16(valuePtr + axis * 2, true);
    if (ofs === 0) return 0;
    let p = valuePtr + ofs;
    let k = frame;
    for (let guard = 0; guard < 4096; guard++) {
        const valid = v.getUint8(p);
        const total = v.getUint8(p + 1);
        if (total === 0) return 0;
        if (total > k) return v.getInt16(p + (valid > k ? k + 1 : valid) * 2, true);
        k -= total;
        p += (valid + 1) * 2;
    }
    return 0;
}

function quaternion48(v: DataView, o: number): THREE.Quaternion {
    const x = (v.getUint16(o, true) - 32768) / 32768;
    const y = (v.getUint16(o + 2, true) - 32768) / 32768;
    const zw = v.getUint16(o + 4, true);
    const z = ((zw & 0x7fff) - 16384) / 16384;
    let w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    if (zw & 0x8000) w = -w;
    return new THREE.Quaternion(x, y, z, w);
}

function quaternion64(v: DataView, o: number): THREE.Quaternion {
    const lo = v.getUint32(o, true);
    const hi = v.getUint32(o + 4, true);
    const bits = (BigInt(hi) << 32n) | BigInt(lo);
    const field = (shift: bigint) => Number((bits >> shift) & 0x1fffffn);
    const x = (field(0n) - 1048576) / 1048576.5;
    const y = (field(21n) - 1048576) / 1048576.5;
    const z = (field(42n) - 1048576) / 1048576.5;
    let w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    if (hi & 0x80000000) w = -w;
    return new THREE.Quaternion(x, y, z, w);
}

function half(h: number): number {
    const e = (h >> 10) & 31;
    const m = h & 1023;
    const s = h & 0x8000 ? -1 : 1;
    if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
}
