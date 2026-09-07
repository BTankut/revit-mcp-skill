using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Control;
using RevAgent.Bridge.Bootstrap.Logging;
using RevAgent.Bridge.Host.Update;

namespace RevAgent.Bridge.Host.Hosting;

internal enum WorkerStopReason
{
    ScmStop,
    ConsoleStop,
    HostShutdown,
    UpdateApply,
}

internal sealed record WorkerExit(
    int ExitCode,
    int RestartCount,
    bool RestartBudgetExhausted,
    WorkerProcessDiagnostics Diagnostics);

internal sealed record WorkerStopResult(
    bool Graceful,
    bool Forced,
    int? ExitCode,
    WorkerProcessDiagnostics Diagnostics);

internal sealed class WorkerSupervisor : IAsyncDisposable
{
    internal static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(30);
    internal static readonly TimeSpan GracefulStopTimeout = TimeSpan.FromSeconds(8);

    private const int MaxDiagnosticBytes = 64 * 1024;
    private const int MaxUnexpectedRestarts = 2;

    private static readonly TimeSpan[] RestartBackoff =
    [
        TimeSpan.FromSeconds(1),
        TimeSpan.FromSeconds(5),
    ];

    private readonly BridgeInstallLayout _layout;
    private readonly IWorkerProcessLauncher _launcher;
    private readonly IBridgeLog _log;
    private readonly TimeProvider _timeProvider;
    private readonly CrashLoopRollbackController? _rollbackController;
    private readonly SemaphoreSlim _lifecycleGate = new(1, 1);
    private readonly CancellationTokenSource _shutdownSource = new();

    private RunningWorker? _current;
    private int _stopRequested;
    private int _started;
    private int _disposed;
    private int _plannedUpdateRestart;

    internal WorkerSupervisor(
        BridgeInstallLayout layout,
        IWorkerProcessLauncher launcher,
        IBridgeLog log,
        TimeProvider? timeProvider = null,
        CrashLoopRollbackController? rollbackController = null)
    {
        _layout = layout ?? throw new ArgumentNullException(nameof(layout));
        _launcher = launcher ?? throw new ArgumentNullException(nameof(launcher));
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _timeProvider = timeProvider ?? TimeProvider.System;
        _rollbackController = rollbackController;
    }

    internal async Task StartAsync(CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        if (Interlocked.Exchange(ref _started, 1) != 0)
        {
            throw new InvalidOperationException("Worker supervisor was already started.");
        }

        await _lifecycleGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            using var startSource =
                CancellationTokenSource.CreateLinkedTokenSource(
                    cancellationToken,
                    _shutdownSource.Token);
            _current = await LaunchWorkerAsync(startSource.Token)
                .ConfigureAwait(false);
        }
        catch
        {
            Volatile.Write(ref _started, 0);
            throw;
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    internal async Task<WorkerExit> WaitForExitAsync(
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        EnsureStarted();

        int restartCount = 0;
        WorkerProcessDiagnostics lastDiagnostics = EmptyDiagnostics;
        int lastExitCode = -1;

        while (true)
        {
            RunningWorker worker = await GetCurrentAsync(cancellationToken)
                .ConfigureAwait(false);
            lastExitCode = await worker.Process
                .WaitForExitAsync(cancellationToken)
                .ConfigureAwait(false);
            lastDiagnostics = await worker.Process
                .GetDiagnosticsAsync()
                .ConfigureAwait(false);

            await LogDiagnosticsAsync(
                worker,
                lastExitCode,
                lastDiagnostics,
                cancellationToken).ConfigureAwait(false);

            bool plannedUpdateRestart =
                Interlocked.Exchange(ref _plannedUpdateRestart, 0) != 0;
            CrashRollbackResult? rollback =
                plannedUpdateRestart || _rollbackController is null || lastExitCode == 0
                ? null
                : await _rollbackController.RecordUnexpectedExitAsync(cancellationToken)
                    .ConfigureAwait(false);
            if (rollback?.RolledBack == true)
            {
                restartCount = 0;
                await TryLogAsync(
                    "error",
                    "worker_version_rolled_back",
                    $"Worker version '{rollback.QuarantinedVersion}' crashed " +
                    $"{rollback.CrashCount} times; restored '{rollback.ActiveVersion}' " +
                    "and quarantined the bad version.",
                    cancellationToken: cancellationToken).ConfigureAwait(false);
            }

            await _lifecycleGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (ReferenceEquals(_current, worker))
                {
                    await DisposeWorkerAsync(worker).ConfigureAwait(false);
                    _current = null;
                }

                if (Volatile.Read(ref _stopRequested) != 0)
                {
                    return new WorkerExit(
                        lastExitCode,
                        restartCount,
                        RestartBudgetExhausted: false,
                        lastDiagnostics);
                }

                if (restartCount >= MaxUnexpectedRestarts)
                {
                    return new WorkerExit(
                        lastExitCode,
                        restartCount,
                        RestartBudgetExhausted: true,
                        lastDiagnostics);
                }
            }
            finally
            {
                _lifecycleGate.Release();
            }

            bool launched = false;
            while (!launched)
            {
                if (restartCount >= MaxUnexpectedRestarts)
                {
                    return new WorkerExit(
                        lastExitCode,
                        restartCount,
                        RestartBudgetExhausted: true,
                        lastDiagnostics);
                }

                TimeSpan delay = RestartBackoff[restartCount];
                restartCount++;
                await TryLogAsync(
                    "warning",
                    "worker_restart_scheduled",
                    $"Worker exited with code {lastExitCode}; restart " +
                    $"{restartCount}/{MaxUnexpectedRestarts} follows in " +
                    $"{delay.TotalSeconds:0} seconds.",
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                using var restartSource =
                    CancellationTokenSource.CreateLinkedTokenSource(
                        cancellationToken,
                        _shutdownSource.Token);
                try
                {
                    await Task.Delay(delay, _timeProvider, restartSource.Token)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (
                    _shutdownSource.IsCancellationRequested &&
                    !cancellationToken.IsCancellationRequested)
                {
                    return new WorkerExit(
                        lastExitCode,
                        restartCount,
                        RestartBudgetExhausted: false,
                        lastDiagnostics);
                }

                try
                {
                    await _lifecycleGate.WaitAsync(cancellationToken)
                        .ConfigureAwait(false);
                    try
                    {
                        if (Volatile.Read(ref _stopRequested) != 0)
                        {
                            return new WorkerExit(
                                lastExitCode,
                                restartCount,
                                RestartBudgetExhausted: false,
                                lastDiagnostics);
                        }

                        _current = await LaunchWorkerAsync(restartSource.Token)
                            .ConfigureAwait(false);
                        launched = true;
                    }
                    finally
                    {
                        _lifecycleGate.Release();
                    }
                }
                catch (OperationCanceledException) when (
                    _shutdownSource.IsCancellationRequested &&
                    !cancellationToken.IsCancellationRequested)
                {
                    return new WorkerExit(
                        lastExitCode,
                        restartCount,
                        RestartBudgetExhausted: false,
                        lastDiagnostics);
                }
                catch (Exception ex) when (
                    ex is not OperationCanceledException ||
                    !cancellationToken.IsCancellationRequested)
                {
                    await TryLogAsync(
                        "error",
                        "worker_restart_failed",
                        $"Worker restart {restartCount}/{MaxUnexpectedRestarts} failed.",
                        ex,
                        cancellationToken).ConfigureAwait(false);
                    lastExitCode = -1;
                    lastDiagnostics = EmptyDiagnostics;
                }
            }
        }
    }

    internal async Task<WorkerStopResult> StopAsync(
        WorkerStopReason reason,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        EnsureStarted();
        if (timeout <= TimeSpan.Zero || timeout > GracefulStopTimeout)
        {
            throw new ArgumentOutOfRangeException(
                nameof(timeout),
                $"Worker stop timeout must be in (0, {GracefulStopTimeout.TotalSeconds}] seconds.");
        }

        Interlocked.Exchange(ref _stopRequested, 1);
        _shutdownSource.Cancel();
        await _lifecycleGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RunningWorker? worker = _current;
            if (worker is null)
            {
                return new WorkerStopResult(
                    Graceful: true,
                    Forced: false,
                    ExitCode: null,
                    EmptyDiagnostics);
            }

            using var stopSource = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken);
            stopSource.CancelAfter(timeout);

            try
            {
                var stop = new StopWorker(
                    ControlProtocol.Version,
                    worker.InstanceId,
                    ToWireReason(reason),
                    _timeProvider.GetUtcNow().Add(timeout).ToUnixTimeMilliseconds());
                await worker.Connection.SendAsync(stop, stopSource.Token)
                    .ConfigureAwait(false);

                Task<ControlMessage?> acknowledgement = worker.Connection
                    .ReceiveAsync(stopSource.Token)
                    .AsTask();
                Task<int> exit = worker.Process.WaitForExitAsync(stopSource.Token);
                Task first = await Task.WhenAny(acknowledgement, exit)
                    .ConfigureAwait(false);

                if (ReferenceEquals(first, acknowledgement))
                {
                    ControlMessage? message = await acknowledgement.ConfigureAwait(false);
                    if (message is not WorkerStopping stopping ||
                        stopping.WorkerPid != worker.Process.Id)
                    {
                        throw new ControlProtocolException(
                            "control_stopping_invalid",
                            "Worker did not return the expected STOPPING acknowledgement.");
                    }
                }

                int exitCode = await exit.ConfigureAwait(false);
                WorkerProcessDiagnostics diagnostics = await worker.Process
                    .GetDiagnosticsAsync()
                    .ConfigureAwait(false);
                await DisposeCurrentAsync(worker).ConfigureAwait(false);
                return new WorkerStopResult(
                    Graceful: true,
                    Forced: false,
                    exitCode,
                    diagnostics);
            }
            catch (OperationCanceledException) when (
                !cancellationToken.IsCancellationRequested)
            {
                return await ForceStopAsync(
                    worker,
                    $"Worker did not stop within {timeout.TotalSeconds:0.###} seconds; " +
                    "the process tree was terminated.").ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                WorkerStopResult forced = await ForceStopAsync(
                    worker,
                    "Worker control shutdown failed; the process tree was terminated.",
                    ex).ConfigureAwait(false);
                if (ex is OperationCanceledException &&
                    cancellationToken.IsCancellationRequested)
                {
                    throw;
                }

                return forced;
            }
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    internal async Task RequestUpdateRestartAsync(
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        EnsureStarted();
        await _lifecycleGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            RunningWorker worker = _current ??
                throw new InvalidOperationException("No Bridge worker is running.");
            Interlocked.Exchange(ref _plannedUpdateRestart, 1);
            using var restartSource = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken);
            restartSource.CancelAfter(GracefulStopTimeout);
            try
            {
                var stop = new StopWorker(
                    ControlProtocol.Version,
                    worker.InstanceId,
                    ToWireReason(WorkerStopReason.UpdateApply),
                    _timeProvider.GetUtcNow()
                        .Add(GracefulStopTimeout)
                        .ToUnixTimeMilliseconds());
                await worker.Connection.SendAsync(stop, restartSource.Token)
                    .ConfigureAwait(false);
                ControlMessage? acknowledgement = await worker.Connection
                    .ReceiveAsync(restartSource.Token).ConfigureAwait(false);
                if (acknowledgement is not WorkerStopping stopping ||
                    stopping.WorkerPid != worker.Process.Id)
                {
                    throw new ControlProtocolException(
                        "control_stopping_invalid",
                        "Worker did not acknowledge the update restart.");
                }

                _ = await worker.Process.WaitForExitAsync(restartSource.Token)
                    .ConfigureAwait(false);
            }
            catch
            {
                worker.Process.KillTree();
                throw;
            }
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    private async Task<WorkerStopResult> ForceStopAsync(
        RunningWorker worker,
        string message,
        Exception? exception = null)
    {
        worker.Process.KillTree();
        int exitCode = await worker.Process
            .WaitForExitAsync(CancellationToken.None)
            .ConfigureAwait(false);
        WorkerProcessDiagnostics diagnostics = await worker.Process
            .GetDiagnosticsAsync()
            .ConfigureAwait(false);
        await TryLogAsync(
            "error",
            "worker_stop_forced",
            message,
            exception,
            CancellationToken.None).ConfigureAwait(false);
        await DisposeCurrentAsync(worker).ConfigureAwait(false);
        return new WorkerStopResult(
            Graceful: false,
            Forced: true,
            exitCode,
            diagnostics);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        Interlocked.Exchange(ref _stopRequested, 1);
        _shutdownSource.Cancel();
        await _lifecycleGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_current is not null)
            {
                _current.Process.KillTree();
                await DisposeWorkerAsync(_current).ConfigureAwait(false);
                _current = null;
            }
        }
        finally
        {
            _lifecycleGate.Release();
            _lifecycleGate.Dispose();
            _shutdownSource.Dispose();
        }
    }

    private async Task<RunningWorker> LaunchWorkerAsync(
        CancellationToken cancellationToken)
    {
        ResolvedWorkerExecutable resolved = WorkerExecutableResolver.Resolve(_layout);
        if (!Path.IsPathFullyQualified(_layout.ConfigurationPath) ||
            !File.Exists(_layout.ConfigurationPath))
        {
            throw new FileNotFoundException(
                "Bridge configuration file is missing or not absolute.",
                _layout.ConfigurationPath);
        }

        Directory.CreateDirectory(_layout.BundleExtractionRoot);
        IReadOnlyDictionary<string, string> environment =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["DOTNET_BUNDLE_EXTRACT_BASE_DIR"] = _layout.BundleExtractionRoot,
            };

        WorkerCommandResult versionResult = await _launcher.RunOneShotAsync(
            new WorkerOneShotRequest(
                resolved.ExecutablePath,
                resolved.WorkingDirectory,
                ["--version"],
                environment,
                MaxOutputBytes: 1024),
            timeout: TimeSpan.FromSeconds(5),
            cancellationToken).ConfigureAwait(false);
        string expectedVersion = ParseVersionResult(versionResult);

        Guid instanceId = Guid.NewGuid();
        HostControlServer server = HostControlServer.Create(instanceId);
        IWorkerProcess? process = null;
        ControlConnection? connection = null;
        try
        {
            process = _launcher.Start(
                new WorkerStartRequest(
                    resolved.ExecutablePath,
                    resolved.WorkingDirectory,
                    [
                        "__worker",
                        "--control-pipe",
                        server.PipeName,
                        "--host-pid",
                        Environment.ProcessId.ToString(
                            System.Globalization.CultureInfo.InvariantCulture),
                        "--instance-id",
                        instanceId.ToString("D"),
                        "--config",
                        _layout.ConfigurationPath,
                    ],
                    environment,
                    MaxDiagnosticBytes));

            using var startupSource =
                CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            startupSource.CancelAfter(StartupTimeout);

            Task<ControlConnection> accept = server
                .AcceptAsync(process.Id, startupSource.Token)
                .AsTask();
            Task<int> earlyExit = process.WaitForExitAsync(startupSource.Token);
            Task first = await Task.WhenAny(accept, earlyExit).ConfigureAwait(false);
            if (ReferenceEquals(first, earlyExit))
            {
                int exitCode = await earlyExit.ConfigureAwait(false);
                WorkerProcessDiagnostics diagnostics =
                    await process.GetDiagnosticsAsync().ConfigureAwait(false);
                throw new WorkerStartupException(
                    "worker_exited_before_connect",
                    $"Worker exited with code {exitCode} before connecting. " +
                    FormatDiagnostics(diagnostics));
            }

            connection = await accept.ConfigureAwait(false);
            Task<ControlMessage?> receiveReady = connection
                .ReceiveAsync(startupSource.Token)
                .AsTask();
            first = await Task.WhenAny(receiveReady, earlyExit).ConfigureAwait(false);
            if (ReferenceEquals(first, earlyExit))
            {
                int exitCode = await earlyExit.ConfigureAwait(false);
                WorkerProcessDiagnostics diagnostics =
                    await process.GetDiagnosticsAsync().ConfigureAwait(false);
                throw new WorkerStartupException(
                    "worker_exited_before_ready",
                    $"Worker exited with code {exitCode} before READY. " +
                    FormatDiagnostics(diagnostics));
            }

            ControlMessage? message = await receiveReady.ConfigureAwait(false);
            if (message is not WorkerReady ready)
            {
                throw new WorkerStartupException(
                    "worker_ready_missing",
                    "Worker control stream ended or returned a non-READY first message.");
            }

            if (ready.WorkerPid != process.Id)
            {
                throw new WorkerStartupException(
                    "worker_ready_pid_mismatch",
                    $"READY PID {ready.WorkerPid} does not match worker PID {process.Id}.");
            }

            if (!string.Equals(
                ready.WorkerVersion,
                expectedVersion,
                StringComparison.Ordinal))
            {
                throw new WorkerStartupException(
                    "worker_ready_version_mismatch",
                    $"READY version '{ready.WorkerVersion}' does not match probed " +
                    $"worker version '{expectedVersion}'.");
            }

            await TryLogAsync(
                "information",
                "worker_ready",
                $"Worker PID {process.Id} version '{expectedVersion}' is ready.",
                cancellationToken: cancellationToken).ConfigureAwait(false);
            return new RunningWorker(
                instanceId,
                expectedVersion,
                server,
                connection,
                process);
        }
        catch
        {
            if (process is not null)
            {
                process.KillTree();
                process.Dispose();
            }

            if (connection is not null)
            {
                await connection.DisposeAsync().ConfigureAwait(false);
            }

            await server.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private async Task<RunningWorker> GetCurrentAsync(
        CancellationToken cancellationToken)
    {
        await _lifecycleGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return _current ??
                throw new InvalidOperationException("No worker is currently running.");
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    private async ValueTask DisposeCurrentAsync(RunningWorker worker)
    {
        if (ReferenceEquals(_current, worker))
        {
            await DisposeWorkerAsync(worker).ConfigureAwait(false);
            _current = null;
        }
    }

    private static async ValueTask DisposeWorkerAsync(RunningWorker worker)
    {
        await worker.Connection.DisposeAsync().ConfigureAwait(false);
        await worker.Server.DisposeAsync().ConfigureAwait(false);
        worker.Process.Dispose();
    }

    private async ValueTask LogDiagnosticsAsync(
        RunningWorker worker,
        int exitCode,
        WorkerProcessDiagnostics diagnostics,
        CancellationToken cancellationToken)
    {
        string message =
            $"Worker PID {worker.Process.Id} version '{worker.Version}' exited " +
            $"with code {exitCode}. {FormatDiagnostics(diagnostics)}";
        await TryLogAsync(
            exitCode == 0 ? "information" : "error",
            "worker_exited",
            message,
            cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask TryLogAsync(
        string level,
        string eventId,
        string message,
        Exception? exception = null,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await _log.WriteAsync(
                level,
                eventId,
                "host.lifecycle",
                message,
                exception,
                cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            // Logging must not own service or worker lifecycle.
        }
    }

    private static string ParseVersionResult(WorkerCommandResult result)
    {
        if (result.ExitCode != 0 ||
            result.StandardOutputTruncated ||
            result.StandardErrorTruncated ||
            !string.IsNullOrWhiteSpace(result.StandardError))
        {
            throw new WorkerStartupException(
                "worker_version_probe_failed",
                $"Worker --version failed with exit code {result.ExitCode}. " +
                $"stderr='{BoundForMessage(result.StandardError)}'.");
        }

        string version = result.StandardOutput.Trim();
        if (string.IsNullOrWhiteSpace(version) ||
            version.Length > 128 ||
            version.Contains('\r', StringComparison.Ordinal) ||
            version.Contains('\n', StringComparison.Ordinal))
        {
            throw new WorkerStartupException(
                "worker_version_invalid",
                "Worker --version must emit exactly one non-empty version line.");
        }

        return version;
    }

    private static string FormatDiagnostics(WorkerProcessDiagnostics diagnostics) =>
        $"stdout='{BoundForMessage(diagnostics.StandardOutput)}'" +
        $"{(diagnostics.StandardOutputTruncated ? " (truncated)" : string.Empty)}, " +
        $"stderr='{BoundForMessage(diagnostics.StandardError)}'" +
        $"{(diagnostics.StandardErrorTruncated ? " (truncated)" : string.Empty)}";

    private static string BoundForMessage(string value)
    {
        const int maxCharacters = 2048;
        string normalized = value.Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal);
        return normalized.Length <= maxCharacters
            ? normalized
            : normalized[..maxCharacters] + "…";
    }

    private static string ToWireReason(WorkerStopReason reason) =>
        reason switch
        {
            WorkerStopReason.ScmStop => "scm_stop",
            WorkerStopReason.ConsoleStop => "console_stop",
            WorkerStopReason.HostShutdown => "host_shutdown",
            WorkerStopReason.UpdateApply => "update_apply",
            _ => throw new ArgumentOutOfRangeException(nameof(reason)),
        };

    private void EnsureStarted()
    {
        if (Volatile.Read(ref _started) == 0)
        {
            throw new InvalidOperationException("Worker supervisor has not started.");
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(
            Volatile.Read(ref _disposed) != 0,
            this);
    }

    private static WorkerProcessDiagnostics EmptyDiagnostics { get; } =
        new(string.Empty, string.Empty, false, false);

    private sealed record RunningWorker(
        Guid InstanceId,
        string Version,
        HostControlServer Server,
        ControlConnection Connection,
        IWorkerProcess Process);
}

internal sealed class WorkerStartupException : Exception
{
    internal WorkerStartupException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    internal string Code { get; }
}
