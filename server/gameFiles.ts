// Dev-server plugin that exposes the user's local game install read-only.
//   GET /game/<relative path>   file bytes, with HTTP Range support
//   GET /__gameindex            JSON list of loose (non-VPK) files under the mod dirs
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const INDEX_DIRS = ['portal', 'hl2'];
const SKIP_DIRS = new Set(['bin', 'save', 'cfg', 'downloadlists']);

function walk(root: string, rel: string, out: string[]) {
    for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name.toLowerCase())) walk(root, r, out);
        } else if (!ent.name.toLowerCase().endsWith('.vpk')) {
            out.push(r.toLowerCase());
        }
    }
}

export function gameFiles(gameDir: string): Plugin {
    const root = path.resolve(gameDir);
    return {
        name: 'game-files',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = decodeURIComponent((req.url ?? '').split('?')[0]);

                if (url === '/__gameindex') {
                    const files: string[] = [];
                    for (const d of INDEX_DIRS) {
                        if (fs.existsSync(path.join(root, d))) walk(root, d, files);
                    }
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(files));
                    return;
                }

                if (!url.startsWith('/game/')) return next();
                const full = path.resolve(root, url.slice('/game/'.length));
                if (!full.startsWith(root + path.sep)) {
                    res.statusCode = 403;
                    res.end();
                    return;
                }
                let stat: fs.Stats;
                try {
                    stat = fs.statSync(full);
                    if (!stat.isFile()) throw new Error('not a file');
                } catch {
                    res.statusCode = 404;
                    res.end();
                    return;
                }

                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Content-Type', 'application/octet-stream');
                const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
                let start = 0;
                let end = stat.size - 1;
                if (m) {
                    start = Number(m[1]);
                    if (m[2]) end = Math.min(Number(m[2]), stat.size - 1);
                    if (start > end) {
                        res.statusCode = 416;
                        res.end();
                        return;
                    }
                    res.statusCode = 206;
                    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
                }
                res.setHeader('Content-Length', String(end - start + 1));
                fs.createReadStream(full, { start, end }).pipe(res);
            });
        },
    };
}
