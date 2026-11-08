// GRPatch — puts the GRTracer hooks into Assembly-CSharp.dll of the original
// (GR-M5 trace instrumentation), with Mono.Cecil. Nothing of the original
// is copied: the patch inserts calls and swaps call targets.
//
//   dotnet run --project tools/trace/GRPatch -- <Managed dir> <GRTracer.dll> <out dir>
//
// Hooks (tools/trace/README.md):
//   PlayerControl.FixedUpdate          before every `ret`: ldarg.0; call GRTracer.Frame(object)
//   PlayerCrash.Crash(Vector3, bool)   at the start: ldarg.2; call GRTracer.Crash(bool)
//   GameManager.OnEnterStateGame       at the start: call GRTracer.Start()
//   every `call UnityEngine.Random::Range(float32, float32)` → ldstr "Type.Method"; GRTracer.RangeF(float, float, string)
//   every `call UnityEngine.Random::Range(int32, int32)`     → ldstr "Type.Method"; GRTracer.RangeI(int, int, string)
//   LevelManager.generateBlock         before every `ret`: ldarg.0; call GRTracer.Block(object)
//   PowerupManager.ApplyPowerup(Powerup)  at the start: ldarg.1; call GRTracer.Pickup(object)   (GR-M7)
//
// The ldstr goes in front of the call; a branch or a handler that pointed
// at the call is moved to the ldstr, so the stack stays right.
//
// The output is Assembly-CSharp.dll in <out dir> (plus a report of what was
// patched on stdout); the caller copies it and GRTracer.dll into the APK.

using System;
using System.IO;
using System.Linq;
using Mono.Cecil;
using Mono.Cecil.Cil;

static class Program
{
    static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("usage: GRPatch <Managed dir with Assembly-CSharp.dll> <GRTracer.dll> <out dir>");
            return 2;
        }
        string managed = args[0], tracerPath = args[1], outDir = args[2];
        Directory.CreateDirectory(outDir);

        var resolver = new DefaultAssemblyResolver();
        resolver.AddSearchDirectory(managed);
        resolver.AddSearchDirectory(Path.GetDirectoryName(Path.GetFullPath(tracerPath)));
        var readerParameters = new ReaderParameters { AssemblyResolver = resolver, ReadWrite = false };

        var game = AssemblyDefinition.ReadAssembly(Path.Combine(managed, "Assembly-CSharp.dll"), readerParameters);
        var tracer = AssemblyDefinition.ReadAssembly(tracerPath, readerParameters);
        var module = game.MainModule;
        var tracerType = tracer.MainModule.GetType("GRTracer")
            ?? throw new Exception("GRTracer type not found in " + tracerPath);

        MethodReference Import(string name) =>
            module.ImportReference(tracerType.Methods.First(m => m.Name == name));

        var frame = Import("Frame");
        var crash = Import("Crash");
        var start = Import("Start");
        var rangeF = module.ImportReference(tracerType.Methods.First(m => m.Name == "RangeF" && m.Parameters.Count == 3));
        var rangeI = module.ImportReference(tracerType.Methods.First(m => m.Name == "RangeI" && m.Parameters.Count == 3));
        var blockHook = Import("Block");
        var pickupHook = Import("Pickup");

        int hooks = 0, swapsF = 0, swapsI = 0;

        // 1. PlayerControl.FixedUpdate — before every ret
        {
            var method = Method(module, "PlayerControl", "FixedUpdate");
            var il = method.Body.GetILProcessor();
            foreach (var ret in method.Body.Instructions.Where(i => i.OpCode == OpCodes.Ret).ToList())
            {
                il.InsertBefore(ret, il.Create(OpCodes.Ldarg_0));
                il.InsertBefore(ret, il.Create(OpCodes.Call, frame));
                hooks++;
            }
        }

        // 2. PlayerCrash.Crash(Vector3, bool) — at the start
        {
            var method = Method(module, "PlayerCrash", "Crash");
            var il = method.Body.GetILProcessor();
            var first = method.Body.Instructions[0];
            il.InsertBefore(first, il.Create(OpCodes.Ldarg_2));
            il.InsertBefore(first, il.Create(OpCodes.Call, crash));
            hooks++;
        }

        // 3. GameManager.OnEnterStateGame — at the start
        {
            var method = Method(module, "GameManager", "OnEnterStateGame");
            var il = method.Body.GetILProcessor();
            var first = method.Body.Instructions[0];
            il.InsertBefore(first, il.Create(OpCodes.Call, start));
            hooks++;
        }

        // 4. LevelManager.generateBlock — before every ret (GR-M6: the block placed)
        {
            var method = Method(module, "LevelManager", "generateBlock");
            var il = method.Body.GetILProcessor();
            foreach (var ret in method.Body.Instructions.Where(i => i.OpCode == OpCodes.Ret).ToList())
            {
                il.InsertBefore(ret, il.Create(OpCodes.Ldarg_0));
                il.InsertBefore(ret, il.Create(OpCodes.Call, blockHook));
                hooks++;
            }
        }

        // 5. PowerupManager.ApplyPowerup(Powerup) — at the start (GR-M7: the pickup collected)
        {
            var method = Method(module, "PowerupManager", "ApplyPowerup");
            var il = method.Body.GetILProcessor();
            var first = method.Body.Instructions[0];
            il.InsertBefore(first, il.Create(OpCodes.Ldarg_1));
            il.InsertBefore(first, il.Create(OpCodes.Call, pickupHook));
            hooks++;
        }

        // 6. Random.Range call sites, everywhere: the site name pushed, the 3-argument tracer called
        foreach (var type in module.GetTypes())
        {
            foreach (var method in type.Methods.Where(m => m.HasBody))
            {
                var il = method.Body.GetILProcessor();
                foreach (var ins in method.Body.Instructions.ToList())
                {
                    if (ins.OpCode != OpCodes.Call || !(ins.Operand is MethodReference target)) continue;
                    if (target.DeclaringType.FullName != "UnityEngine.Random" || target.Name != "Range") continue;
                    var p0 = target.Parameters[0].ParameterType.FullName;
                    MethodReference swap;
                    if (p0 == "System.Single") { swap = rangeF; swapsF++; }
                    else if (p0 == "System.Int32") { swap = rangeI; swapsI++; }
                    else continue;
                    var site = il.Create(OpCodes.Ldstr, type.Name + "." + method.Name);
                    il.InsertBefore(ins, site);
                    Retarget(method.Body, ins, site);
                    ins.Operand = swap;
                    Console.WriteLine($"  Random.Range({(p0 == "System.Single" ? "float" : "int")}) in {type.Name}.{method.Name}");
                }
            }
        }

        var outPath = Path.Combine(outDir, "Assembly-CSharp.dll");
        game.Write(outPath);
        Console.WriteLine($"patched: {hooks} hooks, {swapsF} Range(float) + {swapsI} Range(int) call sites -> {outPath}");
        return 0;
    }

    /// <summary>Every branch, switch target and handler boundary that pointed at `from` now points at `to`.</summary>
    static void Retarget(MethodBody body, Instruction from, Instruction to)
    {
        foreach (var i in body.Instructions)
        {
            if (i.Operand == from) i.Operand = to;
            if (i.Operand is Instruction[] targets)
            {
                for (int k = 0; k < targets.Length; k++) if (targets[k] == from) targets[k] = to;
            }
        }
        foreach (var h in body.ExceptionHandlers)
        {
            if (h.TryStart == from) h.TryStart = to;
            if (h.TryEnd == from) h.TryEnd = to;
            if (h.HandlerStart == from) h.HandlerStart = to;
            if (h.HandlerEnd == from) h.HandlerEnd = to;
            if (h.FilterStart == from) h.FilterStart = to;
        }
    }

    static MethodDefinition Method(ModuleDefinition module, string typeName, string methodName)
    {
        var type = module.GetType(typeName) ?? throw new Exception("type not found: " + typeName);
        return type.Methods.FirstOrDefault(m => m.Name == methodName && m.HasBody)
            ?? throw new Exception("method not found: " + typeName + "." + methodName);
    }
}
