# trace — instrumentace originálu a formát záznamu (GR-M5, GR-M6, GR-M7)

Metodika `dump*` → `trace*` → `match*` (`../../ZADANI.md` kap. 9): trace je
záznam z **instrumentovaného originálu** běžícího v emulátoru Androidu,
`tools/matchstate.mjs` proti němu pouští `app/game.js` snímek po snímku.
Sem patří jen vlastní nástroje; opatchované DLL a APK vznikají v
`sources/extract/trace/` (mimo git) a záznamy jdou do `sources/traces/`
(mimo git). Postup pro operátora: `sources/docs/nastroje.md` kap. 6.

| soubor | co dělá |
|---|---|
| `GRTracer.cs` | třída `GRTracer`, kterou opatchovaný originál volá: na konci `PlayerControl.FixedUpdate` zapíše záznam tiku (pole čte reflexí — nic z originálu není zkompilované dovnitř), místo `UnityEngine.Random.Range` vrací totéž a hodnotu **i jméno volajícího** (`Typ.Metoda`, GR-M6) si zapamatuje do záznamu, na začátku `PlayerCrash.Crash` značku **a hned i samostatný řádek `mark`** (při výbuchu originál hráče deaktivuje a další záznam tiku už nepřijde — nález GR-M6, tracer GR-M5 by událost ztratil), na začátku `GameManager.OnEnterStateGame` hlavičku, na konci `LevelManager.generateBlock` právě položený blok (GR-M6) **i s pickupy, které na něj spawner položil** (GR-M7, `pu`), na začátku `PowerupManager.ApplyPowerup` sebraný pickup (GR-M7, `pk`); záznam tiku nese i mince běhu, násobitel a jeho časovač (`cr`, `cm`, `ct`). Zápis do `persistentDataPath/gr-trace-<n>.jsonl`, když soubor nejde otevřít, do logcatu jako `GRT {...}` |
| `GRPatch/` | konzolový program .NET 8 nad Mono.Cecil (z instalace `ilspycmd`, bez NuGet): vloží volání do IL `Assembly-CSharp.dll` — 5 háčků + záměna všech call-sites `Random.Range(float)`/`(int)` za tříargumentové `GRTracer.RangeF/RangeI(min, max, "Typ.Metoda")` (před volání vloží `ldstr`; skoky a handlery mířící na volání přesměruje na něj) |
| `build.sh` | operátor: `csc` GRTracer.dll proti `mscorlib`/`UnityEngine` z APK, `dotnet run` GRPatch, zip s vyměněnými DLL, `zipalign`, `apksigner` s jednorázovým klíčem → `sources/extract/trace/gr-trace-1.9.7.apk` |
| `logcat2trace.mjs` | záložní cesta: `GRT` řádky z `adb logcat -d` → `.jsonl` po bězích |

## Formát `*.jsonl`

Jeden JSON objekt na řádek. První řádek běhu je **hlavička**, pak **jeden
záznam na `FixedUpdate`** originálu (50 Hz, Δt 0,02 — notes 3). Čísla jsou
float32 originálu vypsané round-trip.

Hlavička:

```json
{"trace":"gr","version":"1.9.7","kind":"?","run":1,"dt":0.02,"world":0,"battery":1,"steering":"touch","unity":"5.6.4p4","date":"2026-09-16T12:00:00Z"}
```

| klíč | význam |
|---|---|
| `kind` | tracer píše `?`; operátor po záznamu **doplní ručně** `straight` (rozjezd bez řízení do vybití), `slalom` (řízení), `energy` (vybití) — nebo v názvu souboru |
| `world` | `GameManager.SelectedWorldID` (0–2) |
| `battery` | multiplikátor upgradu Battery aktivní lodi (1–2, notes 10, 14) — `matchstate` ho předá hře (`--battery` přebije) |
| `steering` | `touch` / `accel` (`PlayerPrefs "Steering"`, notes 7) |
| `seed` | jen selftest `matchstate` (hra sama) |

Záznam tiku (klíče ↔ stav `game.js`, které `matchstate` porovnává):

| klíč | originál | stav hry | tolerance |
|---|---|---|---|
| `f` | pořadí `FixedUpdate` od startu běhu | `tick` | — |
| `t`, `dt`, `fc` | `Time.fixedTime`, `Time.deltaTime` (= 0,02), `Time.frameCount` | `time` | — |
| `in` | `PlayerControl.touch` (−1..1, notes 7) | vstup tiku (`{steer}`) | vstup |
| `pad` | gamepad byl poslední (druhé vyhlazení 15·Δt) | `{pad}` | vstup |
| `im` | `inputMultiplier` (rozjezdová křivka) | `input.inputMultiplier` | 1e-3 |
| `ef` | `energyFactor` | `input.energyFactor` | 1e-3 |
| `pt`, `vpt` | `pressTime`, `visualPressTime` | `input.pressTime`, `input.visualPressTime` | 1e-3 |
| `tilt` | `horizontalTilt` (po `*= inputMultiplier`) | `input.tilt` | 1e-3 |
| `ratio` | `horizontalMovingRatio` | `input.ratio` | 1e-3 |
| `vx` | `velocityX` (u/tik) | `input.velocityX` | 1e-3 |
| `x`, `y`, `z` | pozice hráče (u) | `ship.x/y/z` | 0,05 u |
| `rx`, `ry`, `rz` | Eulerovy úhly hráče 0–360° (pitch, yaw, roll) | `ship.pitch/yaw/roll` (se znaménkem) | 0,05° |
| `e` | `PlayerEnergy.energy` | `energy` | 1e-3 |
| `cx`, `cy`, `cz` | pozice kamery | `camera.x/–/z` | 0,05 u |
| `crx`, `cry`, `crz` | Eulerovy úhly kamery (`crx` = 5 stále) | `camera.–/yaw/roll` | 0,05° |
| `rnd` | hodnoty vrácené `Random.Range` od minulého záznamu (řádky tratě, spawn — notes 4) | `matchtrack` (náhoda generátoru místo vlastní) | — |
| `rs` | ke každé hodnotě `rnd` volající `Typ.Metoda` (`RandomSection.StartNewBlockRow` / `SetTiling` / `GetBlockID`, `PowerupSpawner.spawn`) — GR-M6 | `matchtrack` bere jen tři generátoru, spawner přeskočí (GR-M7) | pořadí |
| `ev` | `crash`, `energyOut`, další značky | `phase`, `events` | — |
| `blk` | bloky položené od minulého záznamu (`LevelManager.generateBlock`, v `Update` snímku `fc`): `{n: prefab bez "(Clone)", id: BlockDetails.id, s: index sekce, x, z, a: počet aktivních bloků, fc, pu}` — GR-M6; `pu` (GR-M7) = pickupy, které spawner na blok položil (`GetComponentsInChildren<PowerupCollectable>` v pořadí spawn pointů): `[{t: coin | multiplier | energy, x, y, z}]` | `matchtrack`: `Track.generated` (id, sekce, x, z), `Track.spawned` (druh, x, z) | 0,05 u |
| `cr` | `GameManager.CreditsThisRace` (mince běhu) — GR-M7 | `coins` **tiku f − 1** (záznam vzniká na konci `FixedUpdate`, před fyzikou tiku, která sbírá) | přesně |
| `cm` | `PowerupManager.GetCreditMultiplier()` (1–6) — GR-M7 | `multiplier.value` tiku f − 1 | přesně |
| `ct` | `PowerupManager.actualTimerMultiplier` (s) — GR-M7 | `multiplier.timer` tiku f − 1, jen dokud `cm` > 1 (po vypršení drží poslední hodnotu, `ResetAll` ji nenuluje) | 1e-3 |
| `pk` | pickupy sebrané od minulého záznamu (`PowerupManager.ApplyPowerup`, ve fyzice tiku f − 1): `[{t, x, y, z}]` — GR-M7 | `matchstate --track`: pickupy sebrané v tiku f − 1 (druh, x, z) | 0,05 u |

Samostatný řádek `{"mark":"crash"|"energyOut","at":<f>,"t":<fixedTime>}`
(GR-M6): událost z `PlayerCrash.Crash` ve chvíli, kdy nastala — `at` je
poslední zapsaný tik. `matchtrack` proti němu staví tik, ve kterém hra
narazila (`crash`) nebo vybila (`energyOut`).

Tolerance: originál počítá ve float32, hra v double; exponenciální
vyhlazení jsou kontraktivní (chyba neroste), pozice se ale sčítá tisíckrát
— proto 0,05 u / 0,05°. `--tolerance k` škáluje všechny. Rozhodnutí
`ZADANI.md` kap. 10 bod 8.

## Co v trace je a není

`matchstate` (GR-M5) pouští hru **bez tratě** (`track: false`) a porovnává
jen stav lodi, kamery a energie; s `--track` (GR-M7) ji pouští na
**referenčních blocích** s nahranou náhodou (společná knihovna
`tools/tracelib.mjs`) a porovnává navíc `cr`, `cm`, `ct` a `pk` — `e` se
vždy porovnává s energií **před pickupy tiku** (`energyFixed`), protože
záznam vzniká před fyzikou. `matchtrack` (GR-M6) pouští hru na
**referenčních blocích** (`sources/extract/json/sections.json` převedené
na tvar `app/track.js`) s náhodou z `rnd`/`rs` (generátor **i spawner** —
`PowerupSpawner.spawn` v pořadí originálu: energetický bod 1 hod, běžný
bod 1–2), generátor po snímcích podle `fc`, a porovnává posloupnost bloků
(`blk`), překážky každého bloku, pickupy každého bloku (`pu`, GR-M7) a tik
nárazu (`mark`). Záznam pořízený tracerem GR-M5 (bez `rs`, `blk`, `mark`)
`matchtrack` odmítne s hlášením; záznam tracerem GR-M6 (bez `pu`, `pk`,
`cr`) projde bez kontrol pickupů a řekne to.
