// Lanceur de développement : exécute « npm run dev » à la racine du projet (le dossier de l'exe, ou son parent s'il est dans tools\).
// Compilation : tools\build-dev-exe.cmd  ->  Kartouche-Dev.exe à la racine.
using System;
using System.Diagnostics;
using System.IO;

static class KartoucheDev
{
    static int Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        while (dir != null && !File.Exists(Path.Combine(dir, "package.json"))) dir = Path.GetDirectoryName(dir.TrimEnd('\\'));
        if (dir == null) { Console.Error.WriteLine("package.json introuvable."); return 1; }

        if (!Directory.Exists(Path.Combine(dir, "node_modules")))
        {
            Console.WriteLine("Premiere execution : npm install...");
            int rc = Run(dir, "npm install");
            if (rc != 0) return rc;
        }
        Console.WriteLine("Kartouche (dev) : npm run dev - ferme cette fenetre pour tout arreter.");
        return Run(dir, "npm run dev");
    }

    static int Run(string dir, string cmd)
    {
        var psi = new ProcessStartInfo("cmd.exe", "/c " + cmd) { WorkingDirectory = dir, UseShellExecute = false };
        using (var p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
    }
}
