using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Control;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Hosting;
using RevAgent.Bridge.Host.Update;

namespace RevAgent.Bridge.Tests.Hosting;

public sealed class WorkerSupervisorTests
{
    [Fact]
    public async Task ReadyStopStoppingLifecycleIsGraceful()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        var launcher = new InProcessWorkerLauncher("1.2.3");
        await using var log = new NullBridgeLog();
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log);

        await supervisor.StartAsync(CancellationToken.None);
        Task<WorkerExit> monitor = supervisor.WaitForExitAsync(
            CancellationToken.None);
        WorkerStopResult stop = await supervisor.StopAsync(
            WorkerStopReason.ScmStop,
            TimeSpan.FromSeconds(2),
            CancellationToken.None);
        WorkerExit exit = await monitor;

        Assert.True(stop.Graceful);
        Assert.False(stop.Forced);
        Assert.Equal(0, stop.ExitCode);
        Assert.Equal(0, exit.ExitCode);
        Assert.Equal(0, exit.RestartCount);
        Assert.NotNull(launcher.LastStart);
        Assert.Equal("__worker", launcher.LastStart!.Arguments[0]);
        Assert.Equal(
            fixture.Layout.ConfigurationPath,
            ValueAfter(launcher.LastStart.Arguments, "--config"));
        Assert.Equal(
            fixture.Layout.BundleExtractionRoot,
            launcher.LastStart.Environment["DOTNET_BUNDLE_EXTRACT_BASE_DIR"]);
    }

    [Fact]
    public async Task StopTimeoutKillsWorkerTree()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        var launcher = new InProcessWorkerLauncher(
            "1.2.3",
            ignoreStop: true);
        await using var log = new NullBridgeLog();
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log);

        await supervisor.StartAsync(CancellationToken.None);
        Task<WorkerExit> monitor = supervisor.WaitForExitAsync(
            CancellationToken.None);
        WorkerStopResult stop = await supervisor.StopAsync(
            WorkerStopReason.ScmStop,
            TimeSpan.FromMilliseconds(100),
            CancellationToken.None);
        WorkerExit exit = await monitor;

        Assert.False(stop.Graceful);
        Assert.True(stop.Forced);
        Assert.True(launcher.LastProcess?.Killed);
        Assert.Equal(-9, exit.ExitCode);
    }

    [Fact]
    public async Task InvalidStoppingAcknowledgementKillsWorkerTree()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        var launcher = new InProcessWorkerLauncher(
            "1.2.3",
            invalidStopping: true);
        await using var log = new NullBridgeLog();
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log);

        await supervisor.StartAsync(CancellationToken.None);
        Task<WorkerExit> monitor = supervisor.WaitForExitAsync(
            CancellationToken.None);
        WorkerStopResult stop = await supervisor.StopAsync(
            WorkerStopReason.ScmStop,
            TimeSpan.FromSeconds(2),
            CancellationToken.None);
        WorkerExit exit = await monitor;

        Assert.False(stop.Graceful);
        Assert.True(stop.Forced);
        Assert.True(launcher.LastProcess?.Killed);
        Assert.Equal(-9, exit.ExitCode);
    }

    [Fact]
    public async Task ReadyVersionMustMatchIndependentVersionProbe()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        var launcher = new InProcessWorkerLauncher(
            probedVersion: "1.2.3",
            readyVersion: "9.9.9");
        await using var log = new NullBridgeLog();
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log);

        WorkerStartupException error =
            await Assert.ThrowsAsync<WorkerStartupException>(
                () => supervisor.StartAsync(CancellationToken.None));

        Assert.Equal("worker_ready_version_mismatch", error.Code);
        Assert.True(launcher.LastProcess?.Killed);
    }

    [Fact]
    public async Task ThirdCrashAfterVersionFlipRestoresPreviousWorkerAndKeepsHostAlive()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        string previous = Path.Combine(fixture.Layout.VersionsRoot, "1.0.0");
        string current = Path.Combine(fixture.Layout.VersionsRoot, "2.0.0");
        Directory.CreateDirectory(previous);
        Directory.CreateDirectory(current);
        File.WriteAllText(
            Path.Combine(previous, BridgeInstallLayout.WorkerExecutableName),
            "previous");
        File.WriteAllText(
            Path.Combine(current, BridgeInstallLayout.WorkerExecutableName),
            "bad");
        var stateStore = new BridgeUpdateStateStore(fixture.Layout);
        await stateStore.WriteCurrentVersionAsync("2.0.0", CancellationToken.None);
        await stateStore.MutateAsync(
            state => state with
            {
                TenantBinding = "tenant-a",
                DeviceId = "device-1",
                AuthenticatedSessionId = "session-1",
                ActiveVersion = "2.0.0",
                PreviousVersion = "1.0.0",
                HighestAcceptedReleaseSequence = 2,
                AcceptedManifestDigest = "sha256:" + new string('a', 64),
                VersionActivatedAtUtc = DateTimeOffset.UtcNow,
            },
            CancellationToken.None);

        var launcher = new InProcessWorkerLauncher(
            "2.0.0",
            unexpectedExitsBeforeStable: 3);
        await using var log = new NullBridgeLog();
        var rollback = new CrashLoopRollbackController(
            fixture.Layout,
            stateStore,
            new NeverRunningRevitProbe());
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log,
            rollbackController: rollback);

        await supervisor.StartAsync(CancellationToken.None);
        Task<WorkerExit> monitor = supervisor.WaitForExitAsync(CancellationToken.None);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (launcher.StartCount < 4)
        {
            await Task.Delay(20, timeout.Token);
        }

        WorkerStopResult stop = await supervisor.StopAsync(
            WorkerStopReason.HostShutdown,
            TimeSpan.FromSeconds(2),
            CancellationToken.None);
        WorkerExit exit = await monitor;
        BridgeUpdateState state = await stateStore.ReadAsync(CancellationToken.None);

        Assert.True(stop.Graceful);
        Assert.False(exit.RestartBudgetExhausted);
        Assert.Equal("1.0.0", state.ActiveVersion);
        Assert.Contains("2.0.0", state.QuarantinedVersions.Keys);
        Assert.Equal(
            "1.0.0",
            File.ReadAllText(fixture.Layout.CurrentVersionPointerPath).Trim());
    }

    [Fact]
    public async Task PlannedUpdateRestartLaunchesNewPointerWithoutCrashAccounting()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        string next = Path.Combine(fixture.Layout.VersionsRoot, "2.0.0");
        Directory.CreateDirectory(next);
        File.WriteAllText(
            Path.Combine(next, BridgeInstallLayout.WorkerExecutableName),
            "next");
        var stateStore = new BridgeUpdateStateStore(fixture.Layout);
        await stateStore.MutateAsync(
            state => state with
            {
                TenantBinding = "tenant-a",
                DeviceId = "device-1",
                AuthenticatedSessionId = "session-1",
                ActiveVersion = "2.0.0",
                PreviousVersion = "1.0.0",
                HighestAcceptedReleaseSequence = 2,
                AcceptedManifestDigest = "sha256:" + new string('a', 64),
                VersionActivatedAtUtc = DateTimeOffset.UtcNow,
            },
            CancellationToken.None);

        var launcher = new InProcessWorkerLauncher("2.0.0");
        await using var log = new NullBridgeLog();
        var rollback = new CrashLoopRollbackController(
            fixture.Layout,
            stateStore,
            new NeverRunningRevitProbe());
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log,
            rollbackController: rollback);
        await supervisor.StartAsync(CancellationToken.None);
        Task<WorkerExit> monitor = supervisor.WaitForExitAsync(CancellationToken.None);

        await stateStore.WriteCurrentVersionAsync("2.0.0", CancellationToken.None);
        await supervisor.RequestUpdateRestartAsync(CancellationToken.None);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (launcher.StartCount < 2)
        {
            await Task.Delay(20, timeout.Token);
        }

        Assert.Equal(next, launcher.LastStart!.WorkingDirectory);
        Assert.Empty((await stateStore.ReadAsync(CancellationToken.None))
            .AbnormalExitTimesUtc);
        _ = await supervisor.StopAsync(
            WorkerStopReason.HostShutdown,
            TimeSpan.FromSeconds(2),
            CancellationToken.None);
        _ = await monitor;
    }

    [Theory]
    [InlineData("before_connect")]
    [InlineData("before_ready")]
    public async Task ThreeAbnormalStartupFailuresRestorePreviousWorker(
        string failureStage)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        string previous = Path.Combine(fixture.Layout.VersionsRoot, "1.0.0");
        string bad = Path.Combine(fixture.Layout.VersionsRoot, "2.0.0");
        Directory.CreateDirectory(previous);
        Directory.CreateDirectory(bad);
        File.WriteAllText(
            Path.Combine(previous, BridgeInstallLayout.WorkerExecutableName),
            "previous");
        File.WriteAllText(
            Path.Combine(bad, BridgeInstallLayout.WorkerExecutableName),
            "bad");
        var stateStore = new BridgeUpdateStateStore(fixture.Layout);
        await stateStore.WriteCurrentVersionAsync("2.0.0", CancellationToken.None);
        await stateStore.MutateAsync(
            state => state with
            {
                TenantBinding = "tenant-a",
                DeviceId = "device-1",
                AuthenticatedSessionId = "session-1",
                ActiveVersion = "2.0.0",
                PreviousVersion = "1.0.0",
                HighestAcceptedReleaseSequence = 2,
                AcceptedManifestDigest = "sha256:" + new string('a', 64),
                VersionActivatedAtUtc = DateTimeOffset.UtcNow,
            },
            CancellationToken.None);

        var launcher = new InProcessWorkerLauncher(
            "2.0.0",
            startupFailuresBeforeStable: 3,
            startupFailureStage: failureStage);
        await using var log = new NullBridgeLog();
        var rollback = new CrashLoopRollbackController(
            fixture.Layout,
            stateStore,
            new NeverRunningRevitProbe());
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log,
            rollbackController: rollback);

        await supervisor.StartAsync(CancellationToken.None);
        Assert.Equal(4, launcher.StartCount);
        Assert.Equal(previous, launcher.LastStart!.WorkingDirectory);
        BridgeUpdateState state = await stateStore.ReadAsync(CancellationToken.None);
        Assert.Equal("1.0.0", state.ActiveVersion);
        Assert.Contains("2.0.0", state.QuarantinedVersions.Keys);

        Task<WorkerExit> monitor = supervisor.WaitForExitAsync(CancellationToken.None);
        _ = await supervisor.StopAsync(
            WorkerStopReason.HostShutdown,
            TimeSpan.FromSeconds(2),
            CancellationToken.None);
        WorkerExit exit = await monitor;
        Assert.False(exit.RestartBudgetExhausted);
    }

    [Fact]
    public async Task StartupCancellationDoesNotEnterCrashAccounting()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var fixture = new SupervisorFixture();
        string previous = Path.Combine(fixture.Layout.VersionsRoot, "1.0.0");
        string bad = Path.Combine(fixture.Layout.VersionsRoot, "2.0.0");
        Directory.CreateDirectory(previous);
        Directory.CreateDirectory(bad);
        File.WriteAllText(Path.Combine(previous, BridgeInstallLayout.WorkerExecutableName), "previous");
        File.WriteAllText(Path.Combine(bad, BridgeInstallLayout.WorkerExecutableName), "bad");
        var stateStore = new BridgeUpdateStateStore(fixture.Layout);
        await stateStore.WriteCurrentVersionAsync("2.0.0", CancellationToken.None);
        await stateStore.MutateAsync(
            state => state with
            {
                TenantBinding = "tenant-a",
                DeviceId = "device-1",
                AuthenticatedSessionId = "session-1",
                ActiveVersion = "2.0.0",
                PreviousVersion = "1.0.0",
                HighestAcceptedReleaseSequence = 2,
                AcceptedManifestDigest = "sha256:" + new string('a', 64),
                VersionActivatedAtUtc = DateTimeOffset.UtcNow,
            },
            CancellationToken.None);
        var launcher = new InProcessWorkerLauncher(
            "2.0.0",
            startupFailuresBeforeStable: 1,
            startupFailureStage: "hang_before_connect");
        await using var log = new NullBridgeLog();
        var rollback = new CrashLoopRollbackController(
            fixture.Layout,
            stateStore,
            new NeverRunningRevitProbe());
        await using var supervisor = new WorkerSupervisor(
            fixture.Layout,
            launcher,
            log,
            rollbackController: rollback);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => supervisor.StartAsync(cancellation.Token));
        BridgeUpdateState state = await stateStore.ReadAsync(CancellationToken.None);
        Assert.Empty(state.AbnormalExitTimesUtc);
        Assert.Equal("2.0.0", state.ActiveVersion);
    }

    private static string ValueAfter(
        IReadOnlyList<string> arguments,
        string option)
    {
        int index = arguments.IndexOf(option);
        Assert.InRange(index, 0, arguments.Count - 2);
        return arguments[index + 1];
    }

    private sealed class SupervisorFixture : IDisposable
    {
        private readonly string _root = Path.Combine(
            Path.GetTempPath(),
            $"revagent-bridge-supervisor-tests-{Guid.NewGuid():N}");

        internal SupervisorFixture()
        {
            Layout = new BridgeInstallLayout(
                Path.Combine(_root, "install"),
                Path.Combine(_root, "state"));
            Directory.CreateDirectory(Layout.CurrentWorkerDirectory);
            Directory.CreateDirectory(Layout.StateRoot);
            File.WriteAllText(Layout.WorkerExecutablePath, "worker");
            File.WriteAllText(Layout.ConfigurationPath, "{}");
        }

        internal BridgeInstallLayout Layout { get; }

        public void Dispose()
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
    }

    private sealed class InProcessWorkerLauncher : IWorkerProcessLauncher
    {
        private readonly string _probedVersion;
        private readonly string _readyVersion;
        private readonly bool _ignoreStop;
        private readonly bool _invalidStopping;
        private readonly int _unexpectedExitsBeforeStable;
        private readonly int _startupFailuresBeforeStable;
        private readonly string? _startupFailureStage;
        private int _startCount;

        internal InProcessWorkerLauncher(
            string probedVersion,
            string? readyVersion = null,
            bool ignoreStop = false,
            bool invalidStopping = false,
            int unexpectedExitsBeforeStable = 0,
            int startupFailuresBeforeStable = 0,
            string? startupFailureStage = null)
        {
            _probedVersion = probedVersion;
            _readyVersion = readyVersion ?? probedVersion;
            _ignoreStop = ignoreStop;
            _invalidStopping = invalidStopping;
            _unexpectedExitsBeforeStable = unexpectedExitsBeforeStable;
            _startupFailuresBeforeStable = startupFailuresBeforeStable;
            _startupFailureStage = startupFailureStage;
        }

        internal WorkerStartRequest? LastStart { get; private set; }
        internal FakeWorkerProcess? LastProcess { get; private set; }
        internal int StartCount => Volatile.Read(ref _startCount);

        public IWorkerProcess Start(WorkerStartRequest request)
        {
            LastStart = request;
            int startNumber = Interlocked.Increment(ref _startCount);
            var process = new FakeWorkerProcess(Environment.ProcessId);
            LastProcess = process;

            string pipeName = ValueAfter(request.Arguments, "--control-pipe");
            int hostPid = int.Parse(
                ValueAfter(request.Arguments, "--host-pid"),
                System.Globalization.CultureInfo.InvariantCulture);
            Guid instanceId = Guid.ParseExact(
                ValueAfter(request.Arguments, "--instance-id"),
                "D");
            _ = RunWorkerAsync(
                process,
                pipeName,
                hostPid,
                instanceId,
                startNumber <= _unexpectedExitsBeforeStable,
                startNumber <= _startupFailuresBeforeStable
                    ? _startupFailureStage
                    : null);
            return process;
        }

        public ValueTask<WorkerCommandResult> RunOneShotAsync(
            WorkerOneShotRequest request,
            TimeSpan timeout,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Assert.Equal(["--version"], request.Arguments);
            return ValueTask.FromResult(
                new WorkerCommandResult(
                    0,
                    _probedVersion + Environment.NewLine,
                    string.Empty,
                    false,
                    false));
        }

        private async Task RunWorkerAsync(
            FakeWorkerProcess process,
            string pipeName,
            int hostPid,
            Guid instanceId,
            bool exitUnexpectedly,
            string? startupFailureStage)
        {
            try
            {
                if (startupFailureStage == "before_connect")
                {
                    await Task.Delay(20);
                    process.Complete(42);
                    return;
                }

                if (startupFailureStage == "hang_before_connect")
                {
                    _ = await process.WaitForExitAsync(CancellationToken.None);
                    return;
                }

                await using ControlConnection connection =
                    await WorkerControlClient.ConnectAsync(
                        pipeName,
                        hostPid,
                        instanceId,
                        CancellationToken.None);
                if (startupFailureStage == "before_ready")
                {
                    await Task.Delay(20);
                    process.Complete(42);
                    return;
                }

                await connection.SendAsync(
                    new WorkerReady(
                        ControlProtocol.Version,
                        instanceId,
                        process.Id,
                        _readyVersion),
                    CancellationToken.None);
                if (exitUnexpectedly)
                {
                    await Task.Delay(50);
                    process.Complete(42);
                    return;
                }

                ControlMessage? message = await connection.ReceiveAsync(
                    CancellationToken.None);
                if (message is StopWorker && _ignoreStop)
                {
                    _ = await process.WaitForExitAsync(CancellationToken.None);
                    return;
                }

                if (message is StopWorker && _invalidStopping)
                {
                    await connection.SendAsync(
                        new WorkerStopping(
                            ControlProtocol.Version,
                            instanceId,
                            process.Id + 1),
                        CancellationToken.None);
                    _ = await process.WaitForExitAsync(CancellationToken.None);
                    return;
                }

                if (message is StopWorker)
                {
                    await connection.SendAsync(
                        new WorkerStopping(
                            ControlProtocol.Version,
                            instanceId,
                            process.Id),
                        CancellationToken.None);
                    process.Complete(0);
                }
            }
            catch (ObjectDisposedException)
            {
                process.Complete(-9);
            }
            catch (IOException)
            {
                process.Complete(-9);
            }
        }
    }

    private sealed class NeverRunningRevitProbe : IRevitProcessProbe
    {
        public bool IsRevitRunning() => false;
    }

    private sealed class FakeWorkerProcess : IWorkerProcess
    {
        private readonly TaskCompletionSource<int> _exit =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal FakeWorkerProcess(int id)
        {
            Id = id;
        }

        public int Id { get; }
        internal bool Killed { get; private set; }

        public async Task<int> WaitForExitAsync(
            CancellationToken cancellationToken) =>
            await _exit.Task.WaitAsync(cancellationToken);

        public ValueTask<WorkerProcessDiagnostics> GetDiagnosticsAsync() =>
            ValueTask.FromResult(
                new WorkerProcessDiagnostics(
                    string.Empty,
                    string.Empty,
                    false,
                    false));

        public void KillTree()
        {
            Killed = true;
            Complete(-9);
        }

        internal void Complete(int exitCode) =>
            _exit.TrySetResult(exitCode);

        public void Dispose()
        {
        }
    }

    private sealed class NullBridgeLog : IBridgeLog
    {
        public ValueTask WriteAsync(
            string level,
            string eventId,
            string category,
            string message,
            Exception? exception = null,
            CancellationToken cancellationToken = default) =>
            ValueTask.CompletedTask;

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

internal static class ReadOnlyListTestExtensions
{
    internal static int IndexOf(
        this IReadOnlyList<string> values,
        string value)
    {
        for (int index = 0; index < values.Count; index++)
        {
            if (string.Equals(values[index], value, StringComparison.Ordinal))
            {
                return index;
            }
        }

        return -1;
    }
}
