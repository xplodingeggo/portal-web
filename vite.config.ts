import { defineConfig, loadEnv } from 'vite';
import { gameFiles } from './server/gameFiles';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const gameDir = env.GAME_DIR || 'E:\\SteamLibrary\\steamapps\\common\\Portal';
    return {
        base: env.PORTAL_BASE || '/',
        server: { host: '127.0.0.1', port: 5173 },
        plugins: [gameFiles(gameDir)],
    };
});
