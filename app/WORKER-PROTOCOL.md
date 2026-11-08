# Protokol model ↔ worker (R-007, tvar z asteroids)

Worker je `app/gameWorker.js` slepený za běhu z ES modulů (`svision/js/moduleWorker.js`:
seznam v `MainModel.WORKER_SOURCES`, tytéž soubory v `config/compile.json`
`standalone`): `svision/js/platform/scene3D/vec3.js`, `mat4.js`, `quat.js`,
`mesh.js`, `playfield.js`, `track.js`, `game.js`, `gameWorker.js`. Stejná
třída `GameWorker` se importuje pod Node do nástrojů (`tools/regress.mjs`,
`tools/matchstate.mjs`, `tools/matchtrack.mjs`) — bez časovače, snímek po
snímku přes `tick`.

Tick = **jeden `FixedUpdate` originálu = 50 Hz, Δt 0,02 s** (notes 3; pevný
krok, akumulátor podle `performance.now()`, po probuzení záložky se nedohání
víc než 8 ticků). Snímek se posílá po každé dávce ticků (poslední); `tick`
v headless režimu ho pošle vždy.

**Stav GR-M5:** `Game.tick(input, dt)` je jeden `FixedUpdate` originálu
podle notes 6/6a/10 (vyhlazení vstupu, rozjezdová křivka, náklon, pohyb,
kamera, energie, klesání; čísla z `data/global.json` `rules`), stavový
automat `playing → crash → over`. **GR-M6:** trať je `Track`
(`app/track.js`): generátor řádků bloků podle `LevelManager` (notes 8 —
sekvence sekcí světa z `data/sections.json`, náhodný posun řádku podle
tilingu, jeden blok na snímek přes `frameUpdate`, recyklace do stran,
mazání za lodí), aktivace překážek po `obstaclesPerTick` dětech za tik,
animátory (`tumble`/`fall`/`mover`/`slide`/`wave`/`spin` — notes 11) a
kolize trigger boxu lodi (otočeného s lodí) s tvary box/koule/kapsle
(SAT) ⇒ `crash` s výbuchem. **GR-M7:** sběr (notes 12, 13) — `Track` spawnuje
pickupy při položení bloku (spawn pointy bloku, hody `rng.chance()` v pořadí
originálu), `Track.collect` vrací ty, kterých se dotkl trigger box lodi
nebo koule magnetu (kapsle r 10 × 39,13 podél z se středem podle druhu),
`Game.applyPickup` je uplatní: mince += ⌈1 × násobitel⌉, násobitel +1 do 6
s časovačem 5 s × upgrade (krok za tik jako korutina po `WaitForFixedUpdate`),
energie = 1; `energyFixed` = energie před pickupy tiku (tak ji vidí
trace). **GR-M8:** `world`, `shipId` a multiplikátory upgradů v `init`
plní model z postupu hráče (`MainModel.runOptions(app.progress)`,
`app/progress.js`: vybraný svět, aktivní loď, úrovně slotů → notes 14);
worker ani hra postup neznají — mince běhu (`coins` ve stavu) a
vzdálenost zaúčtuje model po `gameOver` (`GameApp.finishGame`). `Playfield.frame` z toho skládá **popis scény
jako data** (kamera ze stavu, obloha a mlha světa, aktivní bloky jako
dlaždice s mřížkou, aktivní překážky s plnou transformací jako maticí, loď)
s odkazy na sítě jménem — žádný `Mesh` ani `Scene3D` v workeru, žádné typed
arrays ve zprávě. Model snímek vloží do `Scene3D` přes
`Playfield.build(scene, frame, meshes)` (knihovna sítí
`Playfield.meshes(data)`: primitiva + lodě z `data/ships.json` jako
`ship:<id>`, stejná v modelu i v nástrojích; worker i modely staví
`new Playfield(data)` — GR-M4). V režimu match (`tools/matchstate.mjs`)
dostane worker s každým `tick` vstup a `dt` z trace.

## model → worker

| zpráva | význam |
|---|---|
| `{id:'init', seed, data, playerName?, shipId?, world?, battery?, coins?, multiplier?, magnet?, track?, headless?, setup?}` | `seed` = seed mulberry32 (`GameWorker.seededSource`, bajtový zdroj náhody — jediná náhoda, kterou hra dostane, `options.random` v `Game`); `data` = `{global, ships, worlds, sections, pickups}` — `GameApp.gameData()`: `data/*.json` a k tomu sítě lodí z `assets/ships/` (jen načtené; loď bez sítě se kreslí jako zástupný dart) a tratě z `assets/worlds/` složené do `sections` `{source, blocks, worlds}` (`global.rules` jsou čísla mechaniky, **povinné**; GR-M4: lodě se sítěmi, světy s barvami a mlhou, vlastní bloky a sekvence; worker z nich staví `Playfield`, hra bere výchozí loď a svět 0); `shipId`/`world` a multiplikátory upgradů lodi (notes 14; výchozí 1): `battery` 1–2, `coins` 1–3 (množství mincí ve spawnu), `multiplier` 1–3 (doba násobitele), `magnet` 1–2 (0/nic = bez magnetu) přebijí výchozí (GR-M8); `track: false` = bez tratě (`matchstate`: trať originálu v trace GR-M5 není); `trackData` = `{blocks, worlds}` místo `data/sections.json` (`matchtrack`: reference převedená na tvar `track.js`); `rng` = `{rangeFloat, rangeInt, chance}` místo náhody generátoru a spawneru (`match*`: hodnoty nahrané v trace) — obojí jen pod Node; `headless` = bez hodin, jen `tick`; `setup(game)` = jen nástroje, stav před prvním tikem. Hra začíná hned |
| `{id:'controls', action, value}` | stav jedné akce: `left` / `right` (klávesy a dotykové poloviny, −1/0/+1) nebo `steer` = osa gamepadu −1..1 (spojitá; poslední použité zařízení určuje, co hra dostane — `{left, right}` nebo `{steer, pad: true}` s rychlejším vyhlazením, notes 6, 7) |
| `{id:'pause'}` / `{id:'continue'}` | hodiny běží, ticky ne |
| `{id:'reset'}` | zastaví a zahodí hru |
| `{id:'tick', input?, dt?, frame?}` | headless: přesně jeden tick + `frame`; `input` (`{steer, pad}` nebo `{left, right}`) a `dt` z trace nahradí držené akce a pevný krok (režim match); `frame: false` = po tiku neběží generátor tratě (`LevelManager.Update` originálu je jednou za snímek — `matchtrack` ho pustí až po posledním tiku snímku podle `fc` z trace) |

## worker → model

| zpráva | význam |
|---|---|
| `{id:'frame', tick, state, scene, gameOver, sounds[]}` | `state` = stav snímku, jak ho vrátil `Game.tick` (`Playfield.emptyState()` jmenuje pole: `time` s, `phase` playing/crash/over, `shipId` (id v `ships.json`, null = dart), `world` (index v `worlds.json`), `ship` {x, y, z, roll, yaw, pitch, visible} v **levotočivých souřadnicích originálu**, `camera` {x, y, z, roll, yaw, pitch} (notes 6a), `input` {touch, pressTime, visualPressTime, tilt, ratio, velocityX, inputMultiplier, energyFactor, booster} — mezivýsledky pro `matchstate`, `speed`, `energy` (může být < 0 při vybití), `energyFixed` (energie před pickupy tiku — `matchstate`), `lowEnergy`, `distance` m = skóre, `coins` (mince běhu), `multiplier` {value 1–6, timer s, on, time = plná doba} (násobitel mincí, notes 12), `collected` {coin, multiplier, energy} = počty za běh, `lastPickup` {kind, amount, tick} pro zprávu HUD, `track` {section, generated, active, spawned}, `blocks` [{id, x, z, width, length}] = aktivní bloky, `obstacles` [{kind box/sphere/capsule, look, material, c, s, q, parts?, hidden?}] = aktivní tvary (`material` = jméno viditelného materiálu originálu z referenční trati; `parts` = díly kreslené s tvarem [{mesh = jméno sítě originálu (`sections.meshes`), materials v pořadí rendereru, offset {p, q, s} = poloha dílu v rámci tvaru}] — `Playfield.obstacleMesh` z nich skládá obarvené sítě `ob:<mesh>:<materials>`; bez dílů primitiv podle `look` v barvě světa; `hidden` = tvar, jehož renderery kreslí jiné tvary (tunel z mnoha koulí) — koliduje, nekreslí se) v dosahu horizontu s aktuální transformací (kvaternion Unity [x, y, z, w]), `pickups` [{kind coin/multiplier/energy, c, y}] = pickupy v dosahu (`y` = výška vizuálu: energie visí ve 100 u a klesá k lodi)); `scene` = `{background, fog, camera, items}` z `Playfield.frame(state)` — položky `Scene3D` s `mesh` jako **id** sítě (`ground`, `cube`, `pillar`, `sphere`, `ship:<id>`, `ship` = dart), `transform` {position, rotation °, scale} nebo matice 16 čísel (překážky: `Quat.compose` zrcadlené do pravotočivé scény), `fill`/`color`; `gameOver` = konec běhu (fáze `over`, sekundu po nárazu/vybití — worker přestane tikat, model ukáže notice); `sounds` = události snímku (`crash`, `energyOut`, `gameOver`, `lowEnergy`/`energyOk`, `boosterOn`/`boosterOff`, `pickup:coin`/`pickup:multiplier`/`pickup:energy`, `multiplierOff`) pro zvuk — `MainModel.playSounds` je hraje přes `audioManager` na jediné sběrnici efektů originálu (GR-M9: `pickup:*` klip pickupu a krok žebříku výšky, `boosterOn` klip BOOSTERS_ON, `crash`/`energyOut` výbuch a fade hudby; `boosterOff`, `lowEnergy`/`energyOk`, `multiplierOff` a `gameOver` projdou tiše — originál pro ně zvuk nemá, a bez souborů mlčí všechno) |
