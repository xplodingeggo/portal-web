# portal-web

A browser reimplementation of Portal (2007) that reads **your own installed game files**. No game content is included or committed.

## Run

```sh
pnpm install
cp .env.example .env.local   # set GAME_DIR to your Portal install
pnpm dev                     # http://127.0.0.1:5173/
pnpm typecheck
pnpm test                    # format tests against your install (skipped if GAME_DIR is missing)
```

`pnpm build` type-checks and builds a static site. A deployed build loads game files from `<base>files/` (a `manifest.json` listing `{ path, size }` plus the files themselves, served with Range requests), or from a Portal folder the player picks in the browser. Set `PORTAL_BASE` to build for a sub-path.

On start a screen asks where the game files come from: stream from the host, stream and keep a copy in the browser's private storage, download everything first, or pick a local Portal folder (nothing is uploaded; needs a Chromium browser).

### Controls

Click to capture the mouse. All keys can be rebound in Settings; defaults:

| Key | Action |
|---|---|
| WASD, Space, Ctrl / C | walk, jump, crouch |
| E | use doors and buttons, pick up or drop a cube |
| Left / right click | blue / orange portal (once you have the gun) |
| G | toggle the portal gun (debug) |
| V | noclip (Space/Ctrl up and down, Shift fast, Alt slow) |
| `;` / `'` | quick save / quick load |
| F3 or 0 | show or hide the on-screen debug text (hidden by default) |
| `[` / `]` | exposure down / up |
| F11, Pause | fullscreen, pause |
| `` ` `` | developer console |
| Esc | pause menu (level select, save manager, settings, debug info, link to this repo) |

The console understands the usual Source commands (`map`, `noclip`, `god`, `give weapon_portalgun`, `setpos`, `ent_fire`, `ent_create`, `sv_gravity`, `fov`, `volume`, ...); type `help` for the list.

### URL options

- `?map=<name>` loads any map in `portal/maps` (default `testchmb_a_00`). Starting a map normally begins in its elevator.
- `&pos=x,y,z&ang=pitch,yaw` starts at that position instead.
- `&gun=1` starts with the portal gun, `&shoot=color,pitch,yaw;...` fires it on the first frame.
- `&t=<seconds>` fast-forwards map logic, `&fire=target,input[,param];...` sends inputs at start (like `ent_fire`).
- `&props=<substring>` shows only matching prop models (`none` hides them all), `&hide=<substring>` hides matching world materials.
- `&loadsave=<id>` loads a saved game.

## How it works

| Path | What |
|---|---|
| `server/gameFiles.ts` | Vite middleware serving `GAME_DIR` read-only at `/game/*` (with Range requests), plus `/__gameindex` |
| `src/fs/` | VPK v1/v2 directory reader, PAKFILE zip reader, layered `GameFS` (search order from `gameinfo.txt`) |
| `src/bsp/` | VBSP v19–21 lumps, entity lump, lightmap atlas, face/displacement mesh building, overlays, static props, BSP leaf lookup and ambient light cubes |
| `src/material/` | KeyValues/VMT (with `patch` materials) and VTF 7.0–7.5 (DXT goes straight to the GPU) |
| `src/model/` | Studio models: MDL v44–48, VVD (with fixups), VTX v7 strips, posing from a sequence's first frame, per-vertex static prop lighting (`.vhv`), and collision hulls (`.phy`) |
| `src/physics/` | Box traces against BSP brushes and prop collision hulls; Source-style player movement (friction, air control, jumping, crouching, stair steps, a short climb assist onto ledges and props) at a fixed 66 Hz tick; `rigid.ts` runs physics props on Rapier |
| `src/game/` | Map logic: entity outputs and delayed inputs, logic entities, triggers, doors, tracktrains, energy ball launchers and catchers, turrets, cubes and other physics props, portals and the portal gun, scenes (`scenes.image`) for dialogue timing, saved games, level changes |
| `src/render/` | three.js world and prop shaders, texture cache, portals with recursion, viewmodel, HUD, fades and screen shake, particle layer |
| `src/particles/` | PCF particle systems and the environment effects maps use |
| `src/audio/` | Soundscripts and soundscapes played with Web Audio, with distance falloff and panning |
| `src/ui/` | Start screen, pause menu, developer console, rebindable keys |

### Prop lighting

- **Static props** use the map's baked per-vertex lighting (`sp_N.vhv` in the pakfile).
- **Prop entities** use the ambient light cube of the BSP leaf they sit in.
- Both raw encodings decode to a different brightness than the lightmaps. Their scale constants (`VHV_SCALE`, `AMBIENT_SCALE`) were fitted against nearby lightmap texels on `testchmb_a_00`.

## Code policy

- No leaked Valve source code.
- Format layouts come from Valve's officially published Source SDK 2013 headers and the public Valve Developer Community wiki.
- MIT code from [noclip.website](https://github.com/magcius/noclip.website) may be reused with credit in the file it lands in.

## Status

Playable: the test chambers load and run from the elevator through level changes, with portals, cubes, buttons, doors, energy balls, turrets, sound, particles, saves and a level select.

Not implemented (or only partly): `func_physbox`, `func_breakable_surf`, ragdolls and `phys_*` constraints, fog and `sky_camera`, `color_correction`, vgui screens, the credits, and some scripted-NPC entities. Expect rough edges on maps beyond the test chambers.
