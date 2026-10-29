// KeyValues text parser (used by VMT files). Keys are lowercased; when a key
// repeats in one block the first value wins.
export interface KVBlock {
    [key: string]: string | KVBlock;
}

function tokenize(text: string): string[] {
    const tokens: string[] = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (/\s/.test(c)) {
            i++;
        } else if (c === '{' || c === '}') {
            tokens.push(c);
            i++;
        } else if (c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j++;
            tokens.push(text.slice(i + 1, j));
            i = j + 1;
        } else if (c === '[') {
            // Platform conditional such as [$X360]; ignored.
            while (i < text.length && text[i] !== ']') i++;
            i++;
        } else {
            let j = i;
            while (j < text.length && !/[\s{}"]/.test(text[j])) j++;
            tokens.push(text.slice(i, j));
            i = j;
        }
    }
    return tokens;
}

/** A key and its value, in file order with repeats kept (soundscripts repeat "wave"). */
export interface KVNode {
    key: string; // lowercase
    value: string | KVNode[];
}

/** Parses every top-level entry of a document, keeping order and repeated keys. */
export function parseKeyValueNodes(text: string): KVNode[] {
    const tokens = tokenize(text.replace(/^﻿/, ''));
    let p = 0;
    const parseList = (): KVNode[] => {
        const list: KVNode[] = [];
        while (p < tokens.length && tokens[p] !== '}') {
            const key = tokens[p++].toLowerCase();
            const value = tokens[p] === '{' ? (p++, parseList()) : tokens[p++] ?? '';
            list.push({ key, value });
        }
        p++; // closing brace
        return list;
    };
    return parseList();
}

/** Parses a document; returns the root key (e.g. the shader name) and its block. */
export function parseKeyValues(text: string): { name: string; body: KVBlock } {
    const tokens = tokenize(text.replace(/^﻿/, ''));
    let p = 0;
    const parseBlock = (): KVBlock => {
        const block: KVBlock = {};
        while (p < tokens.length && tokens[p] !== '}') {
            const key = tokens[p++].toLowerCase();
            const value = tokens[p] === '{' ? (p++, parseBlock()) : tokens[p++] ?? '';
            if (!(key in block)) block[key] = value;
        }
        p++; // closing brace
        return block;
    };
    const name = (tokens[p++] ?? '').toLowerCase();
    if (tokens[p] !== '{') return { name, body: {} };
    p++;
    return { name, body: parseBlock() };
}
