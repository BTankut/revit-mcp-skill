using System.Collections.Concurrent;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Updates;
using RevAgent.Bridge.Tests.Gateway.Storage;

namespace RevAgent.Bridge.Tests.Gateway.Connection;

public sealed partial class RbpConnectionCoordinatorTests
{
    private static RbpConnectionCoordinator Coordinator(
        IRbpConnectionCycleFactory factory,
        RbpJournalStore store,
        IRbpLocalSessionCatalog catalog,
        ManualCoordinatorClock clock,
        IRbpInboundDataJournal? inbound = null,
        IRbpRandomSource? random = null,
        TimeSpan? closeTimeout = null,
        IRbpInvocationDispatcher? invocationDispatcher = null,
        TimeSpan? invocationDrainTimeout = null,
        Func<RbpConnectionFailureObservation, ValueTask>?
            onConnectionFailureObservation = null,
        IRbpRecoveryCarrierObservationSink?
            recoveryCarrierObservationSink = null,
        RbpHelloProfile? helloProfile = null,
        RbpDocContextWatcher? docContextWatcher = null,
        BridgeUpdateReportStore? updateReports = null) =>
        new(
            factory,
            store,
            catalog,
            new RbpConnectionCoordinatorOptions(
                new Uri("wss://gateway.revagent.app/bridge/v1"),
                helloProfile ?? new RbpHelloProfile(
                    "0.1.0",
                    "WS01",
                    "Windows 11",
                    new[] { "2026.07.26.0" }),
                CloseTimeout: closeTimeout,
                InvocationDrainTimeout: invocationDrainTimeout),
            invocationDispatcher ?? new StubInvocationDispatcher(),
            inbound,
            clock,
            random ?? new FixedRandomSource(0),
            onConnectionFailureObservation:
                onConnectionFailureObservation,
            recoveryCarrierObservationSink:
                recoveryCarrierObservationSink,
            docContextWatcher: docContextWatcher,
            updateReports: updateReports);

    private static RbpJournalStore OpenStore(
        RbpJournalTestDirectory directory,
        ManualCoordinatorClock clock,
        IRbpJournalFaultInjector? faultInjector = null) =>
        RbpJournalStore.Open(
            directory.JournalPath,
            new TestResumeTokenProtector(),
            new RbpJournalOpenOptions(
                NowMilliseconds:
                    () => clock.UtcNow.ToUnixTimeMilliseconds(),
                FaultInjector: faultInjector));

    private static RbpSessionRegistration Registration(
        RbpLocalSessionSnapshot local,
        string rsid) =>
        new(
            rsid,
            local.LocalSessionKey,
            local.RegistrationPayload,
            "resume-token-" + rsid,
            DateTimeOffset.Parse("2026-07-27T10:00:00.000Z"),
            Array.Empty<string>());

    private static RbpLocalSessionSnapshot LocalSession(
        int port,
        int processId)
    {
        string localKey = $"port:{port}:pid:{processId}:started:100";
        return new RbpLocalSessionSnapshot(
            localKey,
            Json(
                $$"""
                {
                  "local_session_key":"{{localKey}}",
                  "user_hint":{"name":"BT"},
                  "machine":{
                    "hostname":"WS01",
                    "fingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                  },
                  "revit":{
                    "version":"2024",
                    "build":"24.1",
                    "pid":{{processId}}
                  },
                  "addin_version":"2026.07.26.0",
                  "result_contract_version":2,
                  "session_capabilities":[],
                  "bridge_version":"0.1.0",
                  "documents":[],
                  "port":{{port}}
                }
                """),
            port,
            Json("""{"active_task":null,"addin_reachable":true}"""));
    }

    private static RbpEnvelope DataEnvelope(
        string type,
        string id,
        string rsid,
        long sequence,
        JsonElement payload) =>
        new(
            1,
            type,
            id,
            "2026-07-26T10:00:00.000Z",
            payload,
            RbpEnvelopeScope.Data,
            rsid,
            sequence,
            Acknowledgement: null,
            Hello: null,
            HelloAck: null,
            RbpEnvelopeDisposition.Known,
            RbpEnvelope.FreezeAdditionalProperties(
                new Dictionary<string, JsonElement>()));

    private static JsonElement Json(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static string Id(int suffix) =>
        $"019f9add-7a83-7d11-a6a9-d2f8108c{suffix:0000}";

    private static async Task EventuallyAsync(
        Func<bool> predicate,
        int attempts = 4_000)
    {
        for (int attempt = 0; attempt < attempts; attempt++)
        {
            if (predicate())
            {
                return;
            }

            await Task.Delay(5);
        }

        Assert.Fail("The deterministic coordinator condition was not met.");
    }

    private static async Task EventuallyAsync(
        Func<Task<bool>> predicate,
        int attempts = 4_000)
    {
        for (int attempt = 0; attempt < attempts; attempt++)
        {
            if (await predicate())
            {
                return;
            }

            await Task.Delay(5);
        }

        Assert.Fail("The deterministic coordinator condition was not met.");
    }

    private static async Task<Task<RbpCoordinatorTeardownResult>>
        RequestNormalStopTeardownWhenReadyAsync(
            RbpConnectionCoordinator coordinator)
    {
        object coordinatorSync = typeof(RbpConnectionCoordinator).GetField(
            "_sync", BindingFlags.Instance | BindingFlags.NonPublic)?
            .GetValue(coordinator) ?? throw new InvalidOperationException(
                "Coordinator synchronization root was unavailable.");
        for (int attempt = 0; attempt < 1_000; attempt++)
        {
            lock (coordinatorSync)
            {
                RbpConnectionCoordinatorSnapshot current =
                    coordinator.GetSnapshot();
                if (current.ActiveInvocationCount == 0 &&
                    AttemptStopState(coordinator) is 2 or 5)
                {
                    return coordinator.RequestStopTeardown();
                }
            }
            await Task.Delay(5);
        }

        Assert.Fail(
            "The coordinator never reached a normal-stop state. " +
            NormalStopWaitDiagnostic(coordinator));
        throw new InvalidOperationException("Unreachable normal-stop path.");
    }

    private static async Task ExecuteWithFailurePreservingCoordinatorCleanupAsync(
        RbpConnectionCoordinator coordinator,
        CancellationTokenSource stop,
        Task run,
        Func<Task> operation,
        Func<Task>? afterCleanup = null)
    {
        Exception? primaryFailure = null;
        try
        {
            await operation();
        }
        catch (Exception exception)
        {
            primaryFailure = exception;
            throw;
        }
        finally
        {
            if (!run.IsCompleted)
            {
                Exception? cleanupFailure =
                    await StopCoordinatorAfterFailureAsync(
                        coordinator, stop, run);
                if (afterCleanup is not null)
                {
                    try
                    {
                        await afterCleanup();
                    }
                    catch (Exception exception)
                    {
                        cleanupFailure = CombineCleanupFailures(
                            cleanupFailure, exception);
                    }
                }

                if (cleanupFailure is not null)
                {
                    if (primaryFailure is null) throw cleanupFailure;
                    primaryFailure.Data["normal-stop-cleanup-failure"] =
                        ExceptionDiagnostic(cleanupFailure);
                }
            }
        }
    }

    private static async Task<Exception?> StopCoordinatorAfterFailureAsync(
        RbpConnectionCoordinator coordinator,
        CancellationTokenSource stop,
        Task run)
    {
        Exception? cleanupFailure = null;
        Task<RbpCoordinatorTeardownResult>? teardown = null;
        RbpCoordinatorTeardownResult? result = null;
        try
        {
            teardown = coordinator.RequestStopTeardown();
        }
        catch (Exception exception)
        {
            cleanupFailure = CombineCleanupFailures(cleanupFailure, exception);
        }

        try
        {
            stop.Cancel();
        }
        catch (Exception exception)
        {
            cleanupFailure = CombineCleanupFailures(cleanupFailure, exception);
        }

        if (teardown is not null)
        {
            try
            {
                result = await teardown.WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch (Exception exception)
            {
                cleanupFailure = CombineCleanupFailures(
                    cleanupFailure, exception);
            }
        }

        try
        {
            await run.WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (RbpCoordinatorException) when (
            result?.Disposition ==
                RbpCoordinatorTeardownDisposition.EmergencyMustExit)
        {
            // The primary failure remains authoritative; this is the expected
            // terminal signal from fail-closed coordinator cleanup.
        }
        catch (Exception exception)
        {
            cleanupFailure = CombineCleanupFailures(cleanupFailure, exception);
        }

        return cleanupFailure;
    }

    private static Exception CombineCleanupFailures(
        Exception? existing,
        Exception next) => existing is null ? next :
        new AggregateException(existing, next);

    private static string NormalStopWaitDiagnostic(
        RbpConnectionCoordinator coordinator)
    {
        object coordinatorSync = typeof(RbpConnectionCoordinator).GetField(
            "_sync", BindingFlags.Instance | BindingFlags.NonPublic)?
            .GetValue(coordinator) ?? throw new InvalidOperationException(
                "Coordinator synchronization root was unavailable.");
        lock (coordinatorSync)
        {
            RbpConnectionCoordinatorSnapshot snapshot =
                coordinator.GetSnapshot();
            Task<RbpCoordinatorTeardownResult>? retainedTeardown =
                PrivateMemberValue(coordinator, "_retainedTeardownOwner") as
                Task<RbpCoordinatorTeardownResult>;
            object? teardownResultSource = PrivateMemberValue(
                coordinator, "_teardownResult");
            Task<RbpCoordinatorTeardownResult>? teardownResult =
                PrivateMemberValue(teardownResultSource, "Task") as
                Task<RbpCoordinatorTeardownResult>;
            object? resources = PrivateMemberValue(
                coordinator, "_attemptTeardownResources");
            object? authorityPoisoned = PrivateMemberValue(
                coordinator, "_connectionAuthorityPoisoned");
            object? routeAuthorityEpoch = PrivateMemberValue(
                resources, "RouteAuthorityEpoch");
            object? shutdownRequested = PrivateMemberValue(
                resources, "ShutdownRequested");
            object? journalGenerationActivated = PrivateMemberValue(
                resources, "JournalGenerationActivated");
            object? deadline = PrivateMemberValue(
                resources, "DeadlineTimestamp");
            object? secondaryFault = PrivateMemberValue(
                resources, "SecondaryFault");
            return string.Join(
                "; ",
                $"rawStopState={AttemptStopState(coordinator)}",
                $"authorityPoisoned={authorityPoisoned ?? "unavailable"}",
                $"snapshotPhase={snapshot.Lifecycle.Phase}",
                $"snapshotGeneration={snapshot.ConnectionGeneration}",
                $"snapshotActiveConnection={snapshot.HasActiveConnection}",
                $"snapshotRsids=[{string.Join(',', snapshot.ActiveRsids)}]",
                $"snapshotOwnedTasks={snapshot.OwnedBackgroundTaskCount}",
                $"snapshotInvocations={snapshot.ActiveInvocationCount}",
                TeardownDiagnostic("retainedTeardown", retainedTeardown),
                TeardownDiagnostic("teardownResult", teardownResult),
                $"resourcesRouteAuthorityEpoch={routeAuthorityEpoch ?? "none"}",
                $"resourcesShutdownRequested={shutdownRequested ?? "none"}",
                $"resourcesJournalGenerationActivated=" +
                $"{journalGenerationActivated ?? "none"}",
                $"resourcesDeadline={deadline ?? "none"}",
                $"resourcesSecondaryFault={ExceptionDiagnostic(secondaryFault)}");
        }
    }

    private static string TeardownDiagnostic(
        string name,
        Task<RbpCoordinatorTeardownResult>? teardown)
    {
        if (teardown is null) return $"{name}Task=null; {name}Result=null";
        if (teardown.IsCompletedSuccessfully)
        {
            RbpCoordinatorTeardownResult result = teardown.Result;
            return $"{name}Task={teardown.Status}; {name}Result=" +
                $"{result.Disposition}; {name}Deadline=" +
                $"{result.DeadlineTimestamp?.ToString() ?? "none"}";
        }

        return $"{name}Task={teardown.Status}; {name}Result=unavailable; " +
            $"{name}Fault={ExceptionDiagnostic(teardown.Exception)}";
    }

    private static string ExceptionDiagnostic(object? value) => value switch
    {
        null => "none",
        Exception exception =>
            $"{exception.GetType().Name}:{exception.Message}",
        _ => value.ToString() ?? value.GetType().Name,
    };

    private static object? PrivateMemberValue(object? source, string name)
    {
        if (source is null) return null;
        const BindingFlags flags = BindingFlags.Instance |
            BindingFlags.Public | BindingFlags.NonPublic;
        Type type = source.GetType();
        return type.GetField(name, flags)?.GetValue(source) ??
            type.GetProperty(name, flags)?.GetValue(source);
    }

    private sealed class MutableSessionCatalog : IRbpLocalSessionCatalog
    {
        private readonly object _sync = new();
        private RbpLocalSessionSnapshot[] _sessions;

        internal MutableSessionCatalog(
            params RbpLocalSessionSnapshot[] sessions)
        {
            _sessions = sessions;
        }

        public Task<IReadOnlyList<RbpLocalSessionSnapshot>> ReadAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (_sync)
            {
                return Task.FromResult<IReadOnlyList<
                    RbpLocalSessionSnapshot>>(
                    Array.AsReadOnly(_sessions.ToArray()));
            }
        }

        internal void Replace(params RbpLocalSessionSnapshot[] sessions)
        {
            lock (_sync)
            {
                _sessions = sessions;
            }
        }
    }

    private sealed class RecordingInboundJournal : IRbpInboundDataJournal
    {
        private int _count;

        internal int Count => Volatile.Read(ref _count);

        public RbpInboundJournalReceipt Journal(
            RbpJournalWriteContext context,
            RbpDataEnvelopeSnapshot envelope)
        {
            _ = context;
            Interlocked.Increment(ref _count);

            // The compacted receipt row accepts only a bounded correlation id
            // plus a lowercase SHA-256 digest of the journal record; arbitrary
            // context JSON is rejected fail-closed by MarkInboundJournaled.
            return new RbpInboundJournalReceipt(
                envelope.Id,
                "sha256:" +
                Convert.ToHexString(
                        SHA256.HashData(
                            Encoding.UTF8.GetBytes(
                                $"journal-record:{envelope.Rsid}:{envelope.Sequence}:{envelope.Id}")))
                    .ToLowerInvariant());
        }
    }

    private sealed class FixedRandomSource : IRbpRandomSource
    {
        private readonly double _sample;

        internal FixedRandomSource(double sample)
        {
            _sample = sample;
        }

        public void Fill(Span<byte> destination)
        {
            destination.Clear();
        }

        public double NextUnitInterval() => _sample;
    }

    private sealed class BlockingJournalFaultInjector :
        IRbpJournalFaultInjector
    {
        private readonly object _sync = new();
        private RbpJournalFaultPoint? _armed;
        private TaskCompletionSource _entered = NewCompletion();
        private TaskCompletionSource _release = NewCompletion();
        private int _hitCount;

        internal Task Entered
        {
            get
            {
                lock (_sync)
                {
                    return _entered.Task;
                }
            }
        }

        internal int HitCount => Volatile.Read(ref _hitCount);

        internal void Arm(RbpJournalFaultPoint point)
        {
            lock (_sync)
            {
                if (_armed is not null)
                {
                    throw new InvalidOperationException(
                        "A journal fault is already armed.");
                }

                _entered = NewCompletion();
                _release = NewCompletion();
                _armed = point;
            }
        }

        internal void Release()
        {
            TaskCompletionSource release;
            lock (_sync)
            {
                release = _release;
            }

            release.TrySetResult();
        }

        public void Hit(RbpJournalFaultPoint point)
        {
            TaskCompletionSource? entered = null;
            Task? release = null;
            lock (_sync)
            {
                if (_armed == point)
                {
                    _armed = null;
                    entered = _entered;
                    release = _release.Task;
                }
            }

            if (entered is null || release is null)
            {
                return;
            }

            Interlocked.Increment(ref _hitCount);
            entered.TrySetResult();
            release.GetAwaiter().GetResult();
        }

        private static TaskCompletionSource NewCompletion() =>
            new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed class ManualCoordinatorClock : IRbpCoordinatorClock
    {
        private readonly object _sync = new();
        private readonly List<ScheduledDelay> _delays = new();
        private DateTimeOffset _utcNow =
            DateTimeOffset.Parse("2026-07-26T10:00:00.000Z");
        private long _monotonicMilliseconds;

        public DateTimeOffset UtcNow
        {
            get
            {
                lock (_sync)
                {
                    return _utcNow;
                }
            }
        }

        public long MonotonicMilliseconds
        {
            get
            {
                lock (_sync)
                {
                    return _monotonicMilliseconds;
                }
            }
        }

        public Task DelayAsync(
            TimeSpan delay,
            CancellationToken cancellationToken = default)
        {
            if (delay <= TimeSpan.Zero)
            {
                cancellationToken.ThrowIfCancellationRequested();
                return Task.CompletedTask;
            }

            lock (_sync)
            {
                var completion = new TaskCompletionSource(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                var scheduled = new ScheduledDelay(
                    checked(
                        _monotonicMilliseconds +
                        (long)Math.Ceiling(delay.TotalMilliseconds)),
                    completion);
                _delays.Add(scheduled);
                if (cancellationToken.CanBeCanceled)
                {
                    _ = cancellationToken.Register(
                        () => completion.TrySetCanceled(cancellationToken));
                }

                return completion.Task;
            }
        }

        internal void Advance(TimeSpan amount)
        {
            TaskCompletionSource[] ready;
            lock (_sync)
            {
                long milliseconds =
                    checked((long)Math.Round(amount.TotalMilliseconds));
                _monotonicMilliseconds =
                    checked(_monotonicMilliseconds + milliseconds);
                _utcNow = _utcNow.AddMilliseconds(milliseconds);
                ready = _delays
                    .Where(item =>
                        item.DueMilliseconds <= _monotonicMilliseconds)
                    .Select(item => item.Completion)
                    .ToArray();
                _delays.RemoveAll(item =>
                    item.DueMilliseconds <= _monotonicMilliseconds);
            }

            foreach (TaskCompletionSource completion in ready)
            {
                completion.TrySetResult();
            }
        }

        internal bool HasDelayDueIn(TimeSpan delay)
        {
            lock (_sync)
            {
                long due = checked(
                    _monotonicMilliseconds +
                    (long)Math.Ceiling(delay.TotalMilliseconds));
                return _delays.Any(item => item.DueMilliseconds == due);
            }
        }

        internal bool HasOutstandingDelayDueIn(TimeSpan delay)
        {
            lock (_sync)
            {
                long due = checked(
                    _monotonicMilliseconds +
                    (long)Math.Ceiling(delay.TotalMilliseconds));
                return _delays.Any(item =>
                    item.DueMilliseconds == due &&
                    !item.Completion.Task.IsCompleted);
            }
        }

        internal int OutstandingDelayCountDueIn(TimeSpan delay)
        {
            lock (_sync)
            {
                long due = checked(
                    _monotonicMilliseconds +
                    (long)Math.Ceiling(delay.TotalMilliseconds));
                return _delays.Count(item =>
                    item.DueMilliseconds == due &&
                    !item.Completion.Task.IsCompleted);
            }
        }

        private sealed record ScheduledDelay(
            long DueMilliseconds,
            TaskCompletionSource Completion);
    }

    private sealed class FakeConnectionCycleFactory :
        IRbpConnectionCycleFactory
    {
        private readonly object _sync = new();
        private readonly Queue<FakeConnectionCycle> _cycles;
        private int _openCount;

        internal FakeConnectionCycleFactory(
            params FakeConnectionCycle[] cycles)
        {
            _cycles = new Queue<FakeConnectionCycle>(cycles);
        }

        internal int OpenCount => Volatile.Read(ref _openCount);

        public RbpConnectionBindingKind BindingKind =>
            RbpConnectionBindingKind.Wss;

        public Task<IRbpConnectionCycle> OpenAsync(
            Uri endpoint,
            RbpHelloProfile profile,
            CancellationToken cancellationToken = default)
        {
            _ = endpoint;
            _ = profile;
            cancellationToken.ThrowIfCancellationRequested();
            lock (_sync)
            {
                Interlocked.Increment(ref _openCount);
                if (_cycles.Count == 0)
                {
                    throw new IOException(
                        "No scripted Gateway connection remains.");
                }

                return Task.FromResult<IRbpConnectionCycle>(
                    _cycles.Dequeue());
            }
        }
    }

    private sealed class FakeConnectionCycle : IRbpConnectionCycle
    {
        private readonly Channel<RbpEnvelope> _inbound =
            Channel.CreateUnbounded<RbpEnvelope>();
        private readonly Func<RbpEnvelope, RbpEnvelope?> _responder;
        private readonly bool _hangCloseAndDispose;
        private readonly bool _leaveInboundOpenAfterClose;
        private readonly Func<FakeConnectionCycle, RbpEnvelope,
            CancellationToken, Task>? _sendBehavior;
        private readonly Action? _onCloseStarted;
        private int _closeCount;
        private int _disposeCount;

        internal FakeConnectionCycle(
            Func<RbpEnvelope, RbpEnvelope?> responder,
            bool hangCloseAndDispose = false,
            bool leaveInboundOpenAfterClose = false,
            Func<FakeConnectionCycle, RbpEnvelope, CancellationToken, Task>?
                sendBehavior = null,
            IReadOnlyList<string>? grantedConnectionCapabilities = null,
            string connectionId = "conn-test",
            Action? onCloseStarted = null)
        {
            _responder = responder;
            _hangCloseAndDispose = hangCloseAndDispose;
            _leaveInboundOpenAfterClose = leaveInboundOpenAfterClose;
            _sendBehavior = sendBehavior;
            _onCloseStarted = onCloseStarted;
            Acknowledgement = new RbpHelloAckPayload(
                1,
                connectionId,
                grantedConnectionCapabilities ?? Array.Empty<string>(),
                15_000,
                new RbpHelloLimits(
                    4 * 1024 * 1024,
                    32 * 1024 * 1024,
                    1024 * 1024),
                new RbpHelloManifest(
                    "0.1.0",
                    "/bridge/update/manifest"));
        }

        public RbpHelloAckPayload Acknowledgement { get; }

        internal ConcurrentQueue<RbpEnvelope> Sent { get; } = new();

        internal int CloseCount => Volatile.Read(ref _closeCount);
        internal int DisposeCount => Volatile.Read(ref _disposeCount);

        internal Action<RbpEnvelope>? AfterResponse { get; set; }

        public Task SendAsync(
            RbpEnvelope envelope,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Sent.Enqueue(envelope);
            if (_sendBehavior is not null)
            {
                return _sendBehavior(this, envelope, cancellationToken);
            }

            RbpEnvelope? response = _responder(envelope);
            if (response is not null)
            {
                Deliver(response);
            }

            AfterResponse?.Invoke(envelope);
            return Task.CompletedTask;
        }

        public async Task<RbpEnvelope> ReceiveAsync(
            CancellationToken cancellationToken = default) =>
            await _inbound.Reader.ReadAsync(cancellationToken);

        public Task CloseAsync(
            CancellationToken cancellationToken = default)
        {
            _onCloseStarted?.Invoke();
            Interlocked.Increment(ref _closeCount);
            if (_hangCloseAndDispose)
            {
                return new TaskCompletionSource(
                    TaskCreationOptions.RunContinuationsAsynchronously).Task;
            }

            if (!_leaveInboundOpenAfterClose)
            {
                _inbound.Writer.TryComplete();
            }

            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            Interlocked.Increment(ref _disposeCount);
            if (_hangCloseAndDispose)
            {
                return new ValueTask(
                    new TaskCompletionSource(
                        TaskCreationOptions.RunContinuationsAsynchronously)
                        .Task);
            }

            if (!_leaveInboundOpenAfterClose)
            {
                _inbound.Writer.TryComplete();
            }

            return ValueTask.CompletedTask;
        }

        internal void Deliver(RbpEnvelope envelope)
        {
            if (!_inbound.Writer.TryWrite(envelope))
            {
                throw new InvalidOperationException(
                    "The scripted connection no longer accepts frames.");
            }
        }

        internal void Fail(Exception exception)
        {
            _inbound.Writer.TryComplete(exception);
        }
    }

    private sealed class ScriptedGatewayResponder
    {
        private readonly ManualCoordinatorClock _clock;

        internal ScriptedGatewayResponder(ManualCoordinatorClock clock)
        {
            _clock = clock;
        }

        internal RbpEnvelope? Respond(RbpEnvelope envelope)
        {
            return envelope.Type switch
            {
                "session_register" =>
                    SessionRegistered(envelope.Payload),
                "session_resume" => ResumeAck(envelope.Payload),
                "heartbeat" => HeartbeatAck(envelope.Payload),
                _ => null,
            };
        }

        private RbpEnvelope SessionRegistered(JsonElement request)
        {
            int port = request.GetProperty("port").GetInt32();
            return Control(
                "session_registered",
                Json(
                    $$"""
                    {
                      "rsid":"rs-{{port}}",
                      "resume_token":"resume-token-rs-{{port}}",
                      "resume_expires_at":"2026-07-27T10:00:00.000Z",
                      "principal":{
                        "tenant_id":"tenant",
                        "user_id":"user"
                      },
                      "seat":{"granted":true,"seat_id":"seat"},
                      "granted_session_capabilities":[]
                    }
                    """));
        }

        private RbpEnvelope ResumeAck(JsonElement request) =>
            Control(
                "resume_ack",
                Json(
                    $$"""
                    {
                      "rsid":"{{request.GetProperty("rsid").GetString()}}",
                      "last_rx_seq":0,
                      "resume_expires_at":"2026-07-27T10:00:00.000Z"
                    }
                    """));

        private RbpEnvelope HeartbeatAck(JsonElement request)
        {
            object[] acknowledgements = request
                .GetProperty("acks")
                .EnumerateArray()
                .Select(item => (object)new Dictionary<string, object?>
                {
                    ["rsid"] = item.GetProperty("rsid").GetString(),
                    ["seq"] = 0,
                })
                .ToArray();
            var payload = new Dictionary<string, object?>
            {
                ["server_time"] = _clock.UtcNow.ToString("O"),
                ["acks"] = acknowledgements,
            };
            if (request.TryGetProperty("update_reports", out JsonElement reports))
            {
                payload["update_report_acks"] = reports
                    .EnumerateArray()
                    .Select(item => item.GetProperty("report_id").GetString())
                    .ToArray();
            }

            return Control(
                "heartbeat_ack",
                JsonSerializer.SerializeToElement(payload));
        }

        private RbpEnvelope Control(
            string type,
            JsonElement payload) =>
            new(
                1,
                type,
                Id(type.GetHashCode(StringComparison.Ordinal) & 9999),
                _clock.UtcNow.ToString("O"),
                payload,
                RbpEnvelopeScope.Control,
                Rsid: null,
                Sequence: null,
                Acknowledgement: null,
                Hello: null,
                HelloAck: null,
                RbpEnvelopeDisposition.Known,
                RbpEnvelope.FreezeAdditionalProperties(
                    new Dictionary<string, JsonElement>()));
    }

    /// <summary>
    /// A dispatcher double for transport-level coordinator tests.
    /// </summary>
    /// <remarks>
    /// It never parses the payload. That matters: the existing sequence-journal
    /// tests deliver a minimal <c>{"invocation_id":...}</c> body, which the
    /// frozen schema would reject long before <c>HandleDataEnvelopeAsync</c> in
    /// production — it only reaches the coordinator because the fake cycle
    /// injects a constructed envelope past the codec. Keeping parsing behind
    /// the interface lets those tests keep their fixtures byte-for-byte while
    /// still exercising the real dispatch seam.
    /// </remarks>
    internal sealed class StubInvocationDispatcher : IRbpInvocationDispatcher
    {
        private readonly RbpInFlightGate _gate = new();
        private readonly ConcurrentQueue<string> _dispatched = new();
        private int _concurrentPeak;
        private int _active;

        /// <summary>Held open to keep an invocation in flight.</summary>
        internal TaskCompletionSource? Hold { get; set; }

        internal IReadOnlyList<string> Dispatched => _dispatched.ToArray();

        internal int ConcurrentPeak => Volatile.Read(ref _concurrentPeak);

        internal ConcurrentQueue<string> RejectedInvocationIds { get; } = new();

        public IRbpInvocationClaim? TryClaim(string rsid) =>
            _gate.TryEnter(rsid) ? new GateClaim(_gate, rsid) : null;

        public IRbpInvocationClaim? TryClaim(
            string rsid,
            RbpInvocationAuthoritySnapshot authority) =>
            _gate.TryEnter(rsid)
                ? new GateClaim(_gate, rsid, authority)
                : null;

        public RbpInvocationAnswer RejectConcurrent(string invocationId)
        {
            RejectedInvocationIds.Enqueue(invocationId);
            return RbpInvocationAnswer.Error(
                Json($$"""
                    {
                      "invocation_id":"{{invocationId}}",
                      "retryable":false,
                      "fault_class":"protocol",
                      "outcome":"known",
                      "verification_required":false,
                      "replayed":false,
                      "late_after_indeterminate":false,
                      "message":"already in flight"
                    }
                    """));
        }

        public async Task<RbpInvocationAnswer> DispatchClaimedAsync(
            IRbpInvocationClaim claim,
            JsonElement invokePayload,
            IReadOnlyList<string> grantedConnectionCapabilities,
            CancellationToken cancellationToken)
        {
            _ = grantedConnectionCapabilities;
            _dispatched.Enqueue(claim.Rsid);
            int active = Interlocked.Increment(ref _active);
            int peak = Volatile.Read(ref _concurrentPeak);
            while (active > peak &&
                   Interlocked.CompareExchange(
                       ref _concurrentPeak, active, peak) != peak)
            {
                peak = Volatile.Read(ref _concurrentPeak);
            }

            try
            {
                if (Hold is { } hold)
                {
                    await hold.Task.WaitAsync(cancellationToken)
                        .ConfigureAwait(false);
                }

                return RbpInvocationAnswer.Result(
                    Json($$"""
                        {
                          "kind":"invocation",
                          "invocation_id":"{{ReadId(invokePayload)}}",
                          "status":"completed",
                          "result":{},
                          "replayed":false,
                          "payload_omitted":false,
                          "late_after_indeterminate":false,
                          "metrics":{
                            "execute_ms":1,
                            "request_bytes":1,
                            "response_bytes":1,
                            "framing":"length-prefixed"
                          }
                        }
                        """));
            }
            finally
            {
                Interlocked.Decrement(ref _active);
            }
        }

        private static string ReadId(JsonElement payload) =>
            payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty("invocation_id", out JsonElement value) &&
            value.GetString() is { Length: > 0 } text
                ? text
                : "019f9add-7a83-7d11-a6a9-d2f8108c0000";
    }
}
