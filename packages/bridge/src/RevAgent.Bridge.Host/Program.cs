using Microsoft.Extensions.Hosting.WindowsServices;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Cli;
using RevAgent.Bridge.Host.Hosting;
using RevAgent.Bridge.Host.Install;
using RevAgent.Bridge.Host.Platform;
using RevAgent.Bridge.Host.Update;
using RevAgent.Bridge.Bootstrap.Updates;
using System.Reflection;

namespace RevAgent.Bridge.Host;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        if (args.Length == 1 &&
            string.Equals(args[0], "--version", StringComparison.Ordinal))
        {
            string version =
                Assembly.GetExecutingAssembly()
                    .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
                    .InformationalVersion ??
                Assembly.GetExecutingAssembly().GetName().Version?.ToString() ??
                "unknown";
            await Console.Out.WriteLineAsync(version).ConfigureAwait(false);
            return (int)HostExitCode.Success;
        }

        bool isWindowsService =
            OperatingSystem.IsWindows() &&
            WindowsServiceHelpers.IsWindowsService();
        HostCommandParseResult parsed = HostCommandParser.Parse(
            args,
            isWindowsService);
        if (!parsed.Success)
        {
            await Console.Error.WriteLineAsync(parsed.Error).ConfigureAwait(false);
            await Console.Error.WriteLineAsync(HostCommandParser.Usage)
                .ConfigureAwait(false);
            return (int)HostExitCode.Usage;
        }

        RollingJsonBridgeLog? log = null;
        try
        {
            BridgeInstallLayout layout = BridgeInstallLayout.Canonical;
            Directory.CreateDirectory(layout.HostLogDirectory);
            log = new RollingJsonBridgeLog(
                layout.HostLogDirectory,
                filePrefix: "revagent-bridge-host",
                maxFileBytes: 10L * 1024 * 1024,
                retainedFileCount: 7);

            string processPath = Environment.ProcessPath ??
                throw new InvalidOperationException(
                    "The stable host executable path is unavailable.");
            var workerLauncher = new SystemWorkerProcessLauncher();
            var eventLog = new WindowsLifecycleEventLog();
            var services = new WindowsServiceControlManager();
            var runtimeState = new HostRuntimeState();
            var updateState = new BridgeUpdateStateStore(layout);
            var updateReports = new BridgeUpdateReportStore(layout);
            var revitProcessProbe = new SystemRevitProcessProbe();
            var pendingAddinApplier = new PendingAddinApplier(
                layout,
                updateState,
                revitProcessProbe,
                updateReports);
            var rollbackController = new CrashLoopRollbackController(
                layout,
                updateState,
                revitProcessProbe,
                reports: updateReports);
            var supervisor = new WorkerSupervisor(
                layout,
                workerLauncher,
                log,
                rollbackController: rollbackController);
            var updatePollingService = new BridgeUpdatePollingService(
                layout,
                updateState,
                supervisor,
                log,
                updateReports);
            var installer = new ServiceInstaller(
                layout,
                processPath,
                services,
                eventLog,
                log);
            var hostRunner = new BridgeHostRunner(
                supervisor,
                log,
                eventLog,
                runtimeState,
                pendingAddinApplier,
                updatePollingService);
            var dispatcher = new HostCommandDispatcher(
                layout,
                installer,
                hostRunner,
                workerLauncher,
                log);

            return await dispatcher.ExecuteAsync(
                parsed.Command!,
                CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            await Console.Error.WriteLineAsync(ex.Message).ConfigureAwait(false);
            if (log is not null)
            {
                try
                {
                    await log.WriteAsync(
                        "critical",
                        "host_unhandled_exception",
                        "host",
                        "Stable host terminated with an unhandled exception.",
                        ex).ConfigureAwait(false);
                }
                catch
                {
                    // stderr and exit code remain available.
                }
            }

            return (int)HostExitCode.Unexpected;
        }
        finally
        {
            if (log is not null)
            {
                try
                {
                    await log.DisposeAsync().ConfigureAwait(false);
                }
                catch
                {
                    // The command's completed exit code remains authoritative.
                }
            }
        }
    }
}
