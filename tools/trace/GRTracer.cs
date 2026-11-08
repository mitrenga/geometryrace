// GRTracer — the instrument the patched original carries (GR-M5 trace).
//
// Compiled into GRTracer.dll against the APK's own mscorlib/UnityEngine
// (build.sh), dropped next to Assembly-CSharp.dll in the APK, and called
// from the hooks GRPatch puts into the original's IL:
//   Frame(this)     at the end of PlayerControl.FixedUpdate — one record
//   RangeF / RangeI in place of every UnityEngine.Random.Range call site,
//                   with the call site's "Type.Method" as a third argument
//                   (GR-M6: the values of the track generator are told
//                   apart from the power-up spawner's)
//   Crash(explosion) at the start of PlayerCrash.Crash — and, because the
//                   player is deactivated on an explosion and no Frame
//                   follows, a marker line of its own at once
//   Start()         at the start of GameManager.OnEnterStateGame
//   Block(this)     at the end of LevelManager.generateBlock (GR-M6): the
//                   block just placed — prefab, id, section, position — and
//                   (GR-M7) the pickups the spawner put on it
//   Pickup(powerup) at the start of PowerupManager.ApplyPowerup (GR-M7):
//                   a pickup collected — its kind and where it stood; the
//                   record also carries the coins of the run, the credit
//                   multiplier and its timer (`cr`, `cm`, `ct`)
//
// It reads the original's private fields by reflection (nothing of the
// original is compiled in here) and writes one JSON line per FixedUpdate
// to <persistentDataPath>/gr-trace-<n>.jsonl — pulled with adb — or, when
// the file cannot be opened, to logcat as "GRT {...}" (tools/trace/
// logcat2trace.mjs turns that into the same file). The format is in
// tools/trace/README.md. Numbers are float32 as the original holds them,
// written round-trip ("R").
//
// .NET 3.5 API level only (Unity 5.6 Mono): no LINQ over the hot path, no
// string.Join(IEnumerable), no Tuple.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEngine;

public static class GRTracer
{
    const string VERSION = "1.9.7";
    static readonly BindingFlags ANY = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
    static readonly CultureInfo INV = CultureInfo.InvariantCulture;

    static StreamWriter writer;
    static bool useLog;
    static bool started;
    static int frame;
    static int run;
    static readonly List<float> randoms = new List<float>();
    static readonly List<string> randomSites = new List<string>();
    static readonly List<string> events = new List<string>();
    static readonly List<string> blocks = new List<string>();
    static readonly List<string> pickups = new List<string>();

    // cached reflection
    static Type playerControlType;
    static FieldInfo fPressTime, fVisualPressTime, fTilt, fRatio, fVelocityX, fInputMultiplier, fEnergyFactor, fTouch, fPlayerEnergy, fCameraMover, fPadC;
    static FieldInfo fEnergy, fWasPadLast;
    static MethodInfo mPadCount;
    static Type levelManagerType;
    static FieldInfo fBlock, fCurrentSection, fActiveBlocks;
    static Type collectableType;
    static FieldInfo fPowerupType;
    static PropertyInfo pCredits;
    static MethodInfo mCreditMultiplier;
    static FieldInfo fPmInstance, fTimer;
    static bool pickupsBound;

    // ------------------------------------------------------------ hooks

    /// <summary>GameManager.OnEnterStateGame: a new run — a new file, the frame counter back to 0.</summary>
    public static void Start()
    {
        try
        {
            Close();
            run++;
            frame = 0;
            randoms.Clear();
            randomSites.Clear();
            events.Clear();
            blocks.Clear();
            pickups.Clear();
            Open();
            started = true;
            var sb = new StringBuilder();
            sb.Append("{\"trace\":\"gr\",\"version\":\"").Append(VERSION).Append("\"");
            sb.Append(",\"kind\":\"?\",\"run\":").Append(run);
            sb.Append(",\"dt\":").Append(F(Time.fixedDeltaTime));
            sb.Append(",\"world\":").Append(World());
            sb.Append(",\"battery\":").Append(F(Multiplier("Battery")));
            sb.Append(",\"steering\":\"").Append(Steering()).Append("\"");
            sb.Append(",\"unity\":\"").Append(Application.unityVersion).Append("\"");
            sb.Append(",\"date\":\"").Append(DateTime.UtcNow.ToString("o", INV)).Append("\"}");
            Write(sb.ToString());
            Debug.Log("GRT start run " + run + (useLog ? " (logcat)" : " -> " + Path()));
        }
        catch (Exception e)
        {
            Debug.Log("GRT start failed: " + e);
        }
    }

    /// <summary>End of PlayerControl.FixedUpdate: the record of the tick.</summary>
    public static void Frame(object playerControl)
    {
        if (!started) return;
        try
        {
            Bind(playerControl);
            var pc = (Component)playerControl;
            var t = pc.transform;
            var p = t.position;
            var r = t.eulerAngles;
            frame++;
            var sb = new StringBuilder(512);
            sb.Append("{\"f\":").Append(frame);
            sb.Append(",\"t\":").Append(F(Time.fixedTime));
            sb.Append(",\"dt\":").Append(F(Time.deltaTime));           // = fixedDeltaTime inside FixedUpdate
            sb.Append(",\"fc\":").Append(Time.frameCount);              // the render frame this tick belongs to
            sb.Append(",\"in\":").Append(F((float)fTouch.GetValue(playerControl)));
            sb.Append(",\"pad\":").Append(PadActive(playerControl) ? 1 : 0);
            sb.Append(",\"im\":").Append(F((float)fInputMultiplier.GetValue(playerControl)));
            sb.Append(",\"ef\":").Append(F((float)fEnergyFactor.GetValue(playerControl)));
            sb.Append(",\"pt\":").Append(F((float)fPressTime.GetValue(playerControl)));
            sb.Append(",\"vpt\":").Append(F((float)fVisualPressTime.GetValue(playerControl)));
            sb.Append(",\"tilt\":").Append(F((float)fTilt.GetValue(playerControl)));
            sb.Append(",\"ratio\":").Append(F((float)fRatio.GetValue(playerControl)));
            sb.Append(",\"vx\":").Append(F((float)fVelocityX.GetValue(playerControl)));
            sb.Append(",\"x\":").Append(F(p.x)).Append(",\"y\":").Append(F(p.y)).Append(",\"z\":").Append(F(p.z));
            sb.Append(",\"rx\":").Append(F(r.x)).Append(",\"ry\":").Append(F(r.y)).Append(",\"rz\":").Append(F(r.z));
            var pe = fPlayerEnergy.GetValue(playerControl);
            if (pe != null && fEnergy != null)
            {
                sb.Append(",\"e\":").Append(F((float)fEnergy.GetValue(pe)));
            }
            var cm = fCameraMover.GetValue(playerControl) as Component;
            if (cm != null)
            {
                var cp = cm.transform.position;
                var cr = cm.transform.eulerAngles;
                sb.Append(",\"cx\":").Append(F(cp.x)).Append(",\"cy\":").Append(F(cp.y)).Append(",\"cz\":").Append(F(cp.z));
                sb.Append(",\"crx\":").Append(F(cr.x)).Append(",\"cry\":").Append(F(cr.y)).Append(",\"crz\":").Append(F(cr.z));
            }
            sb.Append(",\"rnd\":[");
            for (int i = 0; i < randoms.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(F(randoms[i]));
            }
            sb.Append("],\"rs\":[");
            for (int i = 0; i < randomSites.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append('"').Append(randomSites[i]).Append('"');
            }
            sb.Append("],\"ev\":[");
            for (int i = 0; i < events.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append('"').Append(events[i]).Append('"');
            }
            sb.Append("],\"blk\":[");
            for (int i = 0; i < blocks.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(blocks[i]);
            }
            sb.Append("]");
            // GR-M7: the coins of the run, the credit multiplier and its timer as this FixedUpdate sees them (before the physics step's pickups)
            BindPickups();
            if (pCredits != null)
            {
                sb.Append(",\"cr\":").Append(Convert.ToInt32(pCredits.GetValue(null, null)));
            }
            if (mCreditMultiplier != null)
            {
                sb.Append(",\"cm\":").Append(F(Convert.ToSingle(mCreditMultiplier.Invoke(null, null))));
            }
            if (fPmInstance != null && fTimer != null)
            {
                var pm = fPmInstance.GetValue(null);
                if (pm != null) sb.Append(",\"ct\":").Append(F((float)fTimer.GetValue(pm)));
            }
            sb.Append(",\"pk\":[");
            for (int i = 0; i < pickups.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(pickups[i]);
            }
            sb.Append("]}");
            randoms.Clear();
            randomSites.Clear();
            events.Clear();
            blocks.Clear();
            pickups.Clear();
            Write(sb.ToString());
        }
        catch (Exception e)
        {
            Debug.Log("GRT frame failed: " + e);
            started = false;
        }
    }

    /// <summary>In place of UnityEngine.Random.Range(float, float).</summary>
    public static float RangeF(float min, float max)
    {
        return RangeF(min, max, "?");
    }

    /// <summary>In place of UnityEngine.Random.Range(float, float), with the call site ("Type.Method") GRPatch pushes.</summary>
    public static float RangeF(float min, float max, string site)
    {
        float v = UnityEngine.Random.Range(min, max);
        randoms.Add(v);
        randomSites.Add(site);
        return v;
    }

    /// <summary>In place of UnityEngine.Random.Range(int, int).</summary>
    public static int RangeI(int min, int max)
    {
        return RangeI(min, max, "?");
    }

    /// <summary>In place of UnityEngine.Random.Range(int, int), with the call site.</summary>
    public static int RangeI(int min, int max, string site)
    {
        int v = UnityEngine.Random.Range(min, max);
        randoms.Add(v);
        randomSites.Add(site);
        return v;
    }

    /// <summary>Start of PlayerCrash.Crash(Vector3, bool explosion): the event for the next record and a marker line of its own (an explosion deactivates the player, so no record follows).</summary>
    public static void Crash(bool explosion)
    {
        string name = explosion ? "crash" : "energyOut";
        events.Add(name);
        Write("{\"mark\":\"" + name + "\",\"at\":" + frame + ",\"t\":" + F(Time.fixedTime) + "}");
        Debug.Log("GRT " + name + " at frame " + frame);
    }

    /// <summary>End of LevelManager.generateBlock: the block just placed (the field `block`), the section index and the count of active blocks, for the next record's `blk`.</summary>
    public static void Block(object levelManager)
    {
        try
        {
            BindLevel(levelManager);
            var go = fBlock != null ? fBlock.GetValue(levelManager) as GameObject : null;
            if (go == null) return;
            var name = go.name.Replace("(Clone)", "");
            int id = -1;
            var details = go.GetComponent("BlockDetails");
            if (details != null)
            {
                var f = details.GetType().GetField("id", ANY);
                if (f != null) id = (int)f.GetValue(details);
            }
            int section = fCurrentSection != null ? (int)fCurrentSection.GetValue(levelManager) : -1;
            int count = -1;
            var list = fActiveBlocks != null ? fActiveBlocks.GetValue(levelManager) as System.Collections.ICollection : null;
            if (list != null) count = list.Count;
            var p = go.transform.position;
            // GR-M7: the pickups the spawner put on the block (SpawnPowerUp ran inside generateBlock), in the spawn points' order
            var pu = new StringBuilder();
            BindPickups();
            if (collectableType != null)
            {
                var list = go.GetComponentsInChildren(collectableType);
                for (int i = 0; i < list.Length; i++)
                {
                    if (i > 0) pu.Append(',');
                    pu.Append(PickupJson(list[i]));
                }
            }
            blocks.Add("{\"n\":\"" + name + "\",\"id\":" + id + ",\"s\":" + section + ",\"x\":" + F(p.x) + ",\"z\":" + F(p.z) + ",\"a\":" + count + ",\"fc\":" + Time.frameCount + ",\"pu\":[" + pu + "]}");
        }
        catch (Exception e)
        {
            Debug.Log("GRT block failed: " + e);
        }
    }

    /// <summary>Start of PowerupManager.ApplyPowerup(Powerup) (GR-M7): a pickup collected — the kind and the collectable's place (the Powerup sits on the child `Bonus`, the PowerupCollectable on its parent), for the next record's `pk`.</summary>
    public static void Pickup(object powerup)
    {
        try
        {
            var c = powerup as Component;
            if (c == null) return;
            var parent = c.transform.parent;
            var collectable = parent != null && collectableType != null ? parent.GetComponent(collectableType) : null;
            pickups.Add(collectable != null ? PickupJson(collectable) : "{\"t\":\"" + Kind(powerup.GetType().Name) + "\",\"x\":" + F(c.transform.position.x) + ",\"y\":" + F(c.transform.position.y) + ",\"z\":" + F(c.transform.position.z) + "}");
        }
        catch (Exception e)
        {
            Debug.Log("GRT pickup failed: " + e);
        }
    }

    /// <summary>A PowerupCollectable as JSON: the kind by its PowerupType (UpgradeEnum: 0 Battery, 2 Coins, 3 Multiplier) and its position.</summary>
    static string PickupJson(Component collectable)
    {
        string kind = "?";
        if (fPowerupType != null)
        {
            switch (Convert.ToInt32(fPowerupType.GetValue(collectable)))
            {
                case 0: kind = "energy"; break;
                case 2: kind = "coin"; break;
                case 3: kind = "multiplier"; break;
            }
        }
        var p = collectable.transform.position;
        return "{\"t\":\"" + kind + "\",\"x\":" + F(p.x) + ",\"y\":" + F(p.y) + ",\"z\":" + F(p.z) + "}";
    }

    /// <summary>The kind of a Powerup by its class (BonusCredits, DoubleCredits, EnergyPowerUp).</summary>
    static string Kind(string powerupClass)
    {
        if (powerupClass == "BonusCredits") return "coin";
        if (powerupClass == "DoubleCredits") return "multiplier";
        if (powerupClass == "EnergyPowerUp") return "energy";
        return powerupClass;
    }

    /// <summary>Any other marker a hook wants to leave (block generated, pickup...).</summary>
    public static void Event(string name)
    {
        events.Add(name);
    }

    // ---------------------------------------------------------- helpers

    static string F(float v)
    {
        return v.ToString("R", INV);
    }

    static string Path()
    {
        return Application.persistentDataPath + "/gr-trace-" + run + ".jsonl";
    }

    static void Open()
    {
        try
        {
            writer = new StreamWriter(Path(), false, new UTF8Encoding(false));
            writer.AutoFlush = true;
            useLog = false;
        }
        catch (Exception e)
        {
            writer = null;
            useLog = true;
            Debug.Log("GRT file failed, logcat instead: " + e.Message);
        }
    }

    static void Close()
    {
        if (writer != null)
        {
            try { writer.Flush(); writer.Close(); } catch (Exception) { }
            writer = null;
        }
    }

    static void Write(string line)
    {
        if (useLog || writer == null)
        {
            Debug.Log("GRT " + line);
        }
        else
        {
            writer.WriteLine(line);
        }
    }

    static void Bind(object playerControl)
    {
        var type = playerControl.GetType();
        if (type == playerControlType) return;
        playerControlType = type;
        fPressTime = type.GetField("pressTime", ANY);
        fVisualPressTime = type.GetField("visualPressTime", ANY);
        fTilt = type.GetField("horizontalTilt", ANY);
        fRatio = type.GetField("horizontalMovingRatio", ANY);
        fVelocityX = type.GetField("velocityX", ANY);
        fInputMultiplier = type.GetField("inputMultiplier", ANY);
        fEnergyFactor = type.GetField("energyFactor", ANY);
        fTouch = type.GetField("touch", ANY);
        fPlayerEnergy = type.GetField("playerEnergy", ANY);
        fCameraMover = type.GetField("cameraMover", ANY);
        fPadC = type.GetField("padC", ANY);
        var pe = fPlayerEnergy != null ? fPlayerEnergy.GetValue(playerControl) : null;
        fEnergy = pe != null ? pe.GetType().GetField("energy", ANY) : null;
        var pad = fPadC != null ? fPadC.GetValue(playerControl) : null;
        if (pad != null)
        {
            fWasPadLast = pad.GetType().GetField("wasPadControllerLast", ANY);
            mPadCount = pad.GetType().GetMethod("PadCount", ANY);
        }
    }

    static void BindPickups()
    {
        if (pickupsBound) return;
        pickupsBound = true;
        collectableType = Type.GetType("PowerupCollectable");
        fPowerupType = collectableType != null ? collectableType.GetField("PowerupType", ANY) : null;
        var gm = Type.GetType("GameManager");
        pCredits = gm != null ? gm.GetProperty("CreditsThisRace", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic) : null;
        var pm = Type.GetType("PowerupManager");
        mCreditMultiplier = pm != null ? pm.GetMethod("GetCreditMultiplier", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic) : null;
        fPmInstance = pm != null ? pm.GetField("instance", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic) : null;
        fTimer = pm != null ? pm.GetField("actualTimerMultiplier", ANY) : null;
    }

    static void BindLevel(object levelManager)
    {
        var type = levelManager.GetType();
        if (type == levelManagerType) return;
        levelManagerType = type;
        fBlock = type.GetField("block", ANY);
        fCurrentSection = type.GetField("currentSection", ANY);
        fActiveBlocks = type.GetField("activeBlocks", ANY);
    }

    static bool PadActive(object playerControl)
    {
        try
        {
            var pad = fPadC != null ? fPadC.GetValue(playerControl) : null;
            if (pad == null || fWasPadLast == null || mPadCount == null) return false;
            int count = (int)mPadCount.Invoke(pad, null);
            return count > 0 && (bool)fWasPadLast.GetValue(pad);
        }
        catch (Exception) { return false; }
    }

    static string Steering()
    {
        // PlayerPrefs "Steering": 1 touch (default), 0 accelerometer (notes 7)
        return (int)PlayerPrefs.GetFloat("Steering", 1f) == 0 ? "accel" : "touch";
    }

    static int World()
    {
        try
        {
            var gm = Type.GetType("GameManager");
            if (gm == null) return -1;
            var prop = gm.GetProperty("SelectedWorldID", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (prop != null) return Convert.ToInt32(prop.GetValue(null, null));
            var field = gm.GetField("SelectedWorldID", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (field != null) return Convert.ToInt32(field.GetValue(null));
        }
        catch (Exception) { }
        return -1;
    }

    static float Multiplier(string upgrade)
    {
        // PowerupManager.GetMultiplier(UpgradeEnum.Battery) — the battery upgrade of the active ship (notes 10, 14)
        try
        {
            var pm = Type.GetType("PowerupManager");
            var ue = Type.GetType("UpgradeEnum");
            if (pm == null || ue == null) return 1f;
            var m = pm.GetMethod("GetMultiplier", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (m == null) return 1f;
            return Convert.ToSingle(m.Invoke(null, new object[] { Enum.Parse(ue, upgrade) }));
        }
        catch (Exception) { return 1f; }
    }
}
