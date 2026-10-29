// LZMA decoder (the reference algorithm from LzmaSpec.cpp) for the compressed entries of Source's
// scenes.image. Decodes a raw stream whose unpacked size is known.

const kNumBitModelTotalBits = 11;
const kBitModelTotal = 1 << kNumBitModelTotalBits;
const kNumMoveBits = 5;
const kTopValue = 1 << 24;

class RangeDecoder {
    range = 0xffffffff;
    code = 0;
    pos: number;
    constructor(private buf: Uint8Array, start: number) {
        this.pos = start + 1; // first byte is always 0
        for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | buf[this.pos++]) >>> 0;
    }
    private normalize() {
        if (this.range < kTopValue) {
            this.range = (this.range << 8) >>> 0;
            this.code = ((this.code << 8) | (this.buf[this.pos++] ?? 0)) >>> 0;
        }
    }
    direct(numBits: number) {
        let res = 0;
        for (let i = 0; i < numBits; i++) {
            this.range >>>= 1;
            this.code = (this.code - this.range) >>> 0;
            const t = 0 - (this.code >>> 31);
            this.code = (this.code + (this.range & t)) >>> 0;
            this.normalize();
            res = ((res << 1) + t + 1) >>> 0;
        }
        return res;
    }
    bit(probs: Uint16Array, i: number) {
        const v = probs[i];
        const bound = (this.range >>> kNumBitModelTotalBits) * v;
        let symbol: number;
        if (this.code < bound) {
            probs[i] = v + ((kBitModelTotal - v) >>> kNumMoveBits);
            this.range = bound >>> 0;
            symbol = 0;
        } else {
            probs[i] = v - (v >>> kNumMoveBits);
            this.code = (this.code - bound) >>> 0;
            this.range = (this.range - bound) >>> 0;
            symbol = 1;
        }
        this.normalize();
        return symbol;
    }
}

const newProbs = (n: number) => new Uint16Array(n).fill(kBitModelTotal >>> 1);

function bitTree(rc: RangeDecoder, probs: Uint16Array, base: number, numBits: number) {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) + rc.bit(probs, base + m);
    return m - (1 << numBits);
}

function bitTreeReverse(rc: RangeDecoder, probs: Uint16Array, base: number, numBits: number) {
    let m = 1, sym = 0;
    for (let i = 0; i < numBits; i++) {
        const b = rc.bit(probs, base + m);
        m = (m << 1) + b;
        sym |= b << i;
    }
    return sym;
}

class LenDecoder {
    choice = newProbs(2);
    low = newProbs(16 << 3);
    mid = newProbs(16 << 3);
    high = newProbs(256);
    decode(rc: RangeDecoder, posState: number) {
        if (!rc.bit(this.choice, 0)) return bitTree(rc, this.low, posState << 3, 3);
        if (!rc.bit(this.choice, 1)) return 8 + bitTree(rc, this.mid, posState << 3, 3);
        return 16 + bitTree(rc, this.high, 0, 8);
    }
}

/** props: the 5-byte lc/lp/pb + dictionary header. */
export function lzmaDecode(props: Uint8Array, src: Uint8Array, srcStart: number, outSize: number): Uint8Array {
    let d = props[0];
    if (d >= 9 * 5 * 5) throw new Error('lzma: bad properties');
    const lc = d % 9;
    d = (d / 9) | 0;
    const lp = d % 5;
    const pb = (d / 5) | 0;
    const out = new Uint8Array(outSize);
    const rc = new RangeDecoder(src, srcStart);

    const literal = newProbs(0x300 << (lc + lp));
    const posSlot = newProbs(4 << 6);
    const posDecoders = newProbs(1 + 114);
    const align = newProbs(16);
    const isMatch = newProbs(12 << 4);
    const isRep = newProbs(12), isRepG0 = newProbs(12), isRepG1 = newProbs(12), isRepG2 = newProbs(12);
    const isRep0Long = newProbs(12 << 4);
    const lenDec = new LenDecoder(), repLenDec = new LenDecoder();

    let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
    let pos = 0;
    while (pos < outSize) {
        const posState = pos & ((1 << pb) - 1);
        if (!rc.bit(isMatch, (state << 4) + posState)) {
            const prev = pos > 0 ? out[pos - 1] : 0;
            const base = 0x300 * (((pos & ((1 << lp) - 1)) << lc) + (prev >> (8 - lc)));
            let sym = 1;
            if (state >= 7) {
                let matchByte = out[pos - rep0 - 1];
                do {
                    const matchBit = (matchByte >> 7) & 1;
                    matchByte <<= 1;
                    const b = rc.bit(literal, base + ((1 + matchBit) << 8) + sym);
                    sym = (sym << 1) | b;
                    if (matchBit !== b) break;
                } while (sym < 0x100);
            }
            while (sym < 0x100) sym = (sym << 1) | rc.bit(literal, base + sym);
            out[pos++] = sym & 0xff;
            state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
            continue;
        }
        let len: number;
        if (rc.bit(isRep, state)) {
            if (pos === 0) throw new Error('lzma: corrupt');
            if (!rc.bit(isRepG0, state)) {
                if (!rc.bit(isRep0Long, (state << 4) + posState)) {
                    state = state < 7 ? 9 : 11;
                    out[pos] = out[pos - rep0 - 1];
                    pos++;
                    continue;
                }
            } else {
                let dist: number;
                if (!rc.bit(isRepG1, state)) dist = rep1;
                else {
                    if (!rc.bit(isRepG2, state)) dist = rep2;
                    else { dist = rep3; rep3 = rep2; }
                    rep2 = rep1;
                }
                rep1 = rep0;
                rep0 = dist;
            }
            len = repLenDec.decode(rc, posState);
            state = state < 7 ? 8 : 11;
        } else {
            rep3 = rep2; rep2 = rep1; rep1 = rep0;
            len = lenDec.decode(rc, posState);
            state = state < 7 ? 7 : 10;
            const lenState = Math.min(len, 3);
            const slot = bitTree(rc, posSlot, lenState << 6, 6);
            if (slot < 4) rep0 = slot;
            else {
                const numDirect = (slot >> 1) - 1;
                rep0 = ((2 | (slot & 1)) << numDirect) >>> 0;
                if (slot < 14) rep0 = (rep0 + bitTreeReverse(rc, posDecoders, rep0 - slot, numDirect)) >>> 0;
                else {
                    rep0 = (rep0 + (rc.direct(numDirect - 4) << 4)) >>> 0;
                    rep0 = (rep0 + bitTreeReverse(rc, align, 0, 4)) >>> 0;
                    if (rep0 === 0xffffffff) break; // end marker
                }
            }
        }
        len += 2;
        if (rep0 >= pos) throw new Error('lzma: corrupt distance');
        for (let i = 0; i < len && pos < outSize; i++, pos++) out[pos] = out[pos - rep0 - 1];
    }
    return out;
}
