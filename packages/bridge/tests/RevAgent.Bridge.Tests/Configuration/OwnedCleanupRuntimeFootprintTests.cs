using System.Diagnostics;
using System.Text;
using System.Text.Json;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Configuration;

public sealed class OwnedCleanupRuntimeFootprintTests
{
    [WindowsFootprintFact]
    public async Task RealProducersLeaveRecognizedCleanStopFootprint()
    {
        string? exportedBase = Environment.GetEnvironmentVariable("REVAGENT_OWNED_RUNTIME_FIXTURE_BASE");
        bool export = !string.IsNullOrWhiteSpace(exportedBase);
        string root = Path.GetFullPath(export
            ? exportedBase!
            : Path.Combine(Path.GetTempPath(), "eu20-runtime-footprint-" + Guid.NewGuid().ToString("N")));
        string state = Path.Combine(root, "data", "revAgent", "bridge");
        string receipt = Path.Combine(root, "runtime-footprint.json");
        GuardRoot(root, export);
        if (!export) Directory.CreateDirectory(state);
        GuardRoot(state, true);
        Assert.True(Directory.Exists(state));
        Assert.False(File.Exists(receipt));
        string journal = Path.Combine(state, "journal.db");
        Assert.False(File.Exists(journal));
        Assert.False(File.Exists(journal + ".writer.lock"));
        Assert.False(Directory.Exists(Path.Combine(state, "artifact-spool")));
        try
        {
            // These are the real on-disk journal and spool producers used by
            // WorkerGatewayRuntime, not filename-only fixture copies.
            await using (RbpJournalStore store = RbpJournalStore.Open(
                journal, new TestResumeTokenProtector(), RbpJournalTestData.Options()))
            using (RbpArtifactSpoolFileSystem spool = RbpArtifactSpoolFileSystem.OpenForStateRoot(state))
            {
                Assert.True(File.Exists(journal + ".writer.lock"));
                Assert.True(Directory.Exists(Path.Combine(state, "artifact-spool")));
            }
            Assert.True(File.Exists(journal));
            Assert.True(File.Exists(journal + ".writer.lock"));
            Assert.Empty(Directory.EnumerateFileSystemEntries(Path.Combine(state, "artifact-spool")));
            using (File.Open(journal + ".writer.lock", FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }

            string repo = FindRepositoryRoot();
            foreach (bool core in new[] { false, true })
            {
                string script = $$"""
                    $ErrorActionPreference='Stop'
                    Import-Module {{Quote(Path.Combine(repo, "installer/bridge/lib/RevAgent.BridgeInstall.psm1"))}} -Force
                    & (Get-Module RevAgent.BridgeInstall) {
                        param($root)
                        foreach($item in Get-ChildItem -LiteralPath $root -Force -Recurse){
                            $relative=$item.FullName.Substring($root.Length).TrimStart('\')
                            if(-not(Test-RevAgentBridgeOwnedStatePath -Relative $relative -Directory $item.PSIsContainer)){throw 'production_footprint_not_recognized'}
                        }
                        if(Test-RevAgentBridgeOwnedStatePath -Relative 'artifact-spool/foreign.bin' -Directory $false){throw 'unknown_spool_content_accepted'}
                        if(Test-RevAgentBridgeOwnedStatePath -Relative 'journal.db.writer.lock.foreign' -Directory $false){throw 'unknown_lock_lookalike_accepted'}
                    } {{Quote(state)}}
                    """;
                string shell = core ? "pwsh.exe" : Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
                var start = new ProcessStartInfo(shell) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = repo };
                foreach (string argument in new[] { "-NoProfile", "-NonInteractive", "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) }) start.ArgumentList.Add(argument);
                using Process process = Process.Start(start)!;
                Task<string> output = process.StandardOutput.ReadToEndAsync();
                Task<string> error = process.StandardError.ReadToEndAsync();
                try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30)); }
                finally { if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); } }
                Assert.True(process.ExitCode == 0, (await output) + (await error));
            }
            if (export)
            {
                using FileStream stream = new(receipt, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                JsonSerializer.Serialize(stream, new { producers = new[] { nameof(RbpJournalStore), nameof(RbpJournalWriterLease), nameof(RbpArtifactSpoolFileSystem) }, disposed = true, writerLockRetained = true, emptySpoolRetained = true, stateRoot = state });
                stream.Flush(flushToDisk: true);
                // The elevated PowerShell consumer now exercises actual
                // cleanup planning/removal of this retained production output.
            }
        }
        finally
        {
            if (!export && Directory.Exists(root)) { GuardRoot(root, false); Directory.Delete(root, recursive: true); }
        }
    }

    private static void GuardRoot(string root, bool export)
    {
        Assert.True(Path.IsPathFullyQualified(root));
        Assert.False(root.StartsWith(@"\\", StringComparison.Ordinal));
        foreach (Environment.SpecialFolder folder in new[] { Environment.SpecialFolder.CommonApplicationData, Environment.SpecialFolder.ProgramFiles })
        {
            string protectedRoot = Path.GetFullPath(Environment.GetFolderPath(folder));
            Assert.False(root.Equals(protectedRoot, StringComparison.OrdinalIgnoreCase) || root.StartsWith(protectedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
        }
        if (export) Assert.True(Directory.Exists(root));
        else Assert.StartsWith(Path.GetFullPath(Path.GetTempPath()), root, StringComparison.OrdinalIgnoreCase);
        for (string? cursor = root; cursor is not null; cursor = Path.GetDirectoryName(cursor))
            if (Directory.Exists(cursor)) Assert.False((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0);
    }

    private static string Quote(string text) => "'" + text.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string FindRepositoryRoot()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "installer", "bridge", "lib", "RevAgent.BridgeInstall.psm1"))) return directory.FullName;
        throw new InvalidOperationException("Repository root unavailable.");
    }
    private sealed class WindowsFootprintFactAttribute : FactAttribute
    {
        public WindowsFootprintFactAttribute() { if (!OperatingSystem.IsWindows()) Skip = "Requires the real Windows handle-relative spool producer."; }
    }
}
