using RevAgent.Bridge.Bootstrap;

namespace RevAgent.Bridge.Host.Hosting;

internal sealed record ResolvedWorkerExecutable(
    string ExecutablePath,
    string WorkingDirectory);

internal static class WorkerExecutableResolver
{
    internal static ResolvedWorkerExecutable Resolve(BridgeInstallLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);

        string versionsRoot = Path.GetFullPath(layout.VersionsRoot);
        string currentDirectory = ResolveCurrentDirectory(layout, versionsRoot);
        if (!Path.IsPathFullyQualified(versionsRoot) ||
            !Path.IsPathFullyQualified(currentDirectory) ||
            !Directory.Exists(versionsRoot) ||
            !Directory.Exists(currentDirectory))
        {
            throw new InvalidOperationException(
                "Bridge versions/current installation layout is missing or not absolute.");
        }

        DirectoryInfo currentInfo = new(currentDirectory);
        FileSystemInfo? resolvedLink = currentInfo.ResolveLinkTarget(returnFinalTarget: true);
        string resolvedDirectory = Path.GetFullPath(
            resolvedLink?.FullName ?? currentInfo.FullName);
        EnsureDescendant(versionsRoot, resolvedDirectory);

        string executablePath = Path.GetFullPath(
            Path.Combine(
                resolvedDirectory,
                BridgeInstallLayout.WorkerExecutableName));
        EnsureDescendant(versionsRoot, executablePath);
        if (!File.Exists(executablePath))
        {
            throw new FileNotFoundException(
                "The current revAgent Bridge worker executable does not exist.",
                executablePath);
        }

        FileAttributes attributes = File.GetAttributes(executablePath);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException(
                "The worker executable itself must not be a reparse point.");
        }

        using (File.Open(
            executablePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read | FileShare.Delete))
        {
            // Opening the exact resolved file proves it is readable before launch.
        }

        return new ResolvedWorkerExecutable(executablePath, resolvedDirectory);
    }

    private static string ResolveCurrentDirectory(
        BridgeInstallLayout layout,
        string versionsRoot)
    {
        if (!File.Exists(layout.CurrentVersionPointerPath))
        {
            return Path.GetFullPath(layout.CurrentWorkerDirectory);
        }

        string version = File.ReadAllText(layout.CurrentVersionPointerPath).Trim();
        Update.UpdatePathPolicy.ValidateVersion(version);
        string selected = Path.GetFullPath(Path.Combine(versionsRoot, version));
        EnsureDescendant(versionsRoot, selected);
        return selected;
    }

    private static void EnsureDescendant(string root, string candidate)
    {
        string relative = Path.GetRelativePath(root, candidate);
        if (Path.IsPathFullyQualified(relative) ||
            relative.Equals("..", StringComparison.Ordinal) ||
            relative.StartsWith(
                $"..{Path.DirectorySeparatorChar}",
                StringComparison.Ordinal) ||
            relative.StartsWith(
                $"..{Path.AltDirectorySeparatorChar}",
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"Resolved worker path '{candidate}' escapes versions root '{root}'.");
        }
    }
}
