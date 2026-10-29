# portal-web

A browser reimplementation of Portal (2007) that reads **your own installed game files**. It runs locally only, and no game content is included or committed.

## Run

```sh
pnpm install
cp .env.example .env.local   # set GAME_DIR to your Portal install
pnpm dev                     # http://127.0.0.1:5173/?map=testchmb_a_00
pnpm test                    # format tests against your install (skipped if GAME_DIR is missing)
```

- **Controls:** click to capture the mouse. You start as the player: WASD walks, Space jumps, Ctrl crouches, E picks up or drops a cube (and uses doors that allow it). G toggles the portal gun: left click places blue, right click orange. V toggles noclip (WASD flies, Space/Ctrl up/down, Shift fast, Alt slow). `[` / `]` change exposure.
- **URL options:** `?map=<name>` loads any map in `portal/maps`. `&pos=x,y,z&ang=pitch,yaw` starts in noclip at that camera position.
- **Debug filters:** `&props=<substring>` shows only matching prop models (`none` hides them all). `&hide=<substring>` hides matching world materials.
- **Debug logic:** `&t=<seconds>` fast-forwards map logic, `&fire=target,input[,param];…` sends inputs at start (like `ent_fire`), `&gun=1` starts with the portal gun, `&shoot=color,pitch,yaw;…` fires it on the first frame.

## How it works

| Path | What |
|---|---|
| `server/gameFiles.ts` | Vite middleware serving `GAME_DIR` read-only at `/game/*` (with Range requests), plus `/__gameindex` |
| `src/fs/` | VPK v1/v2 directory reader, PAKFILE zip reader, layered `GameFS` (search order from `gameinfo.txt`) |
| `src/bsp/` | VBSP v19–21 lumps, entity lump, lightmap atlas, face/displacement mesh building, overlays, static props, BSP leaf lookup and ambient light cubes |
| `src/material/` | KeyValues/VMT (with `patch` materials) and VTF 7.0–7.5 (DXT goes straight to the GPU) |
| `src/model/` | Studio models: MDL v44–48, VVD (with fixups), VTX v7 strips, posing from a sequence's first frame, per-vertex static prop lighting (`.vhv`), and collision hulls (`.phy`) |
| `src/physics/` | Box traces against BSP brushes and prop collision hulls; Source-style player movement (friction, air control, jumping, crouching, stair steps) at a fixed 66 Hz tick |
| `src/game/` | Map logic: entity outputs → delayed inputs, logic_auto/relay/timer/case, math_counter, triggers (once, multiple, look, teleport, cleanser, changelevel), func_door/func_brush/func_tracktrain, prop_dynamic skins and animations, texture toggles, templates, carryable cubes, prop_portal |
| `src/render/` | three.js world shader (base × lightmap), prop shader (baked vertex light or ambient cube), texture cache, noclip camera |

### Prop lighting

- **Static props** use the map's baked per-vertex lighting (`sp_N.vhv` in the pakfile).
- **Prop entities** use the ambient light cube of the BSP leaf they sit in.
- Both raw encodings decode to a different brightness than the lightmaps. Their scale constants (`VHV_SCALE`, `AMBIENT_SCALE`) were fitted against nearby lightmap texels on `testchmb_a_00`.

## Code policy

- No leaked Valve source code.
- Format layouts come from Valve's officially published Source SDK 2013 headers and the public Valve Developer Community wiki.
- MIT code from [noclip.website](https://github.com/magcius/noclip.website) may be reused with credit in the file it lands in.

## Roadmap

- **M1 (done):** world brushes, textures, baked lightmaps, noclip.
- **M2 (in progress):** static props and prop entities are done, posed at frame 0 of their default sequence (`DefaultAnim`, otherwise sequence 0). Overlays (info_overlay decals, lump 45) are clipped onto their faces and use those faces' lightmaps. Still to do: playing animations, animations stored in external `.ani` files, the skybox, and cubemap reflections (`$envmap`).
- **M3 (done):** player movement and collision, map logic, solid moving doors, floor buttons, cubes, portals (map-placed and portal gun), level changes through elevators.
- **Known gaps:**
  - Scripted scenes (GLaDOS dialogue `.vcd`s, in `scenes.image`) don't run, so their mid-scene events don't fire. Chamber signs are shown lit instead of waiting for a look trigger that a scene would enable.
  - Cubes are axis-aligned boxes without rotation. Other physics props (chairs, mugs) stay put. Cubes don't go through portals yet.
  - Portals show one level of recursion (a portal seen through a portal shows last frame's image). No sound.
- **Later:** scene playback, real rigid-body physics, refract/water shaders, sound.
