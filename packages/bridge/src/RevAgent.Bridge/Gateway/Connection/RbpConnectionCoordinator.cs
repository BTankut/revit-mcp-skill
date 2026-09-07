using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Bootstrap.Updates;

namespace RevAgent.Bridge.Gateway.Connection;

internal sealed partial class RbpConnectionCoordinator
{
    private static readonly Regex Rfc3339Pattern = new(
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:" +
        "[0-9]{2}(?:\\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex CapabilityPattern = new(
        "^[a-z][a-z0-9_]{0,127}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex Sha256Pattern = new(
        "^sha256:[0-9a-f]{64}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private readonly object _sync = new();
    private readonly IRbpConnectionCycleFactory _cycleFactory;
    private readonly RbpJournalStore _journal;
    private readonly IRbpLocalSessionCatalog _catalog;
    private readonly IRbpInboundDataJournal _inboundJournal;
    private readonly IRbpCoordinatorClock _clock;
    private readonly IRbpRandomSource _random;
    private readonly RbpConnectionCoordinatorOptions _options;
    private readonly RbpUuidV7 _identifiers;
    private readonly BridgeUpdateReportStore? _updateReports;

    /// <summary>
    /// Required. A coordinator that accepts sessions and receives <c>invoke</c>
    /// frames but has no add-in dispatch surface can only strand the Gateway,
    /// so the case is made unrepresentable rather than handled.
    /// </summary>
    private readonly IRbpInvocationDispatcher _invocationDispatcher;

    /// <summary>
    /// Optional because a coordinator without a dispatch surface cannot execute
    /// a batch. Unlike the missing-surface invoke case, a batch that arrives
    /// while this is null is answered with a terminal <c>unsupported</c> fault
    /// rather than swallowed: the frame was already sequenced and acknowledged,
    /// so silence here would strand the Gateway's window forever.
    /// </summary>
    private readonly RbpBatchCoordinator? _batchCoordinator;
    private readonly RbpArtifactCarrierProducer? _carrierProducer;
    private readonly RbpProtectedRecoveryCarrierMaterializer
        _recoveryCarrierMaterializer;
    private readonly Func<CancellationToken, Task>? _beforeRecoveryCarrierWrite;
    private readonly Func<CancellationToken, Task>? _beforeRecoveryTerminalWrite;
    private readonly Func<CancellationToken, Task>? _afterRecoveryCarrierWriteBeforeAck;
    private readonly RbpConformanceOmittedOriginObservation _omittedOriginObservation;
    private readonly IRbpRecoveryCarrierObservationSink
        _recoveryCarrierObservationSink;
    private readonly IRbpReconnectObservationSink _reconnectObservationSink;

    /// <summary>
    /// Bounded, non-secret dispatch trace. The batch path has several silent
    /// returns by design — a per-session journal condition, a closed transport,
    /// a session that lost dispatch authority — and every one of them looks
    /// identical from outside: the Gateway's window stays occupied and nothing
    /// is written anywhere. This makes which one happened observable.
    /// </summary>
    private readonly Action<string>? _onDispatchDiagnostic;
    private readonly Func<RbpConnectionFailureObservation, ValueTask>?
        _onConnectionFailureObservation;
    private readonly Func<RbpLifecycleTimeoutObservation, ValueTask>?
        _onLifecycleTimeoutObservation;
    private readonly Func<RbpDocumentContextObservation, ValueTask>?
        _onDocumentContextObservation;
    private readonly SemaphoreSlim _retryConditionSignal = new(0, 1);
    private RbpConnectionLifecycleState _lifecycle =
        RbpConnectionReducer.CreateConnectionLifecycle();
    private ConnectionCycleContext? _active;
    private long _connectionGeneration;
    private int _runStarted;
    private int _connectionAuthorityPoisoned;
    private int _ownedBackgroundTasks;
    private int _activeInvocations;
    private int _attemptStopState;
    private AttemptLeafRegistry _attemptLeaves = new();
    private long _attemptGeneration;
    private TaskCompletionSource<RbpCoordinatorTeardownResult>
        _teardownResult = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
    private Task<RbpCoordinatorTeardownResult>? _retainedTeardownOwner;
    private AttemptTeardownResources? _attemptTeardownResources;
    private readonly Dictionary<string, DocumentContextQueuedDiagnostic> _documentContextQueued =
        new(StringComparer.Ordinal);
    private readonly object _recoveryCarrierClaimSync = new();
    private readonly HashSet<RecoveryCarrierCycleKey> _recoveryCarrierClaims = new();
    private readonly HashSet<RecoveryCarrierAckGateKey> _recoveryCarrierAckGates = new();
    private readonly HashSet<RecoveryTerminalDeliveryKey> _recoveryTerminalDeliveries = new();
    private readonly HashSet<RecoveryTerminalCycleKey> _recoveryTerminalClaims = new();
    private readonly HashSet<Task> _quarantinedTeardownTasks = new();
    // Observations are volatile only, but a recovery receipt can arrive on a
    // later connection cycle. Keep the one unacknowledged digest by durable
    // recovery identity rather than a socket-cycle object.
    private readonly Dictionary<RecoveryCarrierDigestKey, string>
        _recoveryCarrierOuterDigests = new();
    private long _recoveryCarrierObservationOrdinal;
    private long _c39CausalOrdinal;
    private readonly Dictionary<RouteAuthorityCheckpointKey, string>
        _routeAuthorityCheckpoints = new();

    internal RbpConnectionCoordinator(
        IRbpConnectionCycleFactory cycleFactory,
        RbpJournalStore journal,
        IRbpLocalSessionCatalog catalog,
        RbpConnectionCoordinatorOptions options,
        IRbpInvocationDispatcher invocationDispatcher,
        IRbpInboundDataJournal? inboundJournal = null,
        IRbpCoordinatorClock? clock = null,
        IRbpRandomSource? random = null,
        RbpDocContextWatcher? docContextWatcher = null,
        RbpBatchCoordinator? batchCoordinator = null,
        Action<string>? onDispatchDiagnostic = null,
        Func<RbpConnectionFailureObservation, ValueTask>?
            onConnectionFailureObservation = null,
        RbpArtifactCarrierProducer? carrierProducer = null,
        Func<RbpLifecycleTimeoutObservation, ValueTask>?
            onLifecycleTimeoutObservation = null,
        Func<RbpDocumentContextObservation, ValueTask>?
            onDocumentContextObservation = null,
        RbpProtectedRecoveryCarrierMaterializer?
            recoveryCarrierMaterializer = null,
        Func<CancellationToken, Task>? beforeRecoveryCarrierWrite = null,
        Func<CancellationToken, Task>? beforeRecoveryTerminalWrite = null,
        Func<CancellationToken, Task>? afterRecoveryCarrierWriteBeforeAck = null,
        RbpConformanceOmittedOriginObservation? omittedOriginObservation = null,
        IRbpRecoveryCarrierObservationSink? recoveryCarrierObservationSink = null,
        IRbpReconnectObservationSink? reconnectObservationSink = null,
        BridgeUpdateReportStore? updateReports = null)
    {
        _batchCoordinator = batchCoordinator;
        _carrierProducer = carrierProducer;
        _onDispatchDiagnostic = onDispatchDiagnostic;
        _onConnectionFailureObservation = onConnectionFailureObservation;
        _onLifecycleTimeoutObservation = onLifecycleTimeoutObservation;
        _onDocumentContextObservation = onDocumentContextObservation;
        _invocationDispatcher = invocationDispatcher ??
            throw new ArgumentNullException(nameof(invocationDispatcher));
        _cycleFactory = cycleFactory ??
            throw new ArgumentNullException(nameof(cycleFactory));
        _journal = journal ?? throw new ArgumentNullException(nameof(journal));
        _recoveryCarrierMaterializer = recoveryCarrierMaterializer ??
            new RbpProtectedRecoveryCarrierMaterializer(_journal);
        _beforeRecoveryCarrierWrite = beforeRecoveryCarrierWrite;
        _beforeRecoveryTerminalWrite = beforeRecoveryTerminalWrite;
        _afterRecoveryCarrierWriteBeforeAck = afterRecoveryCarrierWriteBeforeAck;
        _omittedOriginObservation = omittedOriginObservation ??
            RbpConformanceOmittedOriginObservation.Never;
        _recoveryCarrierObservationSink = recoveryCarrierObservationSink ??
            RbpRecoveryCarrierObservationSink.None;
        _reconnectObservationSink = reconnectObservationSink ??
            RbpReconnectObservationSink.None;
        _updateReports = updateReports;
        _catalog = catalog ?? throw new ArgumentNullException(nameof(catalog));
        _options = options ??
            throw new ArgumentNullException(nameof(options));
        _inboundJournal =
            inboundJournal ?? FailClosedRbpInboundDataJournal.Instance;
        _clock = clock ?? SystemRbpCoordinatorClock.Instance;
        _random = random ?? CryptographicRbpRandomSource.Shared;
        _docContextWatcher = docContextWatcher;
        _identifiers = new RbpUuidV7(
            new CoordinatorTimeProvider(_clock),
            _random);
        ValidateOptions(cycleFactory, options);
    }

    internal RbpConnectionCoordinatorSnapshot GetSnapshot()
    {
        RbpConnectionLifecycleState lifecycle;
        long generation;
        ConnectionCycleContext? active;
        int ownedTasks;
        int invocations;
        bool routeRebindProofGranted;
        bool hasActiveConnection;
        lock (_sync)
        {
            lifecycle = _lifecycle;
            generation = _connectionGeneration;
            active = _active;
            ownedTasks = _ownedBackgroundTasks;
            invocations = _activeInvocations;
            hasActiveConnection = active is not null &&
                _attemptStopState == 2;
            routeRebindProofGranted = active is not null &&
                _connectionGeneration == active.Generation &&
                active.GrantedConnectionCapabilities.Contains(
                    RbpHelloProfile.RouteRebindProofCapability,
                    StringComparer.Ordinal);
        }

        return new RbpConnectionCoordinatorSnapshot(
            lifecycle,
            generation,
            hasActiveConnection,
            active?.ActiveRsids ??
            Array.AsReadOnly(Array.Empty<string>()),
            ownedTasks,
            invocations,
            routeRebindProofGranted);
    }

    internal void NotifyRetryConditionChanged()
    {
        lock (_sync)
        {
            if (_lifecycle.Phase != RbpConnectionPhase.RetryPaused)
            {
                return;
            }

            try
            {
                _retryConditionSignal.Release();
            }
            catch (SemaphoreFullException)
            {
                // One pending change notification is sufficient.
            }
        }
    }

    internal async Task RunAsync(
        CancellationToken cancellationToken = default)
    {
        if (Volatile.Read(ref _connectionAuthorityPoisoned) != 0)
        {
            throw NonDrainingConnectionAuthority();
        }

        if (Interlocked.CompareExchange(ref _runStarted, 1, 0) != 0)
        {
            throw new RbpCoordinatorException(
                RbpCoordinatorErrorCode.AlreadyRunning,
                "The RBP connection coordinator already owns its run loop.");
        }

        try
        {
            AdvanceConnection(new RbpConnectionEvent(
                RbpConnectionEventType.Start));
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    using CancellationTokenRegistration presteadyCancellation =
                        BeginConnectionAttempt(cancellationToken);
                    PreparedAttemptLeaf root = PrepareAttemptLeaf(
                        () => RunOneConnectionAsync(cancellationToken));
                    if (!TryStartPublished(
                            TryPublishAttemptLeaf(
                                AttemptLeaf.RootRunOne, root), root))
                        throw NonDrainingConnectionAuthority();
                    await root.Task.ConfigureAwait(false);
                    throw new RbpGatewayTransportException(
                        RbpGatewayFailureKind.RemoteClosed,
                        "The RBP connection cycle ended without a terminal " +
                        "transport event.");
                }
                catch (OperationCanceledException)
                    when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                catch (ConnectionStopRequestedException)
                {
                    break;
                }
                catch (RbpGoodbyeCycleException goodbye)
                {
                    if (Volatile.Read(ref _attemptStopState) == 4)
                        throw NonDrainingConnectionAuthority(goodbye);
                    if (cancellationToken.IsCancellationRequested) break;
                    if (goodbye.Reason == RbpGoodbyeReason.AuthRevoked)
                    {
                        _options.CredentialClaimInvalidator?
                            .InvalidateActiveCredential();
                    }

                    AdvanceConnection(
                        new RbpConnectionEvent(
                            RbpConnectionEventType.Goodbye,
                            ContinuousSteadyMilliseconds:
                                goodbye.ContinuousSteadyMilliseconds,
                            RetryAfterMilliseconds:
                                goodbye.RetryAfterMilliseconds,
                            GoodbyeReason: goodbye.Reason));
                }
                catch (RbpCoordinatorException exception)
                    when (exception.ErrorCode ==
                          RbpCoordinatorErrorCode
                              .NonDrainingConnectionAuthority)
                {
                    PromoteConnectionAuthorityMustExit(exception);
                    throw;
                }
                catch (RbpCoordinatorException exception)
                    when (exception.ErrorCode ==
                          RbpCoordinatorErrorCode.InboundJournalUnavailable)
                {
                    // This is a static worker-composition refusal, not a
                    // transient transport condition. Keep retransmission
                    // authority at the Gateway and park this run until the
                    // supervised process stops; reconnecting cannot install a
                    // journal handoff that was absent at construction.
                    try
                    {
                        await Task.Delay(
                                Timeout.InfiniteTimeSpan,
                                cancellationToken)
                            .ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                        when (cancellationToken.IsCancellationRequested)
                    {
                        break;
                    }
                }
                catch (Exception exception)
                {
                    if (Volatile.Read(ref _attemptStopState) == 4 ||
                        IsNonDrainingConnectionAuthority(exception))
                    {
                        RbpCoordinatorException primary =
                            NonDrainingConnectionAuthority(exception);
                        PromoteConnectionAuthorityMustExit(primary);
                        throw primary;
                    }
                    if (IsInboundJournalUnavailable(exception))
                    {
                        try
                        {
                            await Task.Delay(
                                    Timeout.InfiniteTimeSpan,
                                    cancellationToken)
                                .ConfigureAwait(false);
                        }
                        catch (OperationCanceledException)
                            when (cancellationToken.IsCancellationRequested)
                        {
                            break;
                        }
                    }
                    if (cancellationToken.IsCancellationRequested) break;
                    FailureTransition failure = ClassifyFailure(exception);
                    if (failure.GatewayFailure ==
                            RbpGatewayFailureKind.Authorization &&
                        (failure.HttpStatus == 403 ||
                         failure.CloseCode == 4403))
                    {
                        _options.CredentialClaimInvalidator?
                            .InvalidateActiveCredential();
                    }

                    AdvanceConnection(
                        new RbpConnectionEvent(
                            RbpConnectionEventType.ConnectionFailed,
                            ContinuousSteadyMilliseconds:
                                failure.ContinuousSteadyMilliseconds,
                            RetryAfterMilliseconds:
                                failure.RetryAfterMilliseconds,
                            Failure: failure.Class));
                    ObserveConnectionFailure(failure);
                }

                try
                {
                    await WaitForRetryAuthorityAsync(cancellationToken)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                    when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
            }
        }
        finally
        {
            RbpCoordinatorException? mustExit = null;
            AttemptTeardownResources? resources;
            lock (_sync) resources = _attemptTeardownResources;
            if (resources is not null)
            {
                RbpCoordinatorTeardownResult teardown =
                    await GetOrStartRetainedTeardown(resources)
                        .ConfigureAwait(false);
                if (teardown.Disposition ==
                    RbpCoordinatorTeardownDisposition.EmergencyMustExit)
                {
                    mustExit = NonDrainingConnectionAuthority(
                        resources.SecondaryFault);
                }
            }

            if (_lifecycle.Phase != RbpConnectionPhase.Shutdown)
            {
                AdvanceConnection(
                    new RbpConnectionEvent(
                        RbpConnectionEventType.ShutdownRequested));
            }

            ClearAllRecoveryCarrierOuterDigests();
            lock (_sync)
            {
                if (_attemptStopState is not (4 or 6))
                {
                    _attemptStopState = 5;
                    _teardownResult.TrySetResult(
                        new RbpCoordinatorTeardownResult(
                            RbpCoordinatorTeardownDisposition.NormalStopped));
                }
            }
            Interlocked.Exchange(ref _runStarted, 0);
            if (mustExit is not null) throw mustExit;
        }
    }

    private void SignalPresteadyCancellation(
        PresteadyCancellationOwner owner)
    {
        if (!owner.TrySignal()) return;
        if (!ReferenceEquals(_attemptLeaves, owner.Registry) ||
            Volatile.Read(ref _attemptGeneration) != owner.AttemptGeneration ||
            Interlocked.CompareExchange(ref _attemptStopState, 4, 1) != 1)
            return;
        long generation = Volatile.Read(ref _connectionGeneration);
        if (generation > 0)
            DenyRouteAuthorityEpoch(generation);
        // V11/V15 ordering: deny, then publish the primary must-exit signal.
        // Journal poison/cancel/close are retained follow-up work and cannot
        // delay CancellationTokenSource.Cancel().
        owner.TeardownResult.TrySetResult(
            new RbpCoordinatorTeardownResult(
                RbpCoordinatorTeardownDisposition.EmergencyMustExit));
        Interlocked.Exchange(ref _connectionAuthorityPoisoned, 1);
        ThreadPool.QueueUserWorkItem(
            static state =>
            {
                var tuple = ((RbpConnectionCoordinator Coordinator,
                    PresteadyCancellationOwner Owner))state!;
                tuple.Coordinator.HandlePresteadyCancellation(tuple.Owner);
            },
            (this, owner),
            preferLocal: false);
    }

    private void HandlePresteadyCancellation(
        PresteadyCancellationOwner owner)
    {
        ConnectionCycleContext? active;
        AttemptTeardownResources? resources;
        lock (_sync)
        {
            if (!ReferenceEquals(_attemptLeaves, owner.Registry) ||
                _attemptGeneration != owner.AttemptGeneration ||
                _attemptStopState != 4)
                return;
            _connectionAuthorityPoisoned = 1;
            active = _active;
            resources = _attemptTeardownResources;
        }
        try
        {
            long generation = Volatile.Read(ref _connectionGeneration);
            if (generation > 0)
                _journal.PoisonConnectionGeneration(generation);
            else
                _journal.PoisonProcessAuthority();
        }
        catch (Exception exception)
        {
            if (resources is not null) resources.SecondaryFault ??= exception;
            try { _journal.PoisonProcessAuthority(); }
            catch { }
        }
        owner.Registry.AbortPrepared();
        if (active is not null)
        {
            if (active.GetAndCancelPreparedInvocationSend() is { } prepared)
                RetainPreparedSendCancellation(active, prepared);
            active.AbortPreparedWatches();
            active.AbortPreparedInvocations();
            active.AbortPreparedCurrentOperations();
        }
        if (resources is not null)
        {
            resources.ShutdownRequested = true;
            ObserveLateFault(GetOrStartRetainedTeardown(resources));
        }
    }

    internal Task<RbpCoordinatorTeardownResult> RequestStopTeardown()
    {
        ConnectionCycleContext? abortPrepared = null;
        AttemptLeafRegistry? abortLeaves = null;
        AttemptTeardownResources? resources = null;
        Task<RbpCoordinatorTeardownResult> result;
        TaskCompletionSource? startRetainedOwner = null;
        lock (_sync)
        {
            int observed = _attemptStopState;
            if (observed == 4) return _teardownResult.Task;
            if (observed == 6) return _teardownResult.Task;
            if (observed == 5)
            {
                // A completed attempt may sit in retry authority after its old
                // teardown deadline has expired. Service stop owns a fresh
                // Root-join deadline, not that stale attempt remainder.
                _attemptStopState = 6;
                _retainedTeardownOwner = null;
                _teardownResult = new TaskCompletionSource<
                    RbpCoordinatorTeardownResult>(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                _teardownResult.TrySetResult(
                    new RbpCoordinatorTeardownResult(
                        RbpCoordinatorTeardownDisposition.NormalStopped,
                        ConnectionTeardownDeadline.TimestampAfter(
                            _options.EffectiveCloseTimeout)));
                return _teardownResult.Task;
            }
            if (observed is 0 or 1)
            {
                long generation = _connectionGeneration;
                _attemptStopState = 4;
                if (generation > 0) DenyRouteAuthorityEpoch(generation);
                abortPrepared = _active;
                abortLeaves = _attemptLeaves;
                resources = _attemptTeardownResources;
                if (resources is not null)
                {
                    resources.ShutdownRequested = true;
                    _ = resources.GetOrCreateDeadline(
                        _options.EffectiveCloseTimeout);
                    startRetainedOwner = new TaskCompletionSource(
                        TaskCreationOptions.RunContinuationsAsynchronously);
                    _retainedTeardownOwner = RunRetainedTeardownOwnerAsync(
                        startRetainedOwner.Task,
                        resources);
                }
                _teardownResult.TrySetResult(
                    new RbpCoordinatorTeardownResult(
                        RbpCoordinatorTeardownDisposition.EmergencyMustExit));
                _connectionAuthorityPoisoned = 1;
                result = _teardownResult.Task;
            }
            else if (observed == 2)
            {
                _attemptStopState = 3;
                abortPrepared = _active;
                abortLeaves = _attemptLeaves;
                resources = _attemptTeardownResources ??
                    throw new InvalidOperationException(
                        "A steady attempt has no retained teardown resources.");
                resources.ShutdownRequested = true;
                _ = resources.GetOrCreateDeadline(
                    _options.EffectiveCloseTimeout);
                long generation = _connectionGeneration;
                if (generation > 0) DenyRouteAuthorityEpoch(generation);
                startRetainedOwner = new TaskCompletionSource(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                _retainedTeardownOwner = RunRetainedTeardownOwnerAsync(
                    startRetainedOwner.Task,
                    resources);
                result = _retainedTeardownOwner;
            }
            else
            {
                result = _retainedTeardownOwner ?? _teardownResult.Task;
            }
        }
        if (abortPrepared is not null)
        {
            if (abortPrepared.GetAndCancelPreparedInvocationSend() is
                { } prepared)
            {
                RetainPreparedSendCancellation(abortPrepared, prepared);
            }
            abortPrepared.AbortPreparedWatches();
            abortPrepared.AbortPreparedInvocations();
            abortPrepared.AbortPreparedCurrentOperations();
        }
        abortLeaves?.AbortPrepared();
        startRetainedOwner?.TrySetResult();
        return result;
    }

    private async Task<RbpCoordinatorTeardownResult>
        RunRetainedTeardownOwnerAsync(
            Task start,
            AttemptTeardownResources resources)
    {
        await start.ConfigureAwait(false);
        try
        {
            return await RunPhysicalTeardownAsync(resources)
                .ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            resources.SecondaryFault = exception;
            if (resources.RouteAuthorityEpoch is { } generation)
                _journal.PoisonConnectionGeneration(generation);
            else
                _journal.PoisonProcessAuthority();
            Interlocked.Exchange(ref _connectionAuthorityPoisoned, 1);
            lock (_sync) _attemptStopState = 4;
            var result = new RbpCoordinatorTeardownResult(
                RbpCoordinatorTeardownDisposition.EmergencyMustExit,
                resources.DeadlineTimestamp);
            _teardownResult.TrySetResult(result);
            return result;
        }
    }

    private Task<RbpCoordinatorTeardownResult> GetOrStartRetainedTeardown(
        AttemptTeardownResources resources)
    {
        ArgumentNullException.ThrowIfNull(resources);
        TaskCompletionSource? start = null;
        Task<RbpCoordinatorTeardownResult> owner;
        lock (_sync)
        {
            if (_retainedTeardownOwner is not null)
                return _retainedTeardownOwner;
            if (_attemptTeardownResources is not null &&
                !ReferenceEquals(_attemptTeardownResources, resources))
                throw NonDrainingConnectionAuthority();
            _attemptTeardownResources ??= resources;
            _ = resources.GetOrCreateDeadline(
                _options.EffectiveCloseTimeout);
            if (_attemptStopState is 0 or 1 or 2)
                _attemptStopState = 3;
            if (_attemptStopState == 5) return _teardownResult.Task;
            start = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously);
            owner = RunRetainedTeardownOwnerAsync(start.Task, resources);
            _retainedTeardownOwner = owner;
        }
        start.TrySetResult();
        return owner;
    }

    private async Task<RbpCoordinatorTeardownResult> RunPhysicalTeardownAsync(
        AttemptTeardownResources resources)
    {
        using ConnectionTeardownDeadline deadline =
            resources.GetOrCreateDeadline(_options.EffectiveCloseTimeout);
        ConnectionCycleContext? context;
        long? generation;
        bool emergency;
        bool shutdownRequested;
        AttemptLeafRegistry registry;
        lock (_sync)
        {
            context = resources.Context ?? _active;
            generation = resources.RouteAuthorityEpoch;
            emergency = _attemptStopState == 4 ||
                _connectionAuthorityPoisoned != 0;
            shutdownRequested = resources.ShutdownRequested;
            registry = _attemptLeaves;
        }

        bool teardownProven = true;
        bool transportOpenDrained = await DrainAttemptLeafAsync(
                AttemptLeaf.TransportOpen, deadline)
            .ConfigureAwait(false);
        teardownProven &= transportOpenDrained;
        IRbpConnectionCycle? cycle = resources.Cycle;
        if (generation is { } routeEpoch)
        {
            DenyRouteAuthorityEpoch(routeEpoch);
            FenceRouteAuthorityEpoch(routeEpoch);
            if (emergency) _journal.PoisonConnectionGeneration(routeEpoch);
        }
        else if (emergency)
        {
            _journal.PoisonProcessAuthority();
        }

        registry.AbortPrepared();
        bool shutdownUnregistersRecorded = true;
        if (context is not null)
        {
            if (context.GetAndCancelPreparedInvocationSend() is { } prepared)
                RetainPreparedSendCancellation(context, prepared);
            context.AbortPreparedWatches();
            context.AbortPreparedInvocations();
            context.AbortPreparedCurrentOperations();
            if (shutdownRequested)
            {
                shutdownUnregistersRecorded =
                    await TryRecordShutdownUnregistersAsync(context, deadline)
                        .ConfigureAwait(false);
                teardownProven &= shutdownUnregistersRecorded;
            }
            context.Cancel();
        }

        CycleCloseOperation? close = null;
        if (emergency && cycle is not null)
        {
            close = await StartRetainedCloseAsync(cycle, deadline)
                .ConfigureAwait(false);
        }

        bool journalLeafDrained = await DrainAttemptLeafAsync(
                AttemptLeaf.JournalBootstrap, deadline)
            .ConfigureAwait(false);
        teardownProven &= journalLeafDrained;
        bool generationDeactivated = true;
        if (generation is { } journalGeneration &&
            resources.JournalGenerationActivated)
        {
            try
            {
                await _journal.DeactivateConnectionGenerationAsync(
                        journalGeneration, deadline.Token)
                    .ConfigureAwait(false);
            }
            catch
            {
                generationDeactivated = false;
                teardownProven = false;
                _journal.PoisonConnectionGeneration(journalGeneration);
            }
        }

        if (cycle is not null)
        {
            close ??= await StartRetainedCloseAsync(cycle, deadline)
                .ConfigureAwait(false);
        }
        bool leavesDrained = await DrainAttemptLeavesAsync(deadline)
            .ConfigureAwait(false);
        bool invocationsDrained = context is null ||
            await context.DrainInvocationsAsync(deadline).ConfigureAwait(false);
        bool ownedTasksDrained = context is null ||
            await context.AwaitOwnedTasksAsync(deadline).ConfigureAwait(false);
        bool closeQuiesced = cycle is null || close?.Disposition ==
            CloseCycleDisposition.CloseQuiesced;
        resources.SecondaryFault ??= close?.SecondaryFault;
        teardownProven &= leavesDrained && invocationsDrained &&
            ownedTasksDrained && closeQuiesced;
        if (!teardownProven && resources.SecondaryFault is null)
        {
            resources.SecondaryFault = new InvalidOperationException(
                "Connection teardown proof was incomplete " +
                $"(open={transportOpenDrained}," +
                $"unregister={shutdownUnregistersRecorded}," +
                $"journal={journalLeafDrained}," +
                $"deactivate={generationDeactivated}," +
                $"leaves={leavesDrained},invocations={invocationsDrained}," +
                $"owned={ownedTasksDrained},close={closeQuiesced}).");
        }

        if (teardownProven && context is not null)
            ClearRecoveryCarrierClaims(context);

        bool disposed = cycle is null;
        if (teardownProven && close is not null)
        {
            disposed = await StartRetainedDisposeAsync(close, deadline)
                .ConfigureAwait(false);
        }
        teardownProven &= disposed;
        if (!disposed && resources.SecondaryFault is null)
        {
            resources.SecondaryFault = new InvalidOperationException(
                "Connection cycle disposal was not proven before the shared " +
                $"deadline (remaining={deadline.Remaining}).");
        }

        if (teardownProven && context is not null)
        {
            ClearActiveContext(context);
            ClearRouteAuthorityCheckpoints(context);
            context.Dispose();
        }
        if (teardownProven) ClearAllRecoveryCarrierOuterDigests();

        if (!teardownProven && generation is { } failedGeneration)
            _journal.PoisonConnectionGeneration(failedGeneration);
        RbpCoordinatorTeardownDisposition disposition;
        lock (_sync)
        {
            if (teardownProven &&
                ReferenceEquals(_attemptTeardownResources, resources))
                _attemptTeardownResources = null;
            if (!teardownProven || emergency ||
                _connectionAuthorityPoisoned != 0)
            {
                _attemptStopState = 4;
                _connectionAuthorityPoisoned = 1;
                disposition =
                    RbpCoordinatorTeardownDisposition.EmergencyMustExit;
            }
            else
            {
                _attemptStopState = 5;
                disposition = RbpCoordinatorTeardownDisposition.NormalStopped;
            }
        }
        var result = new RbpCoordinatorTeardownResult(
            disposition, resources.DeadlineTimestamp);
        _teardownResult.TrySetResult(result);
        return result;
    }

    private async Task<CycleCloseOperation?> StartRetainedCloseAsync(
        IRbpConnectionCycle cycle,
        ConnectionTeardownDeadline deadline)
    {
        CycleCloseOperation? close = null;
        PreparedAttemptLeaf prepared = PrepareAttemptLeaf(async () =>
            close = await CloseCycleBoundedAsync(cycle, deadline)
                .ConfigureAwait(false));
        if (!TryStartPublished(
                TryPublishAttemptLeaf(
                    AttemptLeaf.Close, prepared, teardownOwned: true),
                prepared))
            return null;
        try
        {
            await prepared.Task.ConfigureAwait(false);
        }
        catch
        {
            return null;
        }
        return close;
    }

    private async Task<bool> StartRetainedDisposeAsync(
        CycleCloseOperation close,
        ConnectionTeardownDeadline deadline)
    {
        bool disposed = false;
        PreparedAttemptLeaf prepared = PrepareAttemptLeaf(async () =>
            disposed = await DisposeCycleBoundedAsync(close, deadline)
                .ConfigureAwait(false));
        if (!TryStartPublished(
                TryPublishAttemptLeaf(
                    AttemptLeaf.Dispose, prepared, teardownOwned: true),
                prepared))
            return false;
        try
        {
            await prepared.Task.ConfigureAwait(false);
        }
        catch
        {
            return false;
        }
        return disposed;
    }

    private async Task<bool> DrainAttemptLeafAsync(
        AttemptLeaf leaf,
        ConnectionTeardownDeadline deadline)
    {
        Task? pending;
        lock (_sync) pending = _attemptLeaves.TaskFor(leaf);
        if (pending is null || pending.IsCompleted) return true;
        if (deadline.Remaining == TimeSpan.Zero) return false;
        try
        {
            await pending.WaitAsync(deadline.Token).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
            when (deadline.Token.IsCancellationRequested)
        {
            if (!pending.IsCompleted) RetainQuarantinedTeardownTask(pending);
            return false;
        }
        catch
        {
            _ = pending.Exception;
            return true;
        }
    }

    private void RetainPreparedSend(RbpPreparedSend prepared)
    {
        Task started = prepared.StartedTask ?? prepared.HotTaskPublished;
        RetainQuarantinedTeardownTask(started);
        if (!prepared.HotTaskPublished.IsCompleted)
        {
            _ = prepared.HotTaskPublished.ContinueWith(
                completed =>
                {
                    if (completed.Status == TaskStatus.RanToCompletion &&
                        completed.Result is { } hot &&
                        !ReferenceEquals(hot, started))
                    {
                        RetainQuarantinedTeardownTask(hot);
                    }
                    _ = completed.Exception;
                },
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }

    private void RetainPreparedSendCancellation(
        ConnectionCycleContext context,
        ConnectionCycleContext.PreparedInvocationCancellation cancellation)
    {
        RetainPreparedSend(cancellation.Prepared);
        if (!cancellation.StrandedBoundMarker) return;

        DenyRouteAuthorityEpoch(context.Generation);
        _journal.PoisonConnectionGeneration(context.Generation);
        Interlocked.Exchange(ref _connectionAuthorityPoisoned, 1);
        lock (_sync) _attemptStopState = 4;
        _teardownResult.TrySetResult(new RbpCoordinatorTeardownResult(
            RbpCoordinatorTeardownDisposition.EmergencyMustExit));
        context.Cancel();
    }

    private void PromoteConnectionAuthorityMustExit(
        ConnectionCycleContext context,
        Exception secondary) =>
        PromoteConnectionAuthorityMustExit(secondary, context);

    private void PromoteConnectionAuthorityMustExit(
        Exception secondary,
        ConnectionCycleContext? expectedContext = null)
    {
        ArgumentNullException.ThrowIfNull(secondary);
        AttemptTeardownResources? resources;
        ConnectionCycleContext? context;
        long? generation;
        lock (_sync)
        {
            _attemptStopState = 4;
            resources = _attemptTeardownResources;
            context = expectedContext ?? _active;
            generation = context?.Generation ?? resources?.RouteAuthorityEpoch;
            if (resources is not null) resources.SecondaryFault ??= secondary;
            if (generation is { } routeEpoch)
                DenyRouteAuthorityEpoch(routeEpoch);
            if (_teardownResult.Task.IsCompletedSuccessfully &&
                _teardownResult.Task.Result.Disposition ==
                RbpCoordinatorTeardownDisposition.NormalStopped)
            {
                _teardownResult = new TaskCompletionSource<
                    RbpCoordinatorTeardownResult>(
                    TaskCreationOptions.RunContinuationsAsynchronously);
            }
            _teardownResult.TrySetResult(new RbpCoordinatorTeardownResult(
                RbpCoordinatorTeardownDisposition.EmergencyMustExit,
                resources?.DeadlineTimestamp));
        }
        Interlocked.Exchange(ref _connectionAuthorityPoisoned, 1);
        try
        {
            if (generation is { } journalGeneration)
                _journal.PoisonConnectionGeneration(journalGeneration);
            else
                _journal.PoisonProcessAuthority();
        }
        catch (Exception poisonFailure)
        {
            if (resources is not null)
                resources.SecondaryFault ??= poisonFailure;
            try { _journal.PoisonProcessAuthority(); }
            catch { }
        }
        if (context is not null)
        {
            context.FailPending(secondary);
            context.Cancel();
        }
        if (resources is not null)
            ObserveLateFault(GetOrStartRetainedTeardown(resources));
    }

    private void MarkAttemptSteady()
    {
        if (Interlocked.CompareExchange(ref _attemptStopState, 2, 1) == 1)
            return;
        if (Volatile.Read(ref _attemptStopState) == 6)
            throw new ConnectionStopRequestedException();
        if (Volatile.Read(ref _attemptStopState) is 3 or 4)
            throw NonDrainingConnectionAuthority();
    }

    private async Task RunOneConnectionAsync(
        CancellationToken serviceCancellationToken)
    {
        AttemptTeardownResources teardownResources;
        lock (_sync)
        {
            teardownResources = _attemptTeardownResources ??
                throw new InvalidOperationException(
                    "The active attempt has no retained teardown receipt.");
        }
        try
        {
            await RunOneConnectionCoreAsync(
                    serviceCancellationToken, teardownResources)
                .ConfigureAwait(false);
        }
        finally
        {
            RbpCoordinatorTeardownResult teardown =
                await GetOrStartRetainedTeardown(teardownResources)
                    .ConfigureAwait(false);
            if (teardown.Disposition ==
                RbpCoordinatorTeardownDisposition.EmergencyMustExit)
                throw NonDrainingConnectionAuthority(
                    teardownResources.SecondaryFault);
        }
    }

    private async Task RunOneConnectionCoreAsync(
        CancellationToken serviceCancellationToken,
        AttemptTeardownResources teardownResources)
    {
        // Each fresh transport cycle starts from durable fences. This covers
        // both process startup and reconnect after a crash between the ACK
        // transaction and spool cleanup; no spool directory is discovered.
        if (_carrierProducer is not null)
        {
            RbpCarrierRecovery? carrierRecovery = null;
            PreparedAttemptLeaf rehydrate = PrepareAttemptLeaf(async () =>
                carrierRecovery = await _carrierProducer
                    .RehydrateFencesAsync(serviceCancellationToken)
                    .ConfigureAwait(false));
            if (!TryStartPublished(
                    TryPublishAttemptLeaf(
                        AttemptLeaf.PreRouteMaintenance, rehydrate), rehydrate))
                throw NonDrainingConnectionAuthority();
            await rehydrate.Task.ConfigureAwait(false);
            if (carrierRecovery is null) throw NonDrainingConnectionAuthority();
            PreparedAttemptLeaf releases = PrepareAttemptLeaf(() =>
                CompleteCarrierSpoolReleasesAsync(
                    carrierRecovery.PendingReleases,
                    serviceCancellationToken));
            if (!TryStartPublished(
                    TryPublishAttemptLeaf(
                        AttemptLeaf.PreRouteMaintenance, releases), releases))
                throw NonDrainingConnectionAuthority();
            await releases.Task.ConfigureAwait(false);
        }

        IRbpConnectionCycle? openedCycle = null;
        PreparedAttemptLeaf open = PrepareAttemptLeaf(async () =>
        {
            openedCycle = await _cycleFactory.OpenAsync(
                    _options.Endpoint,
                    _options.HelloProfile,
                    serviceCancellationToken)
                .ConfigureAwait(false);
            if (openedCycle is null) throw NonDrainingConnectionAuthority();
            teardownResources.PublishCycle(openedCycle);
        });
        if (!TryStartPublished(
                TryPublishAttemptLeaf(AttemptLeaf.TransportOpen, open), open))
            throw NonDrainingConnectionAuthority();
        try
        {
            await open.Task.ConfigureAwait(false);
        }
        catch
        {
            throw;
        }
        IRbpConnectionCycle cycle = openedCycle ??
            throw NonDrainingConnectionAuthority();
        ConnectionCycleContext? context = null;
        long? routeAuthorityEpoch = null;
        try
        {
            long generation = 0;
            if (!TryCommitAttempt(() =>
                {
                    ValidateCycleAcknowledgement(cycle.Acknowledgement);
                    AdvanceConnection(new RbpConnectionEvent(
                        RbpConnectionEventType.TransportOpened));
                    AdvanceConnection(new RbpConnectionEvent(
                        RbpConnectionEventType.AuthenticationAccepted));
                    AdvanceConnection(new RbpConnectionEvent(
                        RbpConnectionEventType.HelloAccepted,
                        SelectedProtocol: cycle.Acknowledgement.Protocol,
                        GrantedCapabilities:
                            cycle.Acknowledgement.GrantedCapabilities));
                    generation = NextConnectionGeneration();
                    teardownResources.RouteAuthorityEpoch = generation;
                }))
                throw NonDrainingConnectionAuthority();
            routeAuthorityEpoch = generation;
            BeginRouteAuthorityEpoch(generation);
            if (!TryCommitAttempt(() => { }))
            {
                FenceRouteAuthorityEpoch(generation);
                throw NonDrainingConnectionAuthority();
            }
            PreparedAttemptLeaf activate = PrepareAttemptLeaf(async () =>
            {
                await _journal.ActivateConnectionGenerationAsync(
                        generation, serviceCancellationToken)
                    .ConfigureAwait(false);
                teardownResources.JournalGenerationActivated = true;
            });
            if (!TryStartPublished(
                    TryPublishAttemptLeaf(
                        AttemptLeaf.JournalBootstrap, activate), activate))
                throw NonDrainingConnectionAuthority();
            await activate.Task.ConfigureAwait(false);

            var candidateContext = new ConnectionCycleContext(
                this,
                cycle,
                generation,
                cycle.Acknowledgement.GrantedCapabilities,
                serviceCancellationToken);
            if (!TryCommitAttempt(() =>
                {
                    SetActiveContext(candidateContext);
                    teardownResources.Context = candidateContext;
                }))
            {
                candidateContext.Dispose();
                throw NonDrainingConnectionAuthority();
            }
            context = candidateContext;

            RbpJournalRecoveryPlan? recovery = null;
            PreparedAttemptLeaf loadRecovery = PrepareAttemptLeaf(async () =>
                recovery = await _journal.LoadRecoveryPlanAsync(context.Token)
                    .ConfigureAwait(false));
            if (!TryStartPublished(
                    TryPublishCurrentLeaf(context,
                        AttemptLeaf.JournalBootstrap, loadRecovery),
                    loadRecovery))
                throw NonDrainingConnectionAuthority();
            await loadRecovery.Task.ConfigureAwait(false);
            if (recovery is null) throw NonDrainingConnectionAuthority();
            PreparedAttemptLeaf recoverInbound = PrepareAttemptLeaf(() =>
                RecoverPendingInboundHandoffsAsync(
                    recovery.PendingInboundHandoffs, context.Token));
            if (!TryStartPublished(
                    TryPublishCurrentLeaf(context,
                        AttemptLeaf.JournalBootstrap, recoverInbound),
                    recoverInbound))
                throw NonDrainingConnectionAuthority();
            await recoverInbound.Task.ConfigureAwait(false);
            PreparedAttemptLeaf cleanup = PrepareAttemptLeaf(() =>
                CompleteConfirmedCleanupAsync(
                    recovery.ConfirmedCleanup, context.Token));
            if (!TryStartPublished(
                    TryPublishCurrentLeaf(context,
                        AttemptLeaf.JournalBootstrap, cleanup), cleanup))
                throw NonDrainingConnectionAuthority();
            await cleanup.Task.ConfigureAwait(false);

            ConnectionCycleContext.PreparedOwnedLoop receive =
                context.PrepareReceiveLoop();
            PreparedAttemptLeaf receiveLeaf = PrepareAttemptLeaf(() =>
            {
                receive.Start();
                return receive.Task;
            });
            bool receiveCommitted = false;
            if (!TryPublishCurrentLeaf(
                    context,
                    AttemptLeaf.ReceiveLoop,
                    receiveLeaf,
                    () => receiveCommitted =
                        context.CommitReceiveLoop(receive)) ||
                !receiveCommitted)
            {
                receive.Abort();
                receiveLeaf.AbortBeforeStart();
                throw NonDrainingConnectionAuthority();
            }
            if (!TryStartPublished(true, receiveLeaf))
            {
                receive.Abort();
                throw NonDrainingConnectionAuthority();
            }
            PreparedAttemptLeaf sessionSync = PrepareAttemptLeaf(() =>
                SynchronizeSessionsAsync(context, recovery));
            if (!TryStartPublished(
                    TryPublishCurrentLeaf(
                        context, AttemptLeaf.SessionSync, sessionSync),
                    sessionSync))
                throw NonDrainingConnectionAuthority();
            await sessionSync.Task.ConfigureAwait(false);
            ConnectionCycleContext.PreparedOwnedLoop heartbeat =
                context.PrepareHeartbeatLoop();
            PreparedAttemptLeaf heartbeatLeaf = PrepareAttemptLeaf(() =>
            {
                heartbeat.Start();
                return heartbeat.Task;
            });
            bool heartbeatCommitted = false;
            if (!TryStartPublished(TryPublishCurrentLeaf(
                    context,
                    AttemptLeaf.HeartbeatLoop,
                    heartbeatLeaf,
                    () =>
                    {
                        MarkAttemptSteady();
                        context.MarkSteady(_clock.MonotonicMilliseconds);
                        heartbeatCommitted =
                            context.CommitHeartbeatLoop(heartbeat);
                    }), heartbeatLeaf) || !heartbeatCommitted)
            {
                heartbeat.Abort();
                heartbeatLeaf.AbortBeforeStart();
                throw NonDrainingConnectionAuthority();
            }
            PreparedAttemptLeaf retransmit = PrepareAttemptLeaf(() =>
                FlushPendingRetransmitAsync(context));
            if (!TryStartPublished(
                    TryPublishCurrentLeaf(
                        context, AttemptLeaf.Retransmit, retransmit),
                    retransmit))
            {
                if (StopOwnsAttempt(context)) return;
                throw NonDrainingConnectionAuthority();
            }
            await retransmit.Task.ConfigureAwait(false);
            PreparedAttemptLeaf carriers = PrepareAttemptLeaf(() =>
                ScheduleActiveRecoveryCarriersAsync(context));
            if (!TryStartPublished(
                    TryPublishCurrentLeaf(
                        context, AttemptLeaf.RecoveryCarrier, carriers),
                    carriers))
            {
                if (StopOwnsAttempt(context)) return;
                throw NonDrainingConnectionAuthority();
            }
            await carriers.Task.ConfigureAwait(false);
            PreparedAttemptLeaf terminals = PrepareAttemptLeaf(() =>
                ScheduleActiveRecoveryTerminalsAsync(context));
            if (!TryStartPublished(
                    TryPublishCurrentLeaf(
                        context, AttemptLeaf.RecoveryTerminal, terminals),
                    terminals))
            {
                if (StopOwnsAttempt(context)) return;
                throw NonDrainingConnectionAuthority();
            }
            await terminals.Task.ConfigureAwait(false);

            Task completed = await Task.WhenAny(
                        context.ReceiveTask,
                        context.HeartbeatTask)
                    .WaitAsync(serviceCancellationToken)
                .ConfigureAwait(false);
            await completed.ConfigureAwait(false);
            if (context.TerminalFailure is { } terminalFailure)
                throw terminalFailure;
        }
        catch (Exception exception)
            when (context is not null &&
                  exception is not RbpGoodbyeCycleException &&
                  exception is not RbpWakeGapException &&
                  !(exception is OperationCanceledException &&
                    serviceCancellationToken.IsCancellationRequested))
        {
            Exception cause =
                exception is OperationCanceledException &&
                context.TerminalFailure is { } terminalFailure
                    ? terminalFailure
                    : exception;
            throw new RbpConnectedCycleFailureException(
                cause,
                context.ContinuousSteadyMilliseconds);
        }
    }

    private CancellationTokenRegistration BeginConnectionAttempt(
        CancellationToken cancellationToken)
    {
        PresteadyCancellationOwner owner;
        lock (_sync)
        {
            if (_attemptStopState == 6)
                throw new ConnectionStopRequestedException();
            if (_attemptStopState is 3 or 4)
                throw NonDrainingConnectionAuthority();
            _attemptStopState = 1;
            _attemptLeaves = new AttemptLeafRegistry();
            _attemptGeneration = checked(_attemptGeneration + 1);
            _retainedTeardownOwner = null;
            _attemptTeardownResources = new AttemptTeardownResources(
                cancellationToken);
            _teardownResult = new TaskCompletionSource<
                RbpCoordinatorTeardownResult>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            owner = new PresteadyCancellationOwner(
                _attemptLeaves, _attemptGeneration, _teardownResult);
        }
        return cancellationToken.Register(
            static state =>
            {
                var tuple = ((RbpConnectionCoordinator Coordinator,
                    PresteadyCancellationOwner Owner))state!;
                tuple.Coordinator.SignalPresteadyCancellation(tuple.Owner);
            },
            (this, owner));
    }

    private bool StopOwnsAttempt(ConnectionCycleContext context) =>
        context.Token.IsCancellationRequested ||
        Volatile.Read(ref _attemptStopState) is 3 or 4 or 6;

    private sealed class PresteadyCancellationOwner(
        AttemptLeafRegistry registry,
        long attemptGeneration,
        TaskCompletionSource<RbpCoordinatorTeardownResult> teardownResult)
    {
        private int _signalled;
        internal AttemptLeafRegistry Registry { get; } = registry;
        internal long AttemptGeneration { get; } = attemptGeneration;
        internal TaskCompletionSource<RbpCoordinatorTeardownResult>
            TeardownResult
        { get; } = teardownResult;
        internal bool TrySignal() =>
            Interlocked.Exchange(ref _signalled, 1) == 0;
    }

    private sealed class ConnectionStopRequestedException : Exception
    {
    }

    private PreparedAttemptLeaf PrepareAttemptLeaf(Func<Task> start)
    {
        lock (_sync)
            return new PreparedAttemptLeaf(
                _attemptLeaves, _attemptGeneration, start);
    }

    private bool TryPublishAttemptLeaf(
        AttemptLeaf slot,
        PreparedAttemptLeaf prepared,
        bool teardownOwned = false,
        Action? mutation = null)
    {
        lock (_sync)
        {
            if (!teardownOwned && _attemptStopState is 3 or 4 or 5 or 6)
                return false;
            if (!ReferenceEquals(prepared.Registry, _attemptLeaves) ||
                prepared.AttemptGeneration != _attemptGeneration)
                return false;
            if (!_attemptLeaves.TryPublish(slot, prepared, _sync))
                return false;
            try
            {
                mutation?.Invoke();
                if (!prepared.TryReserveStart()) return false;
                if (!teardownOwned &&
                    Volatile.Read(ref _attemptStopState) is 3 or 4 or 5 or 6)
                {
                    prepared.AbortBeforeStart();
                    return false;
                }
                return true;
            }
            catch
            {
                prepared.AbortBeforeStart();
                throw;
            }
        }
    }

    private void CompletePreRouteAttemptNormally(
        PreparedAttemptLeaf openingLeaf)
    {
        lock (_sync)
        {
            if (!ReferenceEquals(openingLeaf.Registry, _attemptLeaves) ||
                openingLeaf.AttemptGeneration != _attemptGeneration ||
                _attemptStopState != 1 || _active is not null ||
                _connectionAuthorityPoisoned != 0)
                return;
            _attemptStopState = 5;
            _teardownResult.TrySetResult(
                new RbpCoordinatorTeardownResult(
                    RbpCoordinatorTeardownDisposition.NormalStopped));
        }
    }

    private bool TryPublishCurrentLeaf(
        ConnectionCycleContext context,
        AttemptLeaf slot,
        PreparedAttemptLeaf prepared,
        Action? mutation = null)
    {
        bool published = false;
        bool current = TryCommitCurrent(context, () =>
        {
            published = TryPublishAttemptLeaf(
                slot, prepared, mutation: mutation);
        });
        return current && published;
    }

    private static bool TryStartPublished(
        bool published,
        PreparedAttemptLeaf prepared)
    {
        if (published && prepared.Launch()) return true;
        prepared.AbortBeforeStart();
        return false;
    }

    private async Task<bool> DrainAttemptLeavesAsync(
        ConnectionTeardownDeadline deadline)
    {
        Task[] pending;
        lock (_sync)
            pending = _attemptLeaves.PendingNonRootTasks();
        if (pending.Length == 0) return true;
        if (deadline.Remaining == TimeSpan.Zero) return false;
        Task all = Task.WhenAll(pending);
        try
        {
            await all.WaitAsync(deadline.Token).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
            when (deadline.Token.IsCancellationRequested)
        {
            if (!all.IsCompleted) RetainQuarantinedTeardownTask(all);
            return false;
        }
        catch
        {
            _ = all.Exception;
            return true;
        }
    }

    private enum AttemptLeaf
    {
        RootRunOne,
        PreRouteMaintenance,
        TransportOpen,
        JournalBootstrap,
        ReceiveLoop,
        SessionSync,
        HeartbeatLoop,
        Retransmit,
        RecoveryCarrier,
        RecoveryTerminal,
        Close,
        Dispose,
    }

    private sealed class AttemptLeafRegistry
    {
        private readonly PreparedAttemptLeaf?[] _slots =
            new PreparedAttemptLeaf[12];

        internal bool TryPublish(
            AttemptLeaf slot,
            PreparedAttemptLeaf prepared,
            object holder)
        {
            int index = (int)slot;
            PreparedAttemptLeaf? current = _slots[index];
            if (current is not null && !current.Task.IsCompleted) return false;
            if (current?.Task.IsFaulted == true) _ = current.Task.Exception;
            _slots[index] = prepared;
            _ = prepared.Task.ContinueWith(
                completed =>
                {
                    _ = completed.Exception;
                    lock (holder)
                    {
                        if (ReferenceEquals(_slots[index], prepared))
                            _slots[index] = null;
                    }
                },
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            return true;
        }

        internal void AbortPrepared()
        {
            foreach (PreparedAttemptLeaf? leaf in _slots)
                leaf?.AbortBeforeStart();
        }

        internal Task[] PendingNonRootTasks() => _slots
            .Where((leaf, index) => index != (int)AttemptLeaf.RootRunOne &&
                leaf is not null && !leaf.Task.IsCompleted)
            .Select(leaf => leaf!.Task)
            .ToArray();

        internal Task? TaskFor(AttemptLeaf slot) =>
            _slots[(int)slot]?.Task;
    }

    private sealed class AttemptTeardownResources(
        CancellationToken serviceCancellationToken)
    {
        private IRbpConnectionCycle? _cycle;
        private readonly object _deadlineSync = new();
        private ConnectionTeardownDeadline? _deadline;
        internal IRbpConnectionCycle? Cycle => Volatile.Read(ref _cycle);
        internal CancellationToken ServiceCancellationToken { get; } =
            serviceCancellationToken;
        internal long? RouteAuthorityEpoch { get; set; }
        internal ConnectionCycleContext? Context { get; set; }
        internal bool ShutdownRequested { get; set; }
        internal bool JournalGenerationActivated { get; set; }
        internal Exception? SecondaryFault { get; set; }
        internal long? DeadlineTimestamp
        {
            get
            {
                lock (_deadlineSync) return _deadline?.DeadlineTimestamp;
            }
        }

        internal ConnectionTeardownDeadline GetOrCreateDeadline(
            TimeSpan budget)
        {
            lock (_deadlineSync)
                return _deadline ??= new ConnectionTeardownDeadline(budget);
        }

        internal void PublishCycle(IRbpConnectionCycle cycle)
        {
            ArgumentNullException.ThrowIfNull(cycle);
            if (Interlocked.CompareExchange(ref _cycle, cycle, null) is not null)
                throw new InvalidOperationException(
                    "An attempt cycle cannot be replaced after publication.");
        }
    }

    private sealed class PreparedAttemptLeaf
    {
        private readonly Func<Task> _start;
        private readonly TaskCompletionSource _release = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private int _state;
        private int _launchState;

        internal PreparedAttemptLeaf(
            AttemptLeafRegistry registry,
            long attemptGeneration,
            Func<Task> start)
        {
            Registry = registry;
            AttemptGeneration = attemptGeneration;
            _start = start ?? throw new ArgumentNullException(nameof(start));
            Task = RunAsync();
        }

        internal Task Task { get; }
        internal AttemptLeafRegistry Registry { get; }
        internal long AttemptGeneration { get; }

        internal bool TryReserveStart() =>
            Interlocked.CompareExchange(ref _state, 1, 0) == 0;

        internal bool Launch()
        {
            if (Volatile.Read(ref _state) != 1 ||
                Interlocked.CompareExchange(ref _launchState, 1, 0) != 0)
                return false;
            _release.TrySetResult();
            return true;
        }

        internal bool AbortBeforeStart()
        {
            int observed;
            do
            {
                observed = Volatile.Read(ref _state);
                if (observed == 2 || Volatile.Read(ref _launchState) != 0)
                    return false;
            }
            while (Interlocked.CompareExchange(ref _state, 2, observed) !=
                   observed);
            _release.TrySetCanceled();
            return true;
        }

        private async Task RunAsync()
        {
            await _release.Task.ConfigureAwait(false);
            await _start().ConfigureAwait(false);
        }
    }

    private void CompleteAttemptNormally()
    {
        lock (_sync)
        {
            if (_attemptStopState is 4 or 6) return;
            _attemptStopState = 5;
            _teardownResult.TrySetResult(new RbpCoordinatorTeardownResult(
                RbpCoordinatorTeardownDisposition.NormalStopped));
        }
    }

    private static RbpCoordinatorException
        NonDrainingConnectionAuthority(Exception? secondary = null) =>
        new(
            RbpCoordinatorErrorCode.NonDrainingConnectionAuthority,
            "An RBP connection-owned handler ignored cancellation and did " +
            "not drain before the close deadline. Connection authority is " +
            "poisoned; restart the Bridge process before reconnecting.",
            secondary);

    private static bool IsNonDrainingConnectionAuthority(
        Exception exception)
    {
        if (exception is RbpCoordinatorException coordinator &&
            coordinator.ErrorCode ==
            RbpCoordinatorErrorCode.NonDrainingConnectionAuthority)
            return true;
        if (exception is AggregateException aggregate)
            return aggregate.InnerExceptions.Any(
                IsNonDrainingConnectionAuthority);
        return exception.InnerException is { } inner &&
            IsNonDrainingConnectionAuthority(inner);
    }

    private static bool IsInboundJournalUnavailable(Exception exception)
    {
        if (exception is RbpCoordinatorException coordinator &&
            coordinator.ErrorCode ==
            RbpCoordinatorErrorCode.InboundJournalUnavailable)
            return true;
        if (exception is AggregateException aggregate)
            return aggregate.InnerExceptions.Any(
                IsInboundJournalUnavailable);
        return exception.InnerException is { } inner &&
            IsInboundJournalUnavailable(inner);
    }

    private sealed class ConnectionTeardownDeadline : IDisposable
    {
        private readonly TimeSpan _budget;
        private readonly long _started = Stopwatch.GetTimestamp();
        private readonly CancellationTokenSource _cancellation = new();

        internal ConnectionTeardownDeadline(TimeSpan budget)
        {
            if (budget <= TimeSpan.Zero)
                throw new ArgumentOutOfRangeException(nameof(budget));
            _budget = budget;
            DeadlineTimestamp = checked(_started +
                (long)Math.Ceiling(
                    budget.TotalSeconds * Stopwatch.Frequency));
            _cancellation.CancelAfter(budget);
        }

        internal CancellationToken Token => _cancellation.Token;
        internal long DeadlineTimestamp { get; }

        internal static long TimestampAfter(TimeSpan budget) =>
            checked(Stopwatch.GetTimestamp() +
                (long)Math.Ceiling(
                    budget.TotalSeconds * Stopwatch.Frequency));

        internal TimeSpan Remaining
        {
            get
            {
                TimeSpan remaining = _budget -
                    Stopwatch.GetElapsedTime(_started);
                return remaining > TimeSpan.Zero
                    ? remaining
                    : TimeSpan.Zero;
            }
        }

        public void Dispose() => _cancellation.Dispose();
    }

    private void RetainQuarantinedTeardownTask(Task task)
    {
        lock (_sync) _quarantinedTeardownTasks.Add(task);
        _ = task.ContinueWith(
            completed =>
            {
                _ = completed.Exception;
                lock (_sync) _quarantinedTeardownTasks.Remove(completed);
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

}

internal enum RbpCoordinatorTeardownDisposition
{
    NormalStopped,
    EmergencyMustExit,
}

internal sealed record RbpCoordinatorTeardownResult(
    RbpCoordinatorTeardownDisposition Disposition,
    long? DeadlineTimestamp = null)
{
    internal TimeSpan Remaining(TimeSpan fallback)
    {
        if (DeadlineTimestamp is not { } deadline) return fallback;
        long ticks = deadline - Stopwatch.GetTimestamp();
        if (ticks <= 0) return TimeSpan.Zero;
        double seconds = (double)ticks / Stopwatch.Frequency;
        return TimeSpan.FromSeconds(seconds);
    }
}
