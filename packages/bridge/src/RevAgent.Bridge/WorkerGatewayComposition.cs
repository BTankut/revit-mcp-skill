using System.Text.Json;
using RevAgent.Bridge.AddinLoopback;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Enrollment;
using RevAgent.Bridge.Bootstrap.Updates;
using RevAgent.Bridge.Enrollment;
using RevAgent.Bridge.Gateway.Connection;
using RevAgent.Bridge.Gateway.Dispatch;
using RevAgent.Bridge.Gateway.Protocol;
using RevAgent.Bridge.Gateway.Storage;
using RevAgent.Bridge.Runtime;

namespace RevAgent.Bridge;

/// <summary>
/// The add-in dispatch surface the worker composes the RBP data plane over:
/// the session router that owns add-in transport leases plus the authority
/// that maps an <c>rsid</c> onto one of its sessions.
/// </summary>
internal sealed record WorkerAddinDispatchSurface(
    AddinSessionRouter SessionRouter,
    IRbpSessionRouteResolver SessionRoutes,
    IRbpFreshResumeProofContextReader? FreshResumeProofReader = null);

/// <summary>
/// Everything the worker host needs before it may own an RBP connection.
/// </summary>
/// <remarks>
/// <see cref="DispatchSurface"/> is the deliberate optional: a worker whose
/// add-in routing surface has not been constructed yet composes a coordinator
/// whose inbound handoff stays the fail-closed default, so inbound data is
/// refused and never acknowledged rather than half-handled.
/// </remarks>
internal sealed record WorkerGatewayServices(
    IRbpConnectionCycleFactory CycleFactory,
    RbpJournalStore Journal,
    IRbpLocalSessionCatalog SessionCatalog,
    RbpConnectionCoordinatorOptions Options,
    WorkerAddinDispatchSurface? DispatchSurface = null,
    IRbpCoordinatorClock? Clock = null,
    IRbpRandomSource? Random = null,
    Action<string>? OnDispatchDiagnostic = null,
    Func<RbpConnectionFailureObservation, ValueTask>?
        OnConnectionFailureObservation = null,
    RbpArtifactCarrierProducer? CarrierProducer = null,
    Func<RbpLifecycleTimeoutObservation, ValueTask>?
        OnLifecycleTimeoutObservation = null,
    Func<RbpDocumentContextObservation, ValueTask>?
        OnDocumentContextObservation = null,
    RbpConformanceOmittedOriginObservation? OmittedOriginObservation = null,
    IRbpRecoveryCarrierObservationSink? RecoveryCarrierObservationSink = null,
    IRbpReconnectObservationSink? ReconnectObservationSink = null,
    Func<CancellationToken, Task>? BeforeRecoveryTerminalWrite = null,
    Func<CancellationToken, Task>? AfterRecoveryCarrierWriteBeforeAck = null,
    BridgeUpdateReportStore? UpdateReports = null);

/// <summary>
/// Composes the production RBP data plane inside the worker host: the journal
/// store, the routed invocation channel, the invocation dispatcher, and the
/// P3-T5 inbound journal handoff, all bound into one
/// <see cref="RbpConnectionCoordinator"/> at construction.
/// </summary>
/// <remarks>
/// <para>
/// When the full dispatch surface is present, the coordinator receives
/// <see cref="RbpInvocationJournalHandoff"/> as its inbound handoff — the
/// production replacement for the fail-closed default — and a dispatcher whose
/// RES-10 busy probe reads the same local-session catalog that feeds the
/// heartbeat <c>revit_status</c> block. When the surface is missing, the
/// coordinator is constructed without an inbound handoff so
/// <see cref="FailClosedRbpInboundDataJournal"/> engages: inbound data cannot
/// be acknowledged, and the Gateway keeps retransmitting instead of losing an
/// invocation into a worker that cannot dispatch it.
/// </para>
/// <para>
/// Opening the journal store requires the injected resume-token protector.
/// P3-T8 owns the production protector; until it lands, the worker cannot open
/// the store and therefore cannot construct a coordinator at all, which is the
/// same fail-closed posture by absence.
/// </para>
/// </remarks>
internal static class WorkerGatewayComposition
{
    /// <summary>
    /// Opens the worker's journal store at the canonical state-root path.
    /// </summary>
    internal static RbpJournalStore OpenJournal(
        BridgeInstallLayout layout,
        IRbpResumeTokenProtector resumeTokenProtector,
        RbpJournalOpenOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(resumeTokenProtector);
        return RbpJournalStore.Open(
            layout.JournalPath,
            resumeTokenProtector,
            options,
            WorkerRecoveryPayloadProtector.CreateProduction());
    }

    /// <summary>
    /// The production enrollment-state seam (P3-T8): the handshake reads
    /// the DPAPI credential store through
    /// <see cref="CredentialStoreEnrollmentStateProvider"/>. When the
    /// store capability itself cannot be constructed, the hard-coded
    /// always-refuse <see cref="EnrollmentRequiredStateProvider"/> remains
    /// the explicit fallback, so the fail-closed refusal never depends on
    /// a store that does not exist.
    /// </summary>
    internal static IRbpEnrollmentStateProvider CreateEnrollmentStateProvider(
        BridgeInstallLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        return CreateEnrollmentStateProvider(
            () => BridgeDeviceCredentialProvider.CreateProduction(layout));
    }

    internal static IRbpEnrollmentStateProvider CreateEnrollmentStateProvider(
        Func<IBridgeDeviceCredentialProvider> credentialProviderFactory)
    {
        ArgumentNullException.ThrowIfNull(credentialProviderFactory);
        try
        {
            return new CredentialStoreEnrollmentStateProvider(
                credentialProviderFactory());
        }
        catch (BridgeCredentialStoreException)
        {
            return new EnrollmentRequiredStateProvider();
        }
    }

    /// <summary>
    /// Composes the worker's connection-cycle factory. WSS is always the
    /// primary RBP binding; when — and only when — the provisioned
    /// transport capabilities include
    /// <see cref="RbpTransportCapabilities.StreamableHttp"/>, the factory
    /// is wrapped so one fallback-eligible WSS opening failure may try the
    /// Streamable HTTP/SSE binding within the same attempt (RES-25,
    /// O1 Section 4.1). An unset or empty flag fail-closes to the current
    /// WSS-only behavior, and the fallback factory itself still refuses to
    /// open unless the capability is both provisioned and declared in
    /// <c>hello</c>.
    /// </summary>
    internal static IRbpConnectionCycleFactory CreateConnectionCycleFactory(
        IRbpEnrollmentStateProvider enrollmentState,
        IReadOnlyCollection<string>? provisionedTransportCapabilities = null)
    {
        ArgumentNullException.ThrowIfNull(enrollmentState);
        var primary = new WssRbpConnectionCycleFactory(
            new RbpGatewayHandshakeClient(
                enrollmentState,
                new WssGatewayBinding()));
        if (provisionedTransportCapabilities is null ||
            !provisionedTransportCapabilities.Contains(
                RbpTransportCapabilities.StreamableHttp,
                StringComparer.Ordinal))
        {
            return primary;
        }

        return new RbpPrimaryFallbackConnectionCycleFactory(
            primary,
            new StreamableHttpRbpConnectionCycleFactory(
                enrollmentState,
                provisionedTransportCapabilities),
            provisionedTransportCapabilities);
    }

    internal static RbpConnectionCoordinator CreateCoordinator(
        WorkerGatewayServices services)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(services.CycleFactory);
        ArgumentNullException.ThrowIfNull(services.Journal);
        ArgumentNullException.ThrowIfNull(services.SessionCatalog);
        ArgumentNullException.ThrowIfNull(services.Options);

        if (services.DispatchSurface is not { } surface)
        {
            // Preconditions missing: no add-in dispatch surface exists yet.
            // Passing no inbound handoff keeps the coordinator's fail-closed
            // default engaged, so no inbound data envelope is journaled or
            // acknowledged. The dispatcher below is unreachable behind that
            // refusal; its channel exists only because a coordinator without
            // any dispatch authority is deliberately unrepresentable, and it
            // reports a truthful known-not-dispatched outcome if ever reached.
            return new RbpConnectionCoordinator(
                services.CycleFactory,
                services.Journal,
                services.SessionCatalog,
                services.Options,
                new RbpInvocationDispatcher(
                    services.Journal,
                    UnroutableInvocationChannel.Instance,
                    new RbpInFlightGate()),
                inboundJournal: null,
                services.Clock,
                services.Random,
                onConnectionFailureObservation:
                    services.OnConnectionFailureObservation,
                onLifecycleTimeoutObservation:
                    services.OnLifecycleTimeoutObservation,
                recoveryCarrierObservationSink:
                    services.RecoveryCarrierObservationSink,
                reconnectObservationSink: services.ReconnectObservationSink,
                beforeRecoveryTerminalWrite:
                    services.BeforeRecoveryTerminalWrite,
                afterRecoveryCarrierWriteBeforeAck:
                    services.AfterRecoveryCarrierWriteBeforeAck,
                updateReports: services.UpdateReports);
        }

        if (services.Options.SessionRouteBindingAuthority is
                IRbpSessionRouteResolver bindingResolver &&
            !ReferenceEquals(bindingResolver, surface.SessionRoutes))
        {
            throw new ArgumentException(
                "The registration route-binding authority must be the same " +
                "authority used by routed invocation dispatch.",
                nameof(services));
        }

        var channel = new RbpRoutedInvocationChannel(
            surface.SessionRouter,
            surface.SessionRoutes);
        var dispatcher = new RbpInvocationDispatcher(
            services.Journal,
            channel,
            new RbpInFlightGate(),
            new LocalCatalogRevitBusyProbe(
                services.SessionCatalog,
                surface.SessionRoutes),
            carrierProducer: services.CarrierProducer,
            omittedOriginObservation: services.OmittedOriginObservation);

        // The P3-T7 standing document-context watcher polls the add-in's
        // cached get_document_context through the same routed channel the
        // dispatch path uses, so its polls can never reach a different
        // Revit session than the rsid they report on. Sessions that do not
        // advertise doc_context_cached_v1 are never polled.
        var docContextWatcher = new RbpDocContextWatcher(
            channel,
            services.Clock,
            freshResumeProofReader: surface.FreshResumeProofReader ??
                surface.SessionRoutes as IRbpFreshResumeProofContextReader,
            onObservation: services.OnDocumentContextObservation);

        // Section 11 execution shares the routed channel and journal with the
        // single-invocation dispatcher; only the capability seam is its own.
        // Without this wiring an inbound batch envelope was journaled,
        // acknowledged, and then dropped by the data pump.
        var batchCoordinator = new RbpBatchCoordinator(
            services.Journal,
            channel,
            new RbpRoutedBatchCapabilitySource(
                services.Journal,
                surface.SessionRouter,
                surface.SessionRoutes,
                RevAgent.Contracts.AddinLoopback.AddinFrameLimits
                    .MaxResponsePayloadBytes));
        return new RbpConnectionCoordinator(
            services.CycleFactory,
            services.Journal,
            services.SessionCatalog,
            services.Options,
            dispatcher,
            RbpInvocationJournalHandoff.Instance,
            services.Clock,
            services.Random,
            docContextWatcher,
            batchCoordinator,
            services.OnDispatchDiagnostic,
            services.OnConnectionFailureObservation,
            services.CarrierProducer,
            services.OnLifecycleTimeoutObservation,
            services.OnDocumentContextObservation,
            omittedOriginObservation: services.OmittedOriginObservation,
            recoveryCarrierObservationSink:
                services.RecoveryCarrierObservationSink,
            reconnectObservationSink: services.ReconnectObservationSink,
            beforeRecoveryTerminalWrite:
                services.BeforeRecoveryTerminalWrite,
            afterRecoveryCarrierWriteBeforeAck:
                services.AfterRecoveryCarrierWriteBeforeAck,
            updateReports: services.UpdateReports);
    }

    /// <summary>
    /// The channel used when the worker has no add-in dispatch surface. The
    /// fail-closed inbound handoff refuses every data envelope before dispatch
    /// can start, so this channel never runs in practice; if it ever did, it
    /// reports a provable non-dispatch rather than throwing an outcome the
    /// journal would have to treat as possibly executed.
    /// </summary>
    private sealed class UnroutableInvocationChannel : IRbpInvocationChannel
    {
        internal static UnroutableInvocationChannel Instance { get; } = new();

        private UnroutableInvocationChannel()
        {
        }

        public Task<RbpAddinOutcome> InvokeAsync(
            string rsid,
            AddinCall call,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(
                new RbpAddinOutcome(
                    RbpAddinOutcomeKind.KnownNotDispatched,
                    default,
                    [],
                    RequestBytes: 0,
                    ResponseBytes: 0,
                    FaultClass: "addin_unreachable",
                    Message:
                        "The worker has no add-in dispatch surface; nothing " +
                        "was sent to the add-in."));
        }
    }

    /// <summary>
    /// RES-10 production probe: reads the competing active-task evidence from
    /// the same local <c>mcp_status</c>-fed catalog snapshot that populates
    /// the heartbeat <c>revit_status</c> block.
    /// </summary>
    /// <remarks>
    /// The <c>rsid</c> is translated to a local session key through the same
    /// route authority the dispatch path uses, so busy evidence can never be
    /// read from a different Revit session than the one that failed. The
    /// dispatcher only calls this after a transport-shaped failure — never as
    /// an invoke-path preflight.
    /// </remarks>
    private sealed class LocalCatalogRevitBusyProbe : IRbpRevitBusyProbe
    {
        private static readonly string[] TaskNameProperties =
        {
            "task_name",
            "taskName",
            "name",
        };

        private readonly IRbpLocalSessionCatalog _catalog;
        private readonly IRbpSessionRouteResolver _routes;

        internal LocalCatalogRevitBusyProbe(
            IRbpLocalSessionCatalog catalog,
            IRbpSessionRouteResolver routes)
        {
            _catalog = catalog;
            _routes = routes;
        }

        public async Task<string?> FindActiveTaskAsync(
            string rsid,
            CancellationToken cancellationToken)
        {
            if (_routes.Resolve(rsid) is not { } handle)
            {
                return null;
            }

            IReadOnlyList<RbpLocalSessionSnapshot> sessions =
                await _catalog.ReadAsync(cancellationToken)
                    .ConfigureAwait(false);
            RbpLocalSessionSnapshot? local = sessions.FirstOrDefault(
                session => string.Equals(
                    session.LocalSessionKey,
                    handle.LocalSessionKey,
                    StringComparison.Ordinal));
            return local is null
                ? null
                : DescribeActiveTask(local.RevitStatus);
        }

        private static string? DescribeActiveTask(JsonElement revitStatus)
        {
            if (revitStatus.ValueKind != JsonValueKind.Object ||
                !revitStatus.TryGetProperty(
                    "active_task",
                    out JsonElement activeTask))
            {
                return null;
            }

            string? described = activeTask.ValueKind switch
            {
                JsonValueKind.String => activeTask.GetString(),
                JsonValueKind.Object => ReadTaskName(activeTask),
                _ => null,
            };
            return described is { Length: > 0 } value
                ? value.Length <= 128 ? value : value[..128]
                : null;
        }

        private static string? ReadTaskName(JsonElement activeTask)
        {
            foreach (string property in TaskNameProperties)
            {
                if (activeTask.TryGetProperty(
                        property,
                        out JsonElement value) &&
                    value.ValueKind == JsonValueKind.String &&
                    value.GetString() is { Length: > 0 } text)
                {
                    return text;
                }
            }

            return "an unnamed active task";
        }
    }
}
